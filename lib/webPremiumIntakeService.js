// 웹 AI 접수 — 프리미엄(시간제)·일일기사 등록 실행. lib/kakaoIntakeService.js의
// createOrdersFromIntake(탁송 전용)와 같은 역할이지만 별도 함수다 — 필드 모양이 다르다
// (경유지가 여러 대가 아니라 하나뿐인 왕복/편도, 도착지 연락처 없음, 최종 목적지) — 억지로
// 같은 parsed 스키마에 끼워 맞추면 탁송 쪽까지 손대게 된다.
//
// 경유지(waypoints)는 다루지 않는다 — lib/intakeFields.js의 getDailyDriverFields 주석 참고.
// 경유지가 있는 요청은 호출부(lib/webIntakeTurn.js)가 이 서비스에 오기 전에 걸러낸다.
const { checkOperatingHours } = require('./branchPolicy');
const { createOrder } = require('./orderCreate');
const { registerOrderWithCallmaner } = require('./callmanerRegister');
const { maybeUpgradePremiumToDaily } = require('./premiumUpgrade');
const { splitIntake } = require('./orderSplit');
const { resolveReservation } = require('./kakaoIntakeService');
const { geocodeAddress } = require('./geocode');

// account: lib/webIntakeTurn.js의 accountFromUser와 같은 모양
// ({user_id, branch_id, requester_group_id, payment_method_id}) — 카카오 채널의 채널 매핑
// 계정도 같은 다섯 필드만 쓰므로(routes/kakaoConsult.js), 이 함수는 채널을 가리지 않는다.
// orderType: 'premium' | 'daily_driver'. sourceChannel: 'web'(기본) | 'kakao'.
async function createPremiumOrderFromIntake({ session, account, parsed, orderType, sourceChannel }) {
  // parsed.when은 탁송과 동일하게 "즉시 여부/원문"만 담은 미확정 값이다 — 등록 실행 시점에
  // resolveReservation으로 확정한다(카카오 insertOrder와 같은 순서, lib/kakaoIntakeService.js).
  const reservation = resolveReservation(parsed.when);

  const hours = await checkOperatingHours(account.branch_id, reservation.date, reservation.time).catch(() => ({ allowed: true }));
  if (hours && hours.allowed === false) return { ok: false, reason: 'operating_hours', detail: hours.reason };

  // 지오코딩도 등록 실행 시점에 한다(탁송의 geocodeBoth와 같은 이유) — 대화 도중 확인용으로
  // 조회한 결과는 저장되지 않는(intake_slots_json에 못 담는 in-memory Map) 캐시라 재사용할 수 없다.
  const geoCache = new Map();
  const [originGeo, destinationGeo] = await Promise.all([
    geocodeAddress(parsed.origin.address, geoCache),
    parsed.destination.address ? geocodeAddress(parsed.destination.address, geoCache) : Promise.resolve(null),
  ]);
  const geo = { origin: originGeo, destination: destinationGeo };

  // 왕복 복귀일을 따로 받지 않는 대화라 항상 "같은 날 왕복"으로 들어간다 — splitIntake는
  // 복귀 날짜가 다를 때만 두 건으로 나누므로(원문 규칙: "수행일이 갈릴 때뿐"), 이 흐름에서는
  // 항상 한 건으로 남는다. 그래도 규칙이 바뀌면(복귀일 수집이 추가되면) 자동으로 맞물리도록
  // splitIntake를 그대로 통과시킨다.
  const split = splitIntake({
    originAddress: parsed.origin.address,
    originContact: parsed.origin.contact || null,
    destinationAddress: parsed.destination.address,
    reservedDate: reservation.date,
    reservedTime: reservation.time,
    roundTrip: parsed.tripType === 'round_trip',
  });
  const part = split.parts[0];

  const created = await createOrder({
    branchId: account.branch_id,
    requesterGroupId: account.requester_group_id || null,
    originAddress: part.originAddress,
    originContact: part.originContact || null,
    destinationAddress: part.destinationAddress,
    vehicleNumber: parsed.vehicle.plate || null,
    vehicleType: parsed.vehicle.type || null,
    reservedDate: part.reservedDate,
    reservedTime: part.reservedTime,
    paymentMethodId: account.payment_method_id || null,
    fareAmount: 0,
    orderType,
    tripType: parsed.tripType || null,
    finalDestinationAddress: parsed.tripType === 'round_trip' ? (parsed.finalDestinationAddress || null) : null,
    destinationWaitMinutes: parsed.destinationWait && parsed.destinationWait.minutes > 0 ? parsed.destinationWait.minutes : null,
    originLat: geo.origin ? geo.origin.lat : null,
    originLon: geo.origin ? geo.origin.lon : null,
    originSido: geo.origin ? geo.origin.sido : null,
    originSigugun: geo.origin ? geo.origin.sigugun : null,
    originDong: geo.origin ? geo.origin.dong : null,
    destinationLat: geo.destination ? geo.destination.lat : null,
    destinationLon: geo.destination ? geo.destination.lon : null,
    destinationSido: geo.destination ? geo.destination.sido : null,
    destinationSigugun: geo.destination ? geo.destination.sigugun : null,
    destinationDong: geo.destination ? geo.destination.dong : null,
    memoCustomer: parsed.memo || null,
    createdBy: account.user_id,
    chatSessionId: session.id,
    sourceChannel: sourceChannel || 'web',
    waypoints: [],
  });

  await registerOrderWithCallmaner(created.orderId, account.branch_id);
  if (orderType === 'premium') {
    // fire-and-forget — 오더 등록 자체를 막지 않는다(routes/orders.js의 수동 등록과 동일하게).
    maybeUpgradePremiumToDaily({
      orderId: created.orderId,
      actorUserId: account.user_id,
      reservationHoursBracket: null,
      destinationWaitMinutes: parsed.destinationWait && parsed.destinationWait.minutes,
    });
  }

  return { ok: true, created, message: buildPremiumConfirmationMessage(parsed, created, orderType) };
}

