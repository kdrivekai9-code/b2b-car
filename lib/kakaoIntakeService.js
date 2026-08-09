// 카카오 상담톡 접수 폼 → 실제 오더 등록. "탁송 상담톡 챗봇 고도화 기획서" Phase 1의 본체다.
//
// 등록 경로는 웹(routes/orders.js POST /)과 같은 규칙을 따른다 — 같은 orders 컬럼에 넣고,
// order_legs를 만들고, 상태 이력을 남기고, 콜마너 접수는 lib/callmanerRegister.js를 그대로
// 호출한다. 다른 점은 셋뿐이다.
//   1. 주체가 로그인 사용자가 아니라 kakao_consult_accounts 매핑(계정·지사·그룹·결제수단)이다.
//   2. 주소가 텍스트뿐이라 좌표/행정구역을 lib/geocode.js로 직접 채운다(콜마너 필수값).
//   3. 폼 하나에 차량이 여러 대 오면 오더 N건으로 분해한다(로그 기준 4.6%).
const db = require('../db');
const { kstNow, toDateStr } = require('./period');
const { splitTypeAndPlate } = require('./vehicleInfo');
const { checkOperatingHours } = require('./branchPolicy');
const { geocodeAddress, isCallmanerReady } = require('./geocode');
const { registerOrderWithCallmaner } = require('./callmanerRegister');
// 접수를 실제 운영 규칙대로 나눈다 — 수행일이 갈릴 때만 나뉜다.
const { splitIntake, describeSplit, REASON_LABELS } = require('./orderSplit');
const { createOrder } = require('./orderCreate');
// 접수 요약은 상담원 초안·웹 접수 화면과 같은 모듈이 만든다.
const { buildSummaryText, fromParsed } = require('./intakeSummary');

// 채널 매핑 조회 — 고객 단위 매핑(service_key + user_key)을 먼저 보고, 없으면 채널 전체 매핑
// (service_key)으로 떨어진다. 둘 다 없으면 자동 등록하지 않는다(호출부가 상담원으로 넘긴다).
async function findIntakeAccount(session) {
  if (!session) return null;
  const byUser = await db.get(
    `SELECT * FROM kakao_consult_accounts
     WHERE enabled = true AND external_user_key IS NOT NULL AND external_user_key = ?
       AND (service_key IS NULL OR service_key = ?)
     ORDER BY id DESC LIMIT 1`,
    [session.external_user_key || session.kakao_user_key || null, session.kakao_service_key || null]
  ).catch(() => null);
  if (byUser) return byUser;

  return db.get(
    `SELECT * FROM kakao_consult_accounts
     WHERE enabled = true AND external_user_key IS NULL AND service_key = ?
     ORDER BY id DESC LIMIT 1`,
    [session.kakao_service_key || null]
  ).catch(() => null);
}

// 전화번호로 접수 문맥을 찾는다 — 개인정보 제공 동의로 받은 번호(chat_sessions.external_phone)가
// 있으면 채널 매핑보다 먼저 이걸 본다. 채널 하나를 여러 거래처가 함께 쓰는 경우 채널 매핑만으로는
// 구분되지 않지만, 번호는 사람을 특정하기 때문이다.
//
// 두 단계로 찾는다.
//   1) users.phone 일치 — 거래처 담당자 본인이 카카오로 문의한 경우
//   2) orders.origin_contact 일치 — 담당자가 아니라 현장에서 실제 차를 인계하는 사람(과거 이용 이력)
// 자동 등록 여부(auto_register)는 번호로 유추하지 않고 채널 매핑 설정만 따른다 — 번호가 맞다고
// 해서 "이 채널에서 자동 등록해도 된다"는 관리자 판단까지 대신할 수는 없다.
function normalizePhoneDigits(raw) {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  if (digits.length >= 11 && digits.indexOf('82') === 0 && digits[2] !== '0') return '0' + digits.slice(2);
  return digits;
}

