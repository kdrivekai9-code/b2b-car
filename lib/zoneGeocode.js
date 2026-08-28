// 지역(시/군/구)의 기준 좌표를 찾는다 — 지점 구간요금의 거리 자동계산에 쓴다.
//
// 기준점은 사용자 지정이다: **시는 시청, 군은 군청, 구는 구청.**
// 지역은 넓어서 "어디를 그 지역으로 볼 것인가"를 정해두지 않으면 등록할 때마다 거리가 달라진다.
// 청사 좌표는 누구나 같은 곳을 가리키므로 재현이 된다.
const { abbreviateSido } = require('./kakaoRegion');

const SEARCH_URL = 'https://dapi.kakao.com/v2/local/search/keyword.json';

// 시군구 이름 끝 글자로 청사 이름을 만든다.
//   강남구 → 강남구청 / 수원시 → 수원시청 / 양평군 → 양평군청
// 이미 '청'으로 끝나면 그대로 둔다(사용자가 "수원시청"이라 적은 경우).
function officeNameOf(sigugun) {
  const s = String(sigugun || '').trim();
  if (!s) return '';
  if (s.endsWith('청')) return s;
  if (/[시군구]$/.test(s)) return `${s}청`;
  // 끝 글자가 시/군/구가 아니면(예: "세종") 그대로 두고 검색어에 맡긴다.
  return s;
}

// "성남시분당구"처럼 붙어 있는 표기는 검색이 잘 안 된다 — 청사는 구 단위로 존재하므로
// 마지막 구를 기준으로 삼는다(성남시분당구 → 분당구청).
function splitSigugun(sigugun) {
  const s = String(sigugun || '').trim();
  const m = /^(.*[시군])(.+구)$/.exec(s);
  return m ? { city: m[1], district: m[2] } : { city: null, district: null };
}

async function searchOne(query) {
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key) return null;
  const url = `${SEARCH_URL}?query=${encodeURIComponent(query)}&size=5`;
  try {
    const res = await fetch(url, { headers: { Authorization: 'KakaoAK ' + key } });
    if (!res.ok) return null;
    const data = await res.json();
    const docs = data.documents || [];
    if (!docs.length) return null;
    // 이름에 '청'이 들어간 결과를 먼저 고른다 — "강남구"로 검색하면 지하철역·상호가 먼저 온다.
    const doc = docs.find((d) => /청$|청\s/.test(String(d.place_name || ''))) || docs[0];
    return {
      name: doc.place_name,
      address: doc.road_address_name || doc.address_name || '',
      lat: Number(doc.y),
      lon: Number(doc.x),
    };
  } catch (e) {
    console.error('지역 기준점 검색 실패:', e.message);
    return null;
  }
}

// 시도 + 시군구 → 청사 좌표.
//
// 검색어를 여러 번 바꿔 시도한다. 같은 이름의 구가 여러 시에 있어서(예: 중구는 서울·부산·대구…)
// 시도를 붙이지 않으면 엉뚱한 곳이 잡힌다 — 시도를 붙인 검색을 항상 먼저 한다.
async function lookupZoneCenter(sido, sigugun) {
  const sd = String(sido || '').trim();
  const sg = String(sigugun || '').trim();
  if (!sg) return null;

  const { city, district } = splitSigugun(sg);
  const queries = [];
  if (sd) queries.push(`${sd} ${officeNameOf(sg)}`);
  queries.push(officeNameOf(sg));
  // "성남시분당구" → "성남시 분당구청"
  if (city && district) {
    if (sd) queries.push(`${sd} ${city} ${officeNameOf(district)}`);
    queries.push(`${city} ${officeNameOf(district)}`);
  }
  if (sd) queries.push(`${sd} ${sg}`);

  for (const q of queries) {
    const hit = await searchOne(q);
    if (hit && Number.isFinite(hit.lat) && Number.isFinite(hit.lon)) {
      return { ...hit, query: q, sido: abbreviateSido(sd) || sd, sigugun: sg };
    }
  }
  return null;
}

// 거리는 소수점 한 자리까지만 쓴다(사용자 지정). 요금 계산에 쓰는 값이 아니라 안내용이라
// 그 이상 정밀하게 보여줄 이유가 없고, 화면·엑셀·DB가 서로 다른 자릿수를 보이면 안 된다.
function roundKm(km) {
  // 빈 문자열은 Number('')가 0이라 "0km"로 저장된다 — 엑셀의 빈 km 칸이 전부 0km가 되고,
  // 화면에서는 "계산 실패(-)"와 구분이 안 된다. 값이 없으면 없는 것으로 둔다.
  if (km === null || km === undefined || String(km).trim() === '') return null;
  const n = Number(km);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 10) / 10;
}

module.exports = { officeNameOf, splitSigugun, lookupZoneCenter, roundKm };