// 등록 전(확인 요약)·등록 후(완료 통지) 문구가 공유하는 본문 줄. 날짜는 매번 resolveReservation
// 으로 새로 확정한다(카카오 채널과 동일한 방식 — "즉시"가 확인 시점과 실제 등록 시점에 서로
// 다른 시각으로 확정될 수 있는 것도 카카오와 같은 특성이다, lib/kakaoIntakeService.js 참고).
function buildPremiumSummaryLines(parsed) {
  const reservation = resolveReservation(parsed.when);
  const lines = [];
  lines.push(`· ${parsed.tripType === 'round_trip' ? '왕복' : '편도'}`);
  lines.push(`· ${reservation.date} ${reservation.time}`);
  if (parsed.vehicle.plate || parsed.vehicle.type) {
    lines.push(`· ${[parsed.vehicle.type, parsed.vehicle.plate].filter(Boolean).join(' ')}`);
  }
  lines.push(`· ${parsed.origin.address} → ${parsed.destination.address}`);
  if (parsed.tripType === 'round_trip' && parsed.finalDestinationAddress) {
    lines.push(`· 최종 목적지: ${parsed.finalDestinationAddress}`);
  }
  if (parsed.destinationWait && parsed.destinationWait.minutes > 0) {
    lines.push(`· 도착지 대기: ${parsed.destinationWait.minutes}분`);
  }
  if (parsed.memo) lines.push(`· 기사 전달사항: ${parsed.memo}`);
  return lines;
}

function buildPremiumConfirmationMessage(parsed, created, orderType) {
  const lines = [`접수했습니다. (${created.oid})`, ...buildPremiumSummaryLines(parsed)];
  lines.push('기사 배정되면 바로 알려드릴게요. 잘못된 내용이 있으면 알려주세요.');
  return lines.join('\n');
}

// 등록 실행 전(확인 대기) 요약 — lib/webIntakeTurn.js가 "맞으면 네" 안내를 이어붙인다.
function buildPremiumPreviewMessage(parsed) {
  const lines = ['아래 내용으로 접수합니다.', ...buildPremiumSummaryLines(parsed)];
  return lines.join('\n');
}

module.exports = { createPremiumOrderFromIntake, buildPremiumPreviewMessage };