async function findAccountByPhone(phone) {
  const normalized = normalizePhoneDigits(phone);
  if (!normalized) return null;

  // 1) 우리 사용자 중 같은 번호 — 하이픈 유무가 섞여 있어 숫자만 비교한다.
  const user = await db.get(
    `SELECT id, name, branch_id, group_id FROM users
     WHERE status = 'active' AND branch_id IS NOT NULL
       AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ?
     ORDER BY id LIMIT 1`,
    [normalized]
  ).catch(() => null);
  if (user) {
    return {
      user_id: user.id, branch_id: user.branch_id, requester_group_id: user.group_id || null,
      payment_method_id: null, auto_register: false, matched_by: 'user_phone',
    };
  }

  // 2) 과거 오더의 출발지 연락처 — 그 오더를 만든 계정/지사/법인을 그대로 쓴다.
  const order = await db.get(
    `SELECT created_by, branch_id, requester_group_id, payment_method_id FROM orders
     WHERE regexp_replace(COALESCE(origin_contact, ''), '[^0-9]', '', 'g') = ?
       AND created_by IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
    [normalized]
  ).catch(() => null);
  if (order) {
    return {
      user_id: order.created_by, branch_id: order.branch_id, requester_group_id: order.requester_group_id || null,
      payment_method_id: order.payment_method_id || null, auto_register: false, matched_by: 'order_contact',
    };
  }
  return null;
}

// 개인정보 동의로 받은 번호가 우리 거래처와 이어지면, 그 UserKey를 채널 매핑에 영구 등록한다.
//
// 왜 필요한가: 동의 말풍선은 상담 세션당 1회뿐이고 3일만 유효하다. 세션이 끝날 때마다 신원이
// 사라지면 반복 이용하는 거래처 담당자가 매번 동의를 다시 눌러야 하고, 그 1회를 매번 소진한다.
// UserKey는 채널별로 고정이므로(명세서 용어집) 한 번 이어두면 다음 상담부터는 첫 메시지부터
// 거래처가 확정된다 — 동의 절차 자체가 필요 없어진다.
//
// 오더 자동등록은 켜서 만든다(사용자 확정 사항). 접수된 오더는 우리 쪽 상태가 '오더등록'이고
// 콜마너에도 항상 대기(status=5)로 나가므로(lib/callmaner.js), 자동 등록돼도 담당자가 확인하기
// 전에 배차가 돌지 않는다 — 웹 챗봇도 같은 이유로 자동 등록하고 있다. 신원이 확인된(UserKey가
// 거래처 계정에 이어진) 고객이라 접수 주체도 분명하다.
// 결제수단은 채널 전체 설정을 물려받는다.
async function linkUserKeyToAccount(session, matched) {
  const userKey = (session && (session.external_user_key || session.kakao_user_key)) || null;
  if (!userKey || !matched || !matched.user_id || !matched.branch_id) return null;

  const existing = await db.get(
    `SELECT id FROM kakao_consult_accounts
     WHERE external_user_key = ? AND (service_key IS NULL OR service_key = ?)
     LIMIT 1`,
    [userKey, session.kakao_service_key || null]
  ).catch(() => null);
  if (existing) return existing.id;

  const channel = await findIntakeAccount({ ...session, external_user_key: null, kakao_user_key: null })
    .catch(() => null);

  try {
    const row = await db.get(
      `INSERT INTO kakao_consult_accounts
         (service_key, external_user_key, label, user_id, branch_id, requester_group_id, payment_method_id, auto_register, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, true) RETURNING id`,
      [
        session.kakao_service_key || null,
        userKey,
        `개인정보 동의 자동 연결${session.external_name ? ' · ' + session.external_name : ''}`,
        matched.user_id,
        matched.branch_id,
        matched.requester_group_id || null,
        matched.payment_method_id || (channel ? channel.payment_method_id : null),
        true,
      ]
    );
    return row ? row.id : null;
  } catch (e) {
    console.error('카카오 UserKey 매핑 자동 등록 실패:', e.message);
    return null;
  }
}

// 접수/조회에 쓸 문맥 — 번호 우선, 없으면 채널 매핑.
// 번호로 찾았고 채널 매핑도 있으면 auto_register와 결제수단은 채널 설정을 따른다(관리자 판단 우선).
async function resolveIntakeContext(session) {
  const channel = await findIntakeAccount(session);
  const byPhone = await findAccountByPhone(session && session.external_phone);
  if (!byPhone) return channel;
  return {
    ...byPhone,
    payment_method_id: byPhone.payment_method_id || (channel ? channel.payment_method_id : null),
    auto_register: channel ? !!channel.auto_register : false,
    channel_account_id: channel ? channel.id : null,
  };
}

// 예약일시 — "즉시"면 지금 시각을 10분 단위로 올림해서 넣는다(웹 폼의 기본값 규칙과 동일하게
// 10분 단위만 쓴다). 날짜만 있고 시각이 없으면 09:00으로 두지 않고 지금 시각을 쓴다 —
// 로그의 "즉시~"가 압도적이라 시각 미기재는 "지금"을 뜻하는 경우가 대부분이다.
function resolveReservation(when) {
  const now = kstNow();
  const pad = (n) => String(n).padStart(2, '0');
  const roundedMinute = Math.ceil(now.getUTCMinutes() / 10) * 10;
  const base = new Date(now.getTime());
  if (roundedMinute >= 60) {
    base.setUTCHours(base.getUTCHours() + 1);
    base.setUTCMinutes(0);
  } else {
    base.setUTCMinutes(roundedMinute);
  }
  const nowTime = `${pad(base.getUTCHours())}:${pad(base.getUTCMinutes())}`;

  if (!when || when.immediate) {
    // "3/21(금) 즉시~"처럼 날짜가 이미 지나 내년으로 밀린(dateRolled) 즉시 요청은, 고객이
    // 말한 게 날짜가 아니라 "지금"이다 — 1년 뒤 예약으로 등록하면 명백한 오등록이 된다.
    const date = when && when.date && !when.dateRolled ? when.date : toDateStr(now);
    return { date, time: (when && when.time) || nowTime, immediate: true };
  }
  return { date: when.date || toDateStr(now), time: when.time || nowTime, immediate: false };
}

// 옵션(주유/서류/보험/연료잔량/출고일)은 기사에게 그대로 전달돼야 하는 지시라 고객 메모에
// 합쳐 넣는다. 콜마너 memo는 100바이트 제한이라 서버에서 잘리지만(truncateBytes), 우리 DB의
// memo_customer에는 전체가 남아 상담원 화면과 기사 앱에서 볼 수 있다.
function buildOrderMemo(parsed) {
  const parts = [];
  const o = parsed.options || {};
  if (o.insurance) parts.push('책임보험 가입');
  if (o.refuel) parts.push(o.refuel.raw || '주유 요청');
  else if (o.fuelGauge) parts.push(`연료 ${o.fuelGauge}칸`);
  if (o.documents) parts.push(o.documents);
  if (o.releaseDate) parts.push(`출고일 ${o.releaseDate}`);
  if (parsed.memo) parts.push(parsed.memo);
  return parts.join(' / ').slice(0, 1000) || null;
}

// 주소 → 좌표/행정구역. 같은 폼 안에서 출발지/도착지는 각각 한 번만 조회하고 차량 수만큼
// 재사용한다(복수 차량 접수에서 같은 주소를 N번 지오코딩하지 않도록).
async function geocodeBoth(parsed) {
  const [origin, destination] = await Promise.all([
    geocodeAddress(parsed.origin.address),
    parsed.destination.address ? geocodeAddress(parsed.destination.address) : Promise.resolve(null),
  ]);
  return { origin, destination };
}

// 오더 저장은 웹 오더등록과 같은 함수를 쓴다(lib/orderCreate.js) — 예전에는 여기 별도 INSERT가
// 있어서, 컬럼이 추가될 때 카카오로 들어온 오더만 값이 비는 사고가 나기 쉬웠다.
async function insertOrder({ account, parsed, vehicle, reservation, geo, sessionId, split }) {
  const created = await createOrder({
    branchId: account.branch_id,
    requesterGroupId: account.requester_group_id || null,
    originAddress: parsed.origin.address,
    originContact: parsed.origin.contact || null,
    destinationAddress: parsed.destination.address || null,
    destinationContact: parsed.destination.contact || null,
    vehicleNumber: vehicle.plate || null,
    vehicleType: vehicle.type || null,
    reservedDate: reservation.date,
    reservedTime: reservation.time,
    paymentMethodId: account.payment_method_id || null,
    fareAmount: 0,
    orderType: 'dispatch',
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
    memoCustomer: buildOrderMemo(parsed),
    createdBy: account.user_id,
    chatSessionId: sessionId,
    sourceChannel: 'kakao',
    // 같은 요청에서 나온 건들을 묶어둔다 — 나누고 나면 두 건이 서로 남남이 되어, 한쪽을 취소할 때
    // 다른 쪽이 남아 있다는 것도 알 수 없다.
    splitGroupId: split ? split.groupId : null,
    splitSeq: split ? split.seq : null,
    splitTotal: split ? split.total : null,
    historyNote: split
      ? `카카오 상담톡 자동 접수 (${describeSplit(split.reason, split.seq, split.total)})`
      : '카카오 상담톡 자동 접수',
  });

  return {
    orderId: created.orderId,
    oid: created.oid,
    vehicle: { vehicleNumber: created.vehicleNumber, vehicleType: created.vehicleType },
  };
}

// 자동 등록 사전 점검 — 여기서 걸리면 오더를 만들지 않고 이유를 돌려준다. 호출부는 그 이유를
// 그대로 상담원 인계 사유로 쓴다. "일단 등록하고 나중에 고친다"를 하지 않는 이유는, 콜마너까지
// 나간 오더를 되돌리는 비용이 되묻기보다 훨씬 크기 때문이다.
async function preflight({ account, parsed, reservation, geo }) {
  if (!account) return { ok: false, reason: 'no_account' };
  if (!account.auto_register) return { ok: false, reason: 'auto_register_off' };
  if (!parsed.complete) return { ok: false, reason: 'incomplete_form' };
  if (!geo.origin || !isCallmanerReady(geo.origin)) return { ok: false, reason: 'origin_geocode_failed' };

  const hours = await checkOperatingHours(account.branch_id, reservation.date, reservation.time).catch(() => ({ allowed: true }));
  if (hours && hours.allowed === false) return { ok: false, reason: 'operating_hours', detail: hours.reason };

  return { ok: true };
}

// 접수 확인 문구 — 상담원이 지금 보내는 "네 접수하겠습니다"를 대체한다. 파싱해서 이해한 내용을
// 그대로 돌려주는 게 핵심이다(고객이 오인식을 즉시 잡을 수 있게). 기획서 6절 목표 대화 참고.
// 등록 후 통보 문구. 요약 본문은 웹 접수 화면과 같은 모듈이 만든다(lib/intakeSummary.js) —
// 머리말(접수번호)과 꼬리말만 이 경로가 정한다.
function buildConfirmationMessage(parsed, created, reservation, split) {
  const receipts = created.map((c) => c.oid).join(', ');
  // 왜 여러 건인지 밝힌다. 한 번 요청했는데 접수번호가 둘 오면 고객은 중복 접수로 오해한다.
  const reasonLabel = split && split.reason ? REASON_LABELS[split.reason] : null;
  const head = created.length > 1
    ? (reasonLabel
      ? `${reasonLabel}로 ${created.length}건 접수했습니다. (${receipts})`
      : `${created.length}건 접수했습니다. (${receipts})`)
    : `접수했습니다. (${receipts})`;

  // 차량은 실제로 등록된 값(차종/번호 분리 결과)을 쓴다 — 파서가 뽑은 원문과 저장값이
  // 다를 수 있어(splitTypeAndPlate) 고객에게는 저장된 쪽을 보여줘야 한다.
  const intake = {
    ...fromParsed(parsed, reservation),
    vehicles: created.map((c) => ({ type: c.vehicle.vehicleType, number: c.vehicle.vehicleNumber })),
  };

  return buildSummaryText(intake, {
    head,
    tail: '기사 배정되면 바로 알려드릴게요. 잘못된 내용이 있으면 알려주세요.',
    labeled: false,
  });
}

// 접수 실행 — preflight를 통과한 폼만 들어온다. 차량 수만큼 오더를 만들고, 각각 콜마너로
// 보낸다. 콜마너 등록 실패는 오더 생성을 되돌리지 않는다(웹 경로와 동일 — 실패 사유가 오더에
// 기록되고 상태 변경 시 재시도된다).
// 접수를 실제 운영 규칙대로 나눈다(lib/orderSplit.js) — 수행일이 갈리면 구간마다 별도 오더다.
// 나뉘지 않으면 parts가 하나뿐이라 예전과 똑같이 동작한다.
//
// parsed(폼 파서 모양)를 orderSplit이 아는 모양으로 옮긴다. 두 모듈이 서로의 필드 이름을 알게
// 하지 않으려고 이 자리에서만 변환한다.
function toSplitInput(parsed, reservation) {
  return {
    originAddress: parsed.origin.address,
    originContact: parsed.origin.contact || null,
    destinationAddress: parsed.destination.address || null,
    destinationContact: parsed.destination.contact || null,
    waypoints: (parsed.waypoints || []).map((w) => ({
      address: w.address,
      contact: w.contact || null,
      vehicleNumber: w.vehicleNumber || null,
      reservedDate: w.reservedDate || null,
      reservedTime: w.reservedTime || null,
    })),
    reservedDate: reservation.date,
    reservedTime: reservation.time,
    roundTrip: !!parsed.roundTrip,
    returnReservedDate: (parsed.returnWhen && parsed.returnWhen.date) || null,
    returnReservedTime: (parsed.returnWhen && parsed.returnWhen.time) || null,
  };
}

// 나뉜 한 건을 parsed 모양으로 되돌린다 — insertOrder·geocodeBoth가 parsed를 받기 때문이다.
function partToParsed(parsed, part) {
  return {
    ...parsed,
    origin: { address: part.originAddress, contact: part.originContact || null },
    destination: { address: part.destinationAddress, contact: part.destinationContact || null },
    waypoints: part.waypoints || [],
  };
}

async function createOrdersFromIntake({ session, account, parsed }) {
  const reservation = resolveReservation(parsed.when);
  const split = splitIntake(toSplitInput(parsed, reservation));

  // 나뉜 뒤에도 경유지가 남아 있으면 자동 등록하지 않는다 — 접수 서비스가 경유지를 저장하지
  // 못해서 그대로 등록하면 경유지가 조용히 사라진다. 날짜가 갈려 나뉜 건들은 각각 A→B라
  // 이 조건에 걸리지 않는다.
  if (split.parts.some((p) => (p.waypoints || []).length)) {
    return { ok: false, reason: 'waypoint_unsupported', reservation, geo: { origin: null, destination: null } };
  }

  // 나뉜 건 중 일시를 모르는 것이 있으면 등록하지 않는다 — 시각을 임의로 채우면 잘못된 시각으로
  // 접수된다. 호출부가 고객에게 되묻는다.
  if (split.missingSchedule.length) {
    return { ok: false, reason: 'split_schedule_missing', detail: split, reservation, geo: { origin: null, destination: null } };
  }

  const createdAll = [];
  // 같은 요청에서 나온 건들을 나중에 묶어 볼 수 있게 하나의 값을 공유시킨다.
  const splitGroupId = split.parts.length > 1 ? `sg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : null;
  let firstGeo = null;

  for (const part of split.parts) {
    const partParsed = partToParsed(parsed, part);
    const partReservation = { ...reservation, date: part.reservedDate || reservation.date, time: part.reservedTime || reservation.time };
    const geo = await geocodeBoth(partParsed);
    if (!firstGeo) firstGeo = geo;

    const check = await preflight({ account, parsed: partParsed, reservation: partReservation, geo });
    if (!check.ok) return { ok: false, reason: check.reason, detail: check.detail, reservation: partReservation, geo };

    for (const vehicle of partParsed.vehicles) {
      const row = await insertOrder({
        account, parsed: partParsed, vehicle, reservation: partReservation, geo, sessionId: session.id,
        split: splitGroupId ? { groupId: splitGroupId, seq: part.splitSeq, total: part.splitTotal, reason: split.reason } : null,
      });
      createdAll.push(row);
      await registerOrderWithCallmaner(row.orderId, account.branch_id);
    }
  }

  return {
    ok: true,
    created: createdAll,
    reservation,
    geo: firstGeo || { origin: null, destination: null },
    split: split.reason ? { reason: split.reason, total: split.parts.length, groupId: splitGroupId } : null,
    message: buildConfirmationMessage(parsed, createdAll, reservation, split),
  };
}

module.exports = {
  findIntakeAccount,
  findAccountByPhone,
  resolveIntakeContext,
  linkUserKeyToAccount,
  createOrdersFromIntake,
  buildConfirmationMessage,
  buildOrderMemo,
  resolveReservation,
  preflight,
};
