// 경로탐색(거리·소요시간·톨비) + 요금검색(구간요금)을 법인별로 켜고 끌 수 있게 하는 공용
// 모듈. 웹 AI 챗봇(public/js/ai-intake.js가 부르는 /orders/fare-preview 경로와는 별개로,
// 이 파일은 "브라우저 없이 서버가 직접" 경로/요금을 구할 때 쓴다)과 카카오톡 상담
// (routes/kakaoConsult.js) 둘 다 이 파일의 searchRouteAndFare 하나만 부른다 — 판단 로직이
// 채널마다 갈리지 않도록 이번 세션 내내 지켜온 원칙과 같다.
//
// getKakaoDirections는 원래 routes/kakao.js의 GET /directions 핸들러 안에만 있던 로직을
// 그대로 옮긴 것이다(동작 변화 없음, 순수 추출) — 그 라우트는 이제 이 함수를 호출하고 HTTP
// 응답으로만 변환한다. lib/premiumUpgrade.js도 같은 API를 직접 fetch하고 있었는데, 페리
// 구간 처리가 빠진 축약판이었다 — 이번엔 정확도를 위해 손대지 않는다(범위 밖).
const db = require('../db');
const { calculateFareWithFerry } = require('./branchPolicy');

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
        guide.name, guide.guidance, guide.road_name, guide.instruction, guide.message, guide.text,
      );
      const parsed = parsePortsFromText(summary);
      const fromPort = firstNonEmptyString(guide.from_name, guide.from, guide.origin_name, guide.start_name, parsed.fromPort);
      const toPort = firstNonEmptyString(guide.to_name, guide.to, guide.destination_name, guide.end_name, parsed.toPort);

      const candidateText = [summary, fromPort, toPort].filter(Boolean).join(' ');
      if (!hasFerryKeyword(candidateText)) return;

      const key = [fromPort, toPort, summary].join('|');
      if (seen.has(key)) return;
      seen.add(key);

      legs.push({
        fromPort: fromPort || null, toPort: toPort || null, summary: summary || null,
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
        fromPort: parsed.fromPort || null, toPort: parsed.toPort || null, summary: roadName || null,
        distance: Number.isFinite(road.distance) ? road.distance : null,
        duration: Number.isFinite(road.duration) ? road.duration : null,
      });
    });
  });

  return legs;
}

// 차량 페리 항로(예: 완도-제주)에서는 카카오가 진입/진출 지점을 각각 별도 guide로 표시한다
// (관측된 guidance: "페리항로 진입"/"페리항로 진출"). 진출 guide의 distance/duration이 그 두
// 지점 사이 실제 페리 항해 구간 값과 정확히 일치한다(대전→서귀포 성산 실측 경로에서 진입 이전
// 구간 296.4km/219분 + 페리 구간 97.2km/91분 + 진출 이후 구간 39.5km/49분 = 총 433.2km/359분
// 으로, 카카오가 응답하는 총 거리·시간과 정확히 합산됨을 확인). 이를 이용해 "출발지→승선항",
// "항해", "하선항→도착지" 세 구간으로 나눠 각각 실제 거리/소요시간을 계산할 수 있다.
function extractFerrySegments(route) {
  const flatGuides = [];
  (route.sections || []).forEach((section) => {
    (section.guides || []).forEach((guide) => flatGuides.push(guide));
  });

  let enterIdx = -1;
  let exitIdx = -1;
  for (let i = 0; i < flatGuides.length; i += 1) {
    const guidance = String(flatGuides[i].guidance || '');
    if (enterIdx === -1 && /페리항로\s*진입/.test(guidance)) {
      enterIdx = i;
    } else if (enterIdx !== -1 && exitIdx === -1 && /페리항로\s*진출/.test(guidance)) {
      exitIdx = i;
      break;
    }
  }
  if (enterIdx === -1 || exitIdx === -1) return null;

  const sumDist = (arr) => arr.reduce((s, g) => s + (Number.isFinite(g.distance) ? g.distance : 0), 0);
  const sumDur = (arr) => arr.reduce((s, g) => s + (Number.isFinite(g.duration) ? g.duration : 0), 0);
  const beforeGuides = flatGuides.slice(1, enterIdx + 1);
  const afterGuides = flatGuides.slice(exitIdx + 1);
  const ferryGuide = flatGuides[exitIdx];

  return {
    fromPort: flatGuides[enterIdx].name || null,
    toPort: flatGuides[exitIdx].name || null,
    beforeDistanceM: sumDist(beforeGuides),
    beforeDurationS: sumDur(beforeGuides),
    ferryDistanceM: Number.isFinite(ferryGuide.distance) ? ferryGuide.distance : null,
    ferryDurationS: Number.isFinite(ferryGuide.duration) ? ferryGuide.duration : null,
    afterDistanceM: sumDist(afterGuides),
    afterDurationS: sumDur(afterGuides),
  };
}

function kstNowCompact() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
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

