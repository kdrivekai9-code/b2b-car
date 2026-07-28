// 카카오 로컬 API(주소/장소명 검색) 프록시 — REST API 키가 브라우저에 노출되지 않도록 서버에서만 호출한다.
// 주소 검색(도로명+지번)과 상호명(키워드) 검색을 함께 호출해 병합한다.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { generateJson } = require('../lib/vertexAi');

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

function firstNonEmptyString() {
  for (let i = 0; i < arguments.length; i += 1) {
    const v = arguments[i];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function hasFerryKeyword(text) {
  return /(선박|여객선|카페리|도선|ferry|페리|항구|선착장|여객터미널|항\b)/i.test(String(text || ''));
}

function looksLikePortName(name) {
  return /(항|항구|선착장|여객터미널|터미널)/.test(String(name || ''));
}

function parsePortsFromText(text) {
  const s = String(text || '').trim();
  if (!s) return { fromPort: '', toPort: '' };
  const m1 = s.match(/(.+?)\s*(?:에서|출발)\s*(.+?)\s*(?:까지|도착|행)/);
  if (m1) return { fromPort: m1[1].trim(), toPort: m1[2].trim() };
  const m2 = s.match(/(.+?)\s*(?:->|→|[-~])\s*(.+)/);
  if (m2) return { fromPort: m2[1].trim(), toPort: m2[2].trim() };
  return { fromPort: '', toPort: '' };
}

function extractFerryLegs(route) {
  const legs = [];
  const seen = new Set();

  (route.sections || []).forEach((section) => {
    const guides = Array.isArray(section.guides) ? section.guides : [];
    guides.forEach((guide) => {
      const summary = firstNonEmptyString(
        guide.name,
        guide.guidance,
        guide.road_name,
        guide.instruction,
        guide.message,
        guide.text,
      );

      const parsed = parsePortsFromText(summary);
      const fromPort = firstNonEmptyString(
        guide.from_name,
        guide.from,
        guide.origin_name,
        guide.start_name,
        parsed.fromPort,
      );
      const toPort = firstNonEmptyString(
        guide.to_name,
        guide.to,
        guide.destination_name,
        guide.end_name,
        parsed.toPort,
      );

      const candidateText = [summary, fromPort, toPort].filter(Boolean).join(' ');
      if (!hasFerryKeyword(candidateText)) return;

      const key = [fromPort, toPort, summary].join('|');
      if (seen.has(key)) return;
      seen.add(key);

      legs.push({
        fromPort: fromPort || null,
        toPort: toPort || null,
        summary: summary || null,
        distance: Number.isFinite(guide.distance) ? guide.distance : null,
        duration: Number.isFinite(guide.duration) ? guide.duration : null,
      });
    });

    // guides에서 못 건진 경우 roads 이름을 보조 후보로 사용한다.
    (section.roads || []).forEach((road) => {
      const roadName = firstNonEmptyString(road.name, road.road_name);
      if (!hasFerryKeyword(roadName)) return;
      const parsed = parsePortsFromText(roadName);
      if (!looksLikePortName(parsed.fromPort) && !looksLikePortName(parsed.toPort)) return;
      const key = [parsed.fromPort, parsed.toPort, roadName].join('|');
      if (seen.has(key)) return;
      seen.add(key);
      legs.push({
        fromPort: parsed.fromPort || null,
        toPort: parsed.toPort || null,
        summary: roadName || null,
        distance: Number.isFinite(road.distance) ? road.distance : null,
        duration: Number.isFinite(road.duration) ? road.duration : null,
      });
    });
  });

  return legs;
}

const ADDRESS_CORRECTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    officialName: { type: 'STRING' },
    searchQueries: { type: 'ARRAY', items: { type: 'STRING' } },
    isCorrection: { type: 'BOOLEAN' },
  },
  required: ['searchQueries', 'isCorrection'],
};

const ADDRESS_CORRECTION_INSTRUCTION = `너는 한국 주소/상호명(장소명) 검색 오타 보정기다.
사용자가 입력한 검색어로 지도 검색을 했지만 결과가 없었다. 오타나 잘못된 표기가 있었을 가능성이 있다.
1) 가장 가능성 높은 정확한 공식 명칭(officialName), 2) 다시 검색해볼 검색어 후보 목록(searchQueries)을 만들어라.
searchQueries는 검색 성공 가능성이 높은 순서대로 최대 4개만 넣어라 — 첫 후보에 공식 명칭을, 이후에는 띄어쓰기 보정형·대표 상호명·검색 친화 축약형을 넣어라.
정확한 공식 명칭을 추정하기 어렵더라도 검색 성공 가능성이 높은 후보는 최대한 채워라.
오타 교정이 필요 없어 보이면 isCorrection을 false로 하고 searchQueries에 원문만 넣어라.
확신이 낮으면 officialName은 비워두고, 설명 없이 JSON만 반환해라.`;

