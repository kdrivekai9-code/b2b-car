// 카카오 로컬 API(주소/장소명 검색) 프록시 — REST API 키가 브라우저에 노출되지 않도록 서버에서만 호출한다.
// 주소 검색(도로명+지번)과 상호명(키워드) 검색을 함께 호출해 병합한다.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { generateJson } = require('../lib/vertexAi');
const { abbreviateSido, formatSigugun } = require('../lib/kakaoRegion');
const { getKakaoDirections } = require('../lib/routeFareSearch');

const router = express.Router();
router.use(requireAuth);

async function kakaoGet(path, query) {
  const url = 'https://dapi.kakao.com/v2/local/' + path + '?size=8&query=' + encodeURIComponent(query);
  const res = await fetch(url, { headers: { Authorization: 'KakaoAK ' + process.env.KAKAO_REST_API_KEY } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.documents || [];
}

async function fetchMergedDocuments(query) {
  const [addressDocs, keywordDocs] = await Promise.all([
    kakaoGet('search/address.json', query),
    kakaoGet('search/keyword.json', query),
  ]);

  const addressResults = addressDocs.map((d) => ({
    type: 'address',
    road_address: d.road_address ? d.road_address.address_name : null,
    jibun_address: d.address ? d.address.address_name : (d.address_name || null),
    lat: d.y,
    lon: d.x,
  }));

  const placeResults = keywordDocs.map((d) => ({
    type: 'place',
    place_name: d.place_name,
    road_address: d.road_address_name || null,
    jibun_address: d.address_name || null,
    lat: d.y,
    lon: d.x,
  }));

  return [...addressResults, ...placeResults];
}

// 콜마너 오더접수 API가 요구하는 시도(약어)/시구군/동 분리값은 lib/kakaoRegion.js에
// 모아뒀다 — 서버에서 경유지 viaList를 만들 때(lib/callmaner.js)도 같은 규칙이 필요해서
// 공용 모듈로 분리했다. 카카오 주소검색/키워드검색은 검색 방식에 따라 region depth 필드
// 유무가 달라 일관되지 않으므로, 주소 선택 시 이미 알고 있는 위경도로 좌표->행정구역 API를
// 한 번 더 호출해 항상 같은 방식으로 얻는다("콜마너 외부연동 인터페이스 정의서"
// "바. 공통주의사항" 2/3 참조).

const ADDRESS_CORRECTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    officialName: { type: 'STRING' },
    searchQueries: { type: 'ARRAY', items: { type: 'STRING' } },
    isCorrection: { type: 'BOOLEAN' },
  },
  required: ['searchQueries', 'isCorrection'],
};

// 후보를 여러 개 주면(예전엔 최대 4개) 클라이언트가 하나씩 순서대로 재검색을 시도하느라 왕복이
// 그만큼 늘어나 챗봇 대기시간이 길어졌다 — 가장 가능성 높은 후보 딱 1개만 받고, 그것도 틀리면
// 더 시도하지 않고 사용자에게 상호명/주소를 다시 확인해달라고 요청한다(클라이언트 쪽 폴백 메시지).
const ADDRESS_CORRECTION_INSTRUCTION = `너는 한국 주소/상호명(장소명) 검색 오타 보정기다.
사용자가 입력한 검색어로 지도 검색을 했지만 결과가 없었다. 오타나 잘못된 표기가 있었을 가능성이 있다.
가장 가능성 높은 정확한 공식 명칭(officialName)을 추정하고, 그 명칭으로 다시 검색해볼 검색어를
searchQueries에 정확히 1개만 넣어라(절대 여러 개 넣지 말 것).
정확한 공식 명칭을 추정하기 어렵더라도 검색 성공 가능성이 가장 높은 후보 하나는 반드시 채워라.
오타 교정이 필요 없어 보이면 isCorrection을 false로 하고 searchQueries에 원문만 1개 넣어라.
확신이 낮으면 officialName은 비워두고, 설명 없이 JSON만 반환해라.`;