const ALLOWED_PRIORITY = ['RECOMMEND', 'TIME', 'DISTANCE'];
const ALLOWED_AVOID = ['toll', 'motorway', 'ferries', 'schoolzone', 'uturn'];

// origin/destination: "경도,위도" 문자열(카카오 API 규격 그대로). waypoints: 같은 형식 배열.
// routes/kakao.js GET /directions 핸들러의 원래 로직 그대로 — 실패 시 throw하지 않고
// { ok:false, status, error, detail }를 돌려준다(호출부가 HTTP 응답이든 챗봇 메시지든
// 알아서 처리하도록).
async function getKakaoDirections({ origin, destination, waypoints, priority, avoid, departureTime, _avoidDropped }) {
  if (!origin || !destination) return { ok: false, status: 400, error: 'origin, destination가 필요합니다.' };
  if (!process.env.KAKAO_REST_API_KEY) return { ok: false, status: 500, error: 'KAKAO_REST_API_KEY가 설정되어 있지 않습니다.' };

  function toPoint(str) {
    const [x, y] = str.split(',').map(Number);
    return { x, y };
  }

  const avoidList = avoid ? String(avoid).split(',').filter((a) => ALLOWED_AVOID.includes(a)) : [];
  const normalizedDeparture = normalizeDepartureTime(departureTime);
  const waypointList = waypoints ? (Array.isArray(waypoints) ? waypoints : String(waypoints).split('|')).filter(Boolean) : [];
  const canUseFuture = !!(normalizedDeparture && normalizedDeparture >= kstNowCompact() && waypointList.length <= 5);

  let kakaoRes;
  try {
    if (canUseFuture) {
      const qs = new URLSearchParams();
      qs.set('origin', origin);
      qs.set('destination', destination);
      qs.set('departure_time', normalizedDeparture);
      qs.set('priority', ALLOWED_PRIORITY.includes(priority) ? priority : 'RECOMMEND');
      if (waypointList.length) qs.set('waypoints', waypointList.join('|'));
      if (avoidList.length) qs.set('avoid', avoidList.join('|'));
      kakaoRes = await fetch('https://apis-navi.kakaomobility.com/v1/future/directions?' + qs.toString(), {
        method: 'GET',
        headers: { Authorization: 'KakaoAK ' + process.env.KAKAO_REST_API_KEY, 'Content-Type': 'application/json' },
      });
    } else {
      const body = {
        origin: toPoint(origin),
        destination: toPoint(destination),
        waypoints: waypointList.map(toPoint),
        priority: ALLOWED_PRIORITY.includes(priority) ? priority : 'RECOMMEND',
      };
      if (avoidList.length) body.avoid = avoidList;
      kakaoRes = await fetch('https://apis-navi.kakaomobility.com/v1/waypoints/directions', {
        method: 'POST',
        headers: { Authorization: 'KakaoAK ' + process.env.KAKAO_REST_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
  } catch (e) {
    return { ok: false, status: 502, error: '길찾기 요청 실패', detail: e.message };
  }

  if (!kakaoRes.ok) {
    const text = await kakaoRes.text();
    return { ok: false, status: 502, error: '길찾기 요청 실패', detail: text };
  }
  const data = await kakaoRes.json();
  const route = data.routes && data.routes[0];
  if (!route || route.result_code !== 0) {
    // 회피조건 때문에 경로가 없는 경우가 있다 — 조건을 풀고 한 번 더 묻는다.
    //
    // 실사용(2026-08-25): 사당역→서귀포시청 탁송 요금문의가 계속 실패했다. 탁송은 경로탐색
    // 기본값이 "무료도로"라 avoid=toll이 붙는데(public/js/order-form.js
    // applyRoutePriorityDefaultForOrderType — 탁송은 톨비를 고객이 부담하는 경우가 많아서),
    // 제주는 톨게이트를 피하면 카카오가 경로를 못 준다(422). 같은 구간을 avoid 없이 물으면
    // 571.8km가 정상으로 나온다. 육지 장거리(부산·광주)는 무료도로로도 잘 나오므로,
    // 도선 구간이 끼는 경로에서만 생기는 일이다.
    //
    // 경로가 아예 없다고 답하는 것보다 유료도로 포함 경로라도 안내하는 편이 낫다. 대신 그
    // 사실을 avoidDropped로 올려 화면·챗봇이 밝히게 한다 — 탁송은 톨비를 고객이 내는 경우가
    // 많아서 조용히 바꾸면 안 되는 값이다.
    if (avoidList.length && !_avoidDropped) {
      const retried = await getKakaoDirections({
        origin, destination, waypoints, priority, departureTime, avoid: null, _avoidDropped: true,
      });
      if (retried.ok) return { ...retried, avoidDropped: avoidList.join(',') };
      return retried;
    }
    return { ok: false, status: 422, error: '경로를 찾을 수 없습니다.', detail: route && route.result_msg };
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
  const ferrySegments = ferryLegs.length > 0 ? extractFerrySegments(route) : null;

  return {
    ok: true,
    totalDistance: route.summary.distance,
    totalDuration: route.summary.duration,
    tollFare: route.summary.fare ? route.summary.fare.toll : null,
    segments: (route.sections || []).map((s) => ({ distance: s.distance, duration: s.duration })),
    hasFerryLeg: ferryLegs.length > 0,
    ferryLegs,
    ferrySegments,
    path,
    usedFuture: canUseFuture,
    departureTimeApplied: canUseFuture ? normalizedDeparture : null,
  };
}

const BOTH_ON = { route: true, fare: true };

// 법인 토글 조회 — 경로탐색과 요금검색을 각각 따로 켜고 끈다. 법인이 없거나(개인 요청 등)
// 마이그레이션 전 DB(컬럼 없음)면 기존 동작 유지 차원에서 둘 다 켜짐으로 본다.
async function getRouteFareSettings(groupId) {
  if (!groupId) return BOTH_ON;
  try {
    const row = await db.get(
      'SELECT route_search_enabled, fare_search_enabled FROM groups_tbl WHERE id = ?',
      [groupId]
    );
    if (!row) return BOTH_ON;
    return {
      route: row.route_search_enabled !== false,
      fare: row.fare_search_enabled !== false,
    };
  } catch (e) {
    console.error('법인 경로/요금 검색 설정 조회 실패(기본 켜짐으로 진행):', e.message);
    return BOTH_ON;
  }
}

// 웹 AI 챗봇·카카오톡 상담이 공유하는 단 하나의 진입점. 둘 다 꺼져 있으면 네트워크 호출
// 없이 즉시 반환한다(안 쓰는 법인 때문에 접수가 늦어지지 않도록 — 실사용 요청).
// onRoute를 주면 요금 계산을 기다리지 않고 경로 결과가 나오는 즉시 호출한다 — 요금은 경로
// 거리가 있어야 계산되므로 항상 경로가 먼저 끝난다(실사용 요청: 먼저 나온 결과부터 안내).
//
// 경로탐색만 끈 경우에도 요금검색이 켜져 있으면 길찾기 호출 자체는 해야 한다 — 요금이 거리
// 기반이라 거리 없이는 계산할 수 없다. 이때는 계산만 하고 경로 결과를 알리지 않는다(onRoute
// 미호출).
async function searchRouteAndFare({ groupId, branchId, originLat, originLon, destinationLat, destinationLon, vehicleType, waypoints, onRoute }) {
  const settings = await getRouteFareSettings(groupId);
  if (!settings.route && !settings.fare) return { enabled: false, routeEnabled: false, fareEnabled: false };

  if (originLat == null || originLon == null || destinationLat == null || destinationLon == null) {
    return { enabled: true, routeEnabled: settings.route, fareEnabled: settings.fare, ok: false, error: '좌표가 확인되지 않았습니다.' };
  }

  const directions = await getKakaoDirections({
    origin: `${originLon},${originLat}`,
    destination: `${destinationLon},${destinationLat}`,
    waypoints: (waypoints || []).map((w) => `${w.lon},${w.lat}`),
  });
  if (!directions.ok) {
    return { enabled: true, routeEnabled: settings.route, fareEnabled: settings.fare, ok: false, error: directions.error, detail: directions.detail };
  }

  const distanceKm = directions.totalDistance / 1000;
  if (settings.route && onRoute) {
    await Promise.resolve(onRoute({
      distanceKm,
      durationSec: directions.totalDuration,
      tollFare: directions.tollFare,
      hasFerryLeg: directions.hasFerryLeg,
    })).catch((e) => console.error('경로탐색 결과 안내 실패:', e.message));
  }

  const fareResult = settings.fare
    ? await calculateFareWithFerry(branchId, distanceKm, {
      vehicleType,
      hasFerryLeg: directions.hasFerryLeg,
      ferrySegments: directions.ferrySegments,
    }).catch((e) => {
      console.error('경로탐색 성공 후 요금계산 실패:', e.message);
      return { enabled: false };
    })
    : null;

  return {
    enabled: true,
    // settings의 fare(불리언)와 아래 fare(금액)는 이름이 겹친다 — 스프레드로 합치면 조용히
    // 덮여서 호출부가 "요금검색이 켜져 있었는지"를 알 수 없게 된다. 그래서 이름을 나눠 담는다.
    routeEnabled: settings.route,
    fareEnabled: settings.fare,
    ok: true,
    distanceKm,
    durationSec: directions.totalDuration,
    tollFare: directions.tollFare,
    hasFerryLeg: directions.hasFerryLeg,
    fare: fareResult && fareResult.enabled ? (fareResult.totalFare != null ? fareResult.totalFare : fareResult.fare) : null,
  };
}

module.exports = {
  getKakaoDirections,
  getRouteFareSettings,
  searchRouteAndFare,
};
