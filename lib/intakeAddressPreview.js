// 접수 확인 문구에 붙일 "실제 주소검색 결과".
//
// 웹 접수 화면은 사용자가 주소검색 결과를 골라 확정하지만(routes/kakao.js 프록시), 카카오
// 상담톡은 고객이 "판교역"처럼 짧게만 말한다. 그대로 되읊으면 우리가 어디로 이해했는지 고객이
// 알 수 없고, 엉뚱한 곳으로 기사가 가고 나서야 드러난다. 접수 전에 확인시킬 수 있는 유일한
// 지점이 이 문구다.
//
// 같은 지오코딩을 자동 등록 경로(lib/kakaoIntakeService.js)도 쓰므로 결과가 어긋나지 않는다.
const { geocodeAddress } = require('./geocode');

// 고객이 말한 표현과 검색 결과가 사실상 같은지 — 같으면 굳이 괄호로 덧붙이지 않는다.
// ("경기도 군포시 농심로59번길 4"를 말했는데 같은 주소를 괄호로 또 보여주면 소음이다.)
//
// ⚠ 포함 관계로 판단하면 안 된다 — "판교역"은 "경기 성남시 분당구 **판교역**로 160"에 그대로
// 들어 있어서, 정작 보여줘야 할 때 같은 주소로 착각한다(실제로 그렇게 빠졌다). 시도 표기만
// 통일한 뒤 정확히 일치할 때만 생략한다("경기도 군포시…" vs "경기 군포시…").
const SIDO_LONG_TO_SHORT = {
  서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천',
  광주광역시: '광주', 대전광역시: '대전', 울산광역시: '울산', 세종특별자치시: '세종',
  경기도: '경기', 강원도: '강원', 강원특별자치도: '강원', 충청북도: '충북', 충청남도: '충남',
  전라북도: '전북', 전북특별자치도: '전북', 전라남도: '전남', 경상북도: '경북', 경상남도: '경남',
  제주특별자치도: '제주',
};

function normalizeForCompare(value) {
  let v = String(value || '').trim();
  Object.entries(SIDO_LONG_TO_SHORT).forEach(([long, short]) => {
    if (v.startsWith(long)) v = short + v.slice(long.length);
  });
  return v.replace(/[\s,()]/g, '');
}

function looksSame(query, resolved) {
  const a = normalizeForCompare(query);
  const b = normalizeForCompare(resolved);
  if (!a || !b) return false;
  return a === b;
}

async function previewOne(query) {
  const raw = String(query || '').trim();
  if (!raw) return null;
  const geo = await geocodeAddress(raw).catch(() => null);
  if (!geo || !geo.address) return { query: raw, resolved: null, found: false };
  return {
    query: raw,
    resolved: looksSame(raw, geo.address) ? null : geo.address,
    placeName: geo.placeName || null,
    found: true,
  };
}

// 출발/도착/경유를 한 번에. 실패해도 null 자리로 두고 호출부는 원문만 보여준다 — 주소검색이
// 안 됐다고 접수 대화가 멈추면 안 된다. 경유지는 현재 한 번에 하나만 다룬다(parsed.waypoints[0]).
async function previewIntakeAddresses(parsed) {
  if (!parsed) return { origin: null, destination: null, waypoint: null };
  const waypoint = (parsed.waypoints || [])[0];
  const [origin, destination, waypointPreview] = await Promise.all([
    previewOne(parsed.origin && parsed.origin.address),
    previewOne(parsed.destination && parsed.destination.address),
    previewOne(waypoint && waypoint.address),
  ]);
  return { origin, destination, waypoint: waypointPreview };
}

// 문구에 넣을 한 줄: "판교역 (경기 성남시 분당구 판교역로 160)".
// 검색이 안 되면 그 사실을 알려준다 — 상담원이 손으로 확인해야 할 지점이기 때문이다.
function formatAddressLine(preview, fallback) {
  if (!preview) return fallback || '-';
  if (!preview.found) return `${preview.query} (주소 확인 필요)`;
  return preview.resolved ? `${preview.query} (${preview.resolved})` : preview.query;
}

module.exports = { previewIntakeAddresses, formatAddressLine, looksSame };
