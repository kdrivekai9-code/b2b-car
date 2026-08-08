// 주소 후보 검색과 선택 — 웹 접수 화면의 "주소 확정" 단계를 서버에서도 쓸 수 있게 모은 모듈.
// 접수 대화 통합의 두 번째 조각(1번은 lib/intakeFields.js).
//
// 왜 필요한가: 웹은 후보가 여럿이면 "1. …  2. …"로 보여주고 고객이 고르게 한다
// (public/js/ai-intake-flow.js의 choose_address_candidate 단계). 카카오는 서버가 첫 결과를
// 조용히 골라 써서, "사당역"이 엉뚱한 지점으로 확정돼도 기사가 출발한 뒤에야 드러난다.
// 같은 후보 목록·같은 선택 판정을 서버에서 쓰면 카카오도 물어볼 수 있다.
//
// 선택 판정(matchCandidateChoice)은 브라우저 구현과 규칙이 같아야 한다 —
// scripts/check-address-candidates.js가 같은 입력으로 양쪽을 대조한다.
const { lookupRegion } = require('./kakaoRegion');
const { buildQueryVariants } = require('./geocode');

const KAKAO_LOCAL_BASE = 'https://dapi.kakao.com/v2/local/';
const DEFAULT_LIMIT = 3;

async function kakaoLocalSearch(path, query) {
  if (!process.env.KAKAO_REST_API_KEY) return [];
  try {
    const url = `${KAKAO_LOCAL_BASE}${path}?size=5&query=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { Authorization: 'KakaoAK ' + process.env.KAKAO_REST_API_KEY } });
    if (!res.ok) return [];
    const data = await res.json();
    return data.documents || [];
  } catch (e) {
    console.error('주소 후보 검색 실패:', e.message);
    return [];
  }
}

function toCandidate(doc, kind) {
  const lat = Number(doc.y);
  const lon = Number(doc.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const address = kind === 'address'
    ? (doc.road_address ? doc.road_address.address_name : doc.address_name)
    : (doc.road_address_name || doc.address_name);
  if (!address) return null;
  const placeName = kind === 'keyword' ? (doc.place_name || null) : null;
  return {
    // label은 고객에게 보여줄 한 줄 — 상호명이 있으면 함께 보여줘야 어느 지점인지 구분된다
    // ("사당역" 후보가 여러 개일 때 주소만 보여주면 고를 근거가 없다).
    label: placeName ? `${placeName} (${address})` : address,
    address,
    placeName,
    lat,
    lon,
    matchedBy: kind,
  };
}

// 같은 곳이 주소검색과 키워드검색에 중복으로 나온다 — 좌표를 소수 4자리로 끊어 같으면 하나로 본다
// (약 11m 이내). 주소 문자열만으로 비교하면 표기 차이 때문에 중복이 남는다.
function dedupe(candidates) {
  const seen = new Set();
  const out = [];
  candidates.forEach((c) => {
    const key = `${c.lat.toFixed(4)},${c.lon.toFixed(4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  });
  return out;
}

// 후보 목록. 주소검색을 먼저 쓰고(정확도 우선) 키워드검색을 뒤에 붙인다 — lib/geocode.js와 같은 순서.
async function searchAddressCandidates(query, options = {}) {
  const limit = options.limit || DEFAULT_LIMIT;
  const variants = buildQueryVariants(query);
  if (!variants.length) return [];

  const collected = [];
  for (const v of variants) {
    const docs = await kakaoLocalSearch('search/address.json', v);
    docs.forEach((d) => { const c = toCandidate(d, 'address'); if (c) collected.push(c); });
    if (collected.length) break; // 주소로 잡혔으면 키워드까지 섞지 않는다(정확도 우선)
  }
  if (!collected.length) {
    for (const v of variants) {
      const docs = await kakaoLocalSearch('search/keyword.json', v);
      docs.forEach((d) => { const c = toCandidate(d, 'keyword'); if (c) collected.push(c); });
      if (collected.length) break;
    }
  }

  const unique = dedupe(collected).slice(0, limit);
  // 행정구역은 콜마너 접수에 필수라 채워서 돌려준다(선택 후 다시 조회하지 않도록).
  await Promise.all(unique.map(async (c) => {
    const region = await lookupRegion(c.lat, c.lon);
    if (region) {
      c.sido = region.sido;
      c.sigugun = region.sigugun;
      c.dong = region.dong;
    }
  }));
  return unique;
}

// 물어봐야 하는 상황인지 — 서로 다른 후보가 둘 이상일 때만 묻는다. 하나뿐이면 물어볼 게 없고,
// 고객이 이미 전체 주소를 말했으면(도로명+건물번호) 후보가 여럿이어도 첫 결과가 맞다.
const FULL_ADDRESS_RE = /[가-힣]+(로|길)\s?\d+(-\d+)?/;

function needsDisambiguation(query, candidates) {
  if (!Array.isArray(candidates) || candidates.length < 2) return false;
  if (FULL_ADDRESS_RE.test(String(query || ''))) return false;
  return true;
}

// 고객에게 보여줄 후보 목록 문구.
function buildCandidateListText(label, candidates) {
  const lines = candidates.map((c, i) => `${i + 1}. ${c.label}`);
  return `${label}가 여러 곳으로 검색됩니다. 번호로 골라주세요.\n${lines.join('\n')}`;
}

// 고객 답변에서 후보를 고른다 — 브라우저(public/js/ai-intake-flow.js matchCandidateChoice)와
// 같은 규칙이다. 번호("1", "1번", "첫"), 순서 표현("둘/두번째"), 그리고 후보 이름의 부분 일치.
function matchCandidateChoice(text, candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const t = String(text || '').trim();
  if (/^1\s*(번|\.|\))?$/.test(t) || /^첫/.test(t)) return list[0] || null;
  if (/^2\s*(번|\.|\))?$/.test(t) || /^(둘|두\s?번)/.test(t)) return list[1] || null;
  if (/^3\s*(번|\.|\))?$/.test(t) || /^(셋|세\s?번)/.test(t)) return list[2] || null;
  for (let i = 0; i < list.length; i += 1) {
    if (t.length >= 2 && list[i].label && list[i].label.indexOf(t) !== -1) return list[i];
  }
  return null;
}

function getClarifyText(candidates) {
  const count = Array.isArray(candidates) ? candidates.length : 0;
  return count >= 3 ? '1번, 2번, 3번 중에서 골라주세요.' : '1번 또는 2번으로 답해주세요.';
}

module.exports = {
  searchAddressCandidates,
  needsDisambiguation,
  buildCandidateListText,
  matchCandidateChoice,
  getClarifyText,
};