// 카카오 검색이 0건일 때만 호출 — Gemini에게 오타 교정 후보를 물어 재검색 시도한다(Redis 캐시나
// 헤드리스 폴백 없이 Gemini 보정 한 단계만 추가한 축소 버전).
async function correctSearchQueryWithGemini(query) {
  try {
    const result = await generateJson(ADDRESS_CORRECTION_INSTRUCTION, query, ADDRESS_CORRECTION_SCHEMA, { op: 'address_correct' });
    const searchQueries = Array.isArray(result.searchQueries)
      ? result.searchQueries.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 1)
      : [];
    if (!searchQueries.length) return null;
    return searchQueries;
  } catch (e) {
    console.error('Gemini 주소 검색어 보정 실패:', e.message);
    return null;
  }
}

router.get('/search', asyncHandler(async (req, res) => {
  const query = (req.query.q || '').trim();
  const mode = String(req.query.mode || 'fallback'); // fallback | plain | correction
  if (!query) return res.json({ documents: [] });
  if (!process.env.KAKAO_REST_API_KEY) return res.status(500).json({ error: 'KAKAO_REST_API_KEY가 설정되어 있지 않습니다.' });

  if (mode === 'plain') {
    const documents = await fetchMergedDocuments(query);
    return res.json({ documents, originalQuery: query, triedFallback: false, correctedQuery: null, candidates: [] });
  }

  if (mode === 'correction') {
    const candidates = (await correctSearchQueryWithGemini(query)) || [];
    const correctedQuery = candidates.find((c) => c && c !== query) || null;
    return res.json({ documents: [], originalQuery: query, triedFallback: true, correctedQuery, candidates });
  }

  let documents = await fetchMergedDocuments(query);
  let triedFallback = false;
  let correctedQuery = null;

  if (!documents.length) {
    triedFallback = true;
    const candidates = await correctSearchQueryWithGemini(query);
    if (candidates) {
      for (const candidate of candidates) {
        if (candidate === query) continue;
        const candidateDocuments = await fetchMergedDocuments(candidate);
        if (candidateDocuments.length) {
          documents = candidateDocuments;
          correctedQuery = candidate;
          break;
        }
      }
    }
  }

  // originalQuery/triedFallback/correctedQuery는 AI 챗봇이 "OOO 검색결과가 없습니다 -> OOO로
  // 다시 검색하겠습니다" 안내 말풍선을 보여줄 수 있도록 내려주는 것 — 일반 오더 등록 화면의
  // 수동 검색에서는 사용하지 않는다.
  res.json({ documents, originalQuery: query, triedFallback, correctedQuery, candidates: [] });
}));

// 좌표 -> 시도/시구군/동 (콜마너 오더접수 연동용). 법정동(B) 결과를 우선 사용한다.
router.get('/region', asyncHandler(async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat, lng가 필요합니다.' });
  if (!process.env.KAKAO_REST_API_KEY) return res.status(500).json({ error: 'KAKAO_REST_API_KEY가 설정되어 있지 않습니다.' });

  const url = `https://dapi.kakao.com/v2/local/geo/coord2regioncode.json?x=${lng}&y=${lat}`;
  const kakaoRes = await fetch(url, { headers: { Authorization: 'KakaoAK ' + process.env.KAKAO_REST_API_KEY } });
  if (!kakaoRes.ok) return res.status(502).json({ error: '행정구역 조회 실패' });
  const data = await kakaoRes.json();
  const docs = data.documents || [];
  const region = docs.find((d) => d.region_type === 'B') || docs[0];
  if (!region) return res.json({ sido: '', sigugun: '', dong: '' });

  res.json({
    sido: abbreviateSido(region.region_1depth_name),
    sigugun: formatSigugun(region.region_2depth_name),
    dong: String(region.region_3depth_name || '').trim(),
  });
}));

// 카카오모빌리티 자동차 길찾기(유료 API, 별도 키/계약 필요) — 실제 도로 경로/거리/톨비 조회
router.get('/directions', asyncHandler(async (req, res) => {
  const { origin, destination, waypoints, priority, avoid, departure_time } = req.query;
  const result = await getKakaoDirections({
    origin,
    destination,
    waypoints: waypoints ? String(waypoints).split('|').filter(Boolean) : [],
    priority,
    avoid,
    departureTime: departure_time,
  });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error, detail: result.detail });
  }
  const { ok, ...payload } = result;
  res.json(payload);
}));

module.exports = router;
