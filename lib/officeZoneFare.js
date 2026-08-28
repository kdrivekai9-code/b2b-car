// 지점 구간요금 — 거점(지점)과 지역 사이의 고정 요금을 찾는다.
//
// 계약이 "강남지점 ↔ 서울 강남구 = 20,000원"처럼 표로 맺어지는 경우가 많다. 그 표가 있으면
// 거리 구간표보다 먼저 본다(사용자 확정) — 거리로 환산하면 계약서와 금액이 어긋난다.
const db = require('../db');
const { abbreviateSido, formatSigugun } = require('./kakaoRegion');

// 오더의 출발/도착이 "그 지점"인지 판정하는 반경.
//
// 주소 문자열 비교는 쓰지 않는다. "서울 강남구 언주로 30"과 "서울특별시 강남구 언주로 30"이
// 다른 곳이 되고, 건물 이름을 덧붙이면 또 달라진다. 좌표로 본다.
//
// 0.4km: 대형 물류센터·차고지 부지가 그 정도 크기이고(정문과 후문이 다른 좌표로 잡힌다),
// 그보다 넓히면 옆 건물이 같은 지점으로 묶인다.
const OFFICE_MATCH_KM = 0.4;

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// 표기를 orders와 같은 규칙으로 맞춘다(lib/kakaoRegion.js).
// 엑셀에는 "서울특별시"라고 적히지만 orders에는 "서울"로 저장된다 — 안 맞추면 매칭이 통째로 빗나간다.
function normSido(raw) {
  const s = String(raw || '').trim();
  return s ? abbreviateSido(s) : '';
}
function normSigugun(raw) {
  return formatSigugun(raw);
}

// 등록한 지역이 오더의 시군구와 같은 곳인가.
//
// 정확히 같으면 당연히 맞다. 그런데 orders는 "성남시분당구"처럼 시와 구를 붙여 저장하는데
// (formatSigugun) 계약표는 "성남시"까지만 적는 경우가 흔하다 — 그때도 맞다고 봐야 한다.
// 반대로 "분당구"만 적힌 표가 "성남시분당구"에 걸리면 안 되므로 접두사일 때만 인정한다.
function zoneMatches(zoneSigugun, orderSigugun) {
  const z = normSigugun(zoneSigugun);
  const o = normSigugun(orderSigugun);
  if (!z || !o) return false;
  if (z === o) return true;
  return o.startsWith(z);
}

async function listOffices(groupId) {
  if (!groupId) return [];
  return db.all(
    'SELECT * FROM group_branch_offices WHERE group_id = ? ORDER BY seq, id',
    [groupId]
  ).catch((e) => {
    // 마이그레이션 전이면 표가 없다 — 지점 요금만 못 쓸 뿐 거리 구간표로 그대로 낸다.
    if (!e || e.code !== '42P01') console.error('지점 조회 실패:', e.message);
    return [];
  });
}

async function listZoneFares(officeId) {
  return db.all(
    'SELECT * FROM group_office_zone_fares WHERE office_id = ? ORDER BY sido, sigugun',
    [officeId]
  ).catch(() => []);
}

// 좌표가 이 지점과 같은 곳인가. 가장 가까운 지점 하나를 돌려준다.
function nearestOffice(offices, lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  let best = null;
  for (const o of offices) {
    const ola = Number(o.lat);
    const olo = Number(o.lon);
    if (!Number.isFinite(ola) || !Number.isFinite(olo)) continue;
    const km = haversineKm([la, lo], [ola, olo]);
    if (km <= OFFICE_MATCH_KM && (!best || km < best.km)) best = { office: o, km };
  }
  return best;
}

// 이 오더에 적용할 지점 구간요금.
//
// 규칙(사용자 지시): 출발지 **또는** 도착지가 지점이면, 그 지점과 반대편 지역의 요금을 쓴다.
// 둘 다 지점이면 출발지 쪽을 쓴다 — 어느 쪽이든 계약표에 있는 금액이므로 한쪽으로 정해두면
// 같은 오더가 볼 때마다 다른 금액이 되는 일이 없다.
//
// 못 찾으면 null. 호출부는 그때 예전처럼 거리 구간표로 낸다.
async function findZoneFare(groupId, options = {}) {
  const offices = await listOffices(groupId);
  if (!offices.length) return null;

  const origin = nearestOffice(offices, options.originLat, options.originLon);
  const destination = nearestOffice(offices, options.destinationLat, options.destinationLon);

  // 출발지가 지점이면 도착지 지역을, 도착지가 지점이면 출발지 지역을 본다.
  const picked = origin
    ? { office: origin.office, side: 'origin', sido: options.destinationSido, sigugun: options.destinationSigugun }
    : (destination
      ? { office: destination.office, side: 'destination', sido: options.originSido, sigugun: options.originSigugun }
      : null);
  if (!picked) return null;

  const sido = normSido(picked.sido);
  const sigugun = normSigugun(picked.sigugun);
  if (!sido) return null;

  const rows = await listZoneFares(picked.office.id);

  // 시군구가 비어 오는 시도가 있다 — 세종은 하위 시군구가 없는 단층제라 우리 지오코더가
  // sigugun을 항상 빈 값으로 준다(실측: 세종시청·보람동·조치원읍·정부청사 모두 ''). 그래서
  // 시군구로 찾으면 세종 오더는 어떤 계약표에도 안 걸린다.
  //
  // 그 시도에 등록된 지역이 **하나뿐일 때만** 그것을 쓴다. 둘 이상이면 무엇을 고를지 알 수
  // 없으므로 붙이지 않는다 — 계약 금액을 찍는 자리라 추측하면 안 된다.
  if (!sigugun) {
    const inSido = rows.filter((r) => normSido(r.sido) === sido);
    if (inSido.length !== 1) return null;
    const only = inSido[0];
    return {
      fare: Number(only.fare) || 0,
      distanceKm: only.distance_km == null ? null : Number(only.distance_km),
      officeId: picked.office.id,
      officeName: picked.office.name,
      matchedSide: picked.side,
      zone: `${only.sido} ${only.sigugun}`,
    };
  }
  // 정확히 같은 지역을 먼저, 없으면 접두사로. 접두사가 여럿이면 더 긴 쪽(더 구체적인 쪽)이 맞다.
  const exact = rows.find((r) => normSido(r.sido) === sido && normSigugun(r.sigugun) === sigugun);
  const prefix = rows
    .filter((r) => normSido(r.sido) === sido && zoneMatches(r.sigugun, sigugun))
    .sort((a, b) => normSigugun(b.sigugun).length - normSigugun(a.sigugun).length)[0];
  const hit = exact || prefix;
  if (!hit) return null;

  return {
    fare: Number(hit.fare) || 0,
    distanceKm: hit.distance_km == null ? null : Number(hit.distance_km),
    officeId: picked.office.id,
    officeName: picked.office.name,
    // 어느 쪽이 지점이었는지 — 화면·안내가 "왜 이 금액인지" 밝힐 수 있어야 한다.
    matchedSide: picked.side,
    zone: `${hit.sido} ${hit.sigugun}`,
  };
}

module.exports = {
  OFFICE_MATCH_KM,
  haversineKm,
  normSido,
  normSigugun,
  zoneMatches,
  nearestOffice,
  listOffices,
  listZoneFares,
  findZoneFare,
};