// 카카오 검색이 0건일 때만 호출 — Gemini에게 오타 교정 후보를 물어 재검색 시도한다(Redis 캐시나
// 헤드리스 폴백 없이 Gemini 보정 한 단계만 추가한 축소 버전).
async function correctSearchQueryWithGemini(query) {
  try {
    const result = await generateJson(ADDRESS_CORRECTION_INSTRUCTION, query, ADDRESS_CORRECTION_SCHEMA);
    const searchQueries = Array.isArray(result.searchQueries)
      ? result.searchQueries.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 4)
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

// 카카오모빌리티 자동차 길찾기(유료 API, 별도 키/계약 필요) — 실제 도로 경로/거리/톨비 조회
router.get('/directions', asyncHandler(async (req, res) => {
  const { origin, destination, waypoints, priority, avoid, departure_time } = req.query;
  if (!origin || !destination) return res.status(400).json({ error: 'origin, destination가 필요합니다.' });
  if (!process.env.KAKAO_REST_API_KEY) return res.status(500).json({ error: 'KAKAO_REST_API_KEY가 설정되어 있지 않습니다.' });

  function toPoint(str) {
    const [x, y] = str.split(',').map(Number);
    return { x, y };
  }

  const allowedPriority = ['RECOMMEND', 'TIME', 'DISTANCE'];
  const allowedAvoid = ['toll', 'motorway', 'ferries', 'schoolzone', 'uturn'];
  const avoidList = avoid ? avoid.split(',').filter((a) => allowedAvoid.includes(a)) : [];

  function kstNowCompact() {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date()).reduce((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
    return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}`;
  }

  function normalizeDepartureTime(raw) {
    const compact = String(raw || '').replace(/\D/g, '');
    if (!/^\d{12}$/.test(compact)) return null;
    return compact;
  }

  const normalizedDeparture = normalizeDepartureTime(departure_time);
  const waypointList = waypoints ? waypoints.split('|').filter(Boolean) : [];
  const canUseFuture = !!(normalizedDeparture && normalizedDeparture >= kstNowCompact() && waypointList.length <= 5);

  let kakaoRes;
  if (canUseFuture) {
    const qs = new URLSearchParams();
    qs.set('origin', origin);
    qs.set('destination', destination);
    qs.set('departure_time', normalizedDeparture);
    qs.set('priority', allowedPriority.includes(priority) ? priority : 'RECOMMEND');
    if (waypointList.length) qs.set('waypoints', waypointList.join('|'));
    if (avoidList.length) qs.set('avoid', avoidList.join('|'));
    kakaoRes = await fetch('https://apis-navi.kakaomobility.com/v1/future/directions?' + qs.toString(), {
      method: 'GET',
      headers: {
        Authorization: 'KakaoAK ' + process.env.KAKAO_REST_API_KEY,
        'Content-Type': 'application/json',
      },
    });
  } else {
    const body = {
      origin: toPoint(origin),
      destination: toPoint(destination),
      waypoints: waypointList.map(toPoint),
      priority: allowedPriority.includes(priority) ? priority : 'RECOMMEND',
    };
    if (avoidList.length) body.avoid = avoidList;

    kakaoRes = await fetch('https://apis-navi.kakaomobility.com/v1/waypoints/directions', {
      method: 'POST',
      headers: {
        Authorization: 'KakaoAK ' + process.env.KAKAO_REST_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  if (!kakaoRes.ok) {
    const text = await kakaoRes.text();
    return res.status(502).json({ error: '길찾기 요청 실패', detail: text });
  }
  const data = await kakaoRes.json();
  const route = data.routes && data.routes[0];
  if (!route || route.result_code !== 0) {
    return res.status(422).json({ error: '경로를 찾을 수 없습니다.', detail: route && route.result_msg });
  }

  const path = [];
  (route.sections || []).forEach((section) => {
    (section.roads || []).forEach((road) => {
      const v = road.vertexes || [];
      for (let i = 0; i + 1 < v.length; i += 2) {
        path.push([v[i + 1], v[i]]); // vertexes는 [경도, 위도] 순서 -> [위도, 경도]로 변환
      }
    });
  });

  const ferryLegs = extractFerryLegs(route);

  res.json({
    totalDistance: route.summary.distance, // meters
    totalDuration: route.summary.duration, // seconds
    tollFare: route.summary.fare ? route.summary.fare.toll : null,
    segments: (route.sections || []).map((s) => ({ distance: s.distance, duration: s.duration })),
    hasFerryLeg: ferryLegs.length > 0,
    ferryLegs,
    path,
    usedFuture: canUseFuture,
    departureTimeApplied: canUseFuture ? normalizedDeparture : null,
  });
}));

module.exports = router;
