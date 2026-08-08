// 주소 두 개로 요금을 뽑는다 — 오더 등록 화면이 하던 계산을 서버에서도 할 수 있게 모았다.
//
// 화면에서는 프런트가 카카오 내비로 거리를 구해 /orders/fare-preview에 distance_km을 넘긴다.
// 챗봇·상담원 도우미는 브라우저가 없으므로 같은 일을 서버에서 해야 한다:
//   주소 → 좌표(lib/geocode.js) → 경로 거리(카카오 내비) → 구간요금표(lib/branchPolicy.js)
//
// 요금표는 지사별로 다르다. 지사를 못 넘기면 calculateFareWithFerry가 기본 요금표를 쓰는
// 지사로 폴백하므로(branchPolicy의 findFallbackFareBranch), 결과에 어느 지사 기준인지 함께 담아
// 호출부가 "참고 금액"임을 밝힐 수 있게 한다.
const { geocodeAddress } = require('./geocode');
const { calculateFareWithFerry } = require('./branchPolicy');

const DIRECTIONS_URL = 'https://apis-navi.kakaomobility.com/v1/directions';

// 카카오 내비 경로 거리(미터)와 도선 구간 포함 여부.
// routes/kakao.js의 /directions 프록시와 같은 API를 쓰되, 챗봇에는 경유지가 없어 단순 경로만 본다.
async function routeDistance(origin, destination) {
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key) return null;
  const qs = new URLSearchParams({
    origin: `${origin.lon},${origin.lat}`,
    destination: `${destination.lon},${destination.lat}`,
    priority: 'RECOMMEND',
  });
  try {
    const res = await fetch(`${DIRECTIONS_URL}?${qs.toString()}`, {
      headers: { Authorization: 'KakaoAK ' + key },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const route = data.routes && data.routes[0];
    if (!route || route.result_code !== 0) return null;

    // 도선(페리) 구간은 요금 체계가 달라 branchPolicy가 따로 계산한다 — 여기서는 포함 여부만 본다.
    const hasFerryLeg = (route.sections || []).some((s) => (s.roads || []).some((r) => /페리|훼리|선박|도선/.test(String(r.name || ''))));
    return {
      distanceKm: Number(route.summary.distance) / 1000,
      durationMin: Math.round(Number(route.summary.duration || 0) / 60),
      tollFare: route.summary.fare ? route.summary.fare.toll : null,
      hasFerryLeg,
    };
  } catch (e) {
    console.error('경로 거리 조회 실패:', e.message);
    return null;
  }
}

// 출발지·도착지 주소 문자열로 예상 요금을 계산한다.
// 실패는 던지지 않고 { ok:false, reason }으로 돌려준다 — 호출부(챗봇 초안)에서 조용히 넘겨야 한다.
async function quoteFareByAddress({ originAddress, destinationAddress, branchId, vehicleType, reservedDate, reservedTime }) {
  const from = String(originAddress || '').trim();
  const to = String(destinationAddress || '').trim();
  if (!from || !to) return { ok: false, reason: 'missing_address' };

  const [origin, destination] = await Promise.all([
    geocodeAddress(from).catch(() => null),
    geocodeAddress(to).catch(() => null),
  ]);
  if (!origin) return { ok: false, reason: 'origin_geocode_failed' };
  if (!destination) return { ok: false, reason: 'destination_geocode_failed' };

  const route = await routeDistance(origin, destination);
  if (!route) return { ok: false, reason: 'route_failed' };

  const fare = await calculateFareWithFerry(branchId || null, route.distanceKm, {
    vehicleType: vehicleType || '',
    originAddress: origin.address || from,
    hasFerryLeg: route.hasFerryLeg,
    reservedDate: reservedDate || null,
    reservedTime: reservedTime || null,
  }).catch((e) => {
    console.error('요금 계산 실패:', e.message);
    return null;
  });

  // 요금표가 꺼져 있거나 등록되지 않은 지사면 enabled=false로 온다 — 금액을 지어내지 않는다.
  // 합계 필드는 totalFare(=fare)다. 도선이 붙으면 base.fare 위에 선박요금이 더해진 값이다.
  const total = fare && (fare.totalFare != null ? fare.totalFare : fare.fare);
  if (!fare || fare.enabled === false || total == null) {
    return { ok: false, reason: 'fare_table_disabled', distanceKm: route.distanceKm };
  }

  return {
    ok: true,
    distanceKm: route.distanceKm,
    durationMin: route.durationMin,
    hasFerryLeg: route.hasFerryLeg,
    total,
    fare,
    origin: { address: origin.address || from, query: from },
    destination: { address: destination.address || to, query: to },
  };
}

module.exports = { quoteFareByAddress, routeDistance };
