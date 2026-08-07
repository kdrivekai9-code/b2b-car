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
// 자동 등록 여부(auto_register)와 결제수단은 채널 전체 설정을 그대로 물려받는다. 개인을
// 확인했다고 해서 "이 채널에서 자동 등록해도 된다"는 관리자 판단까지 대신하지는 않는다.
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
        channel ? !!channel.auto_register : false,
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

async function insertOrder({ account, parsed, vehicle, reservation, geo, sessionId }) {
  const splitVehicle = splitTypeAndPlate(vehicle.type || null, vehicle.plate || null);
  const memo = buildOrderMemo(parsed);
  const tempOid = 'PENDING-' + Date.now() + '-' + Math.floor(Math.random() * 1000);

  const inserted = await db.get(`
    INSERT INTO orders (oid, branch_id, requester_group_id, origin_address, origin_contact,
      destination_address, destination_contact, vehicle_number, vehicle_type,
      reserved_date, reserved_time, payment_method_id, fare_amount, order_type,
      origin_lat, origin_lon, origin_sido, origin_sigugun, origin_dong,
      destination_lat, destination_lon, destination_sido, destination_sigugun, destination_dong,
      status, memo_customer, created_by, chat_session_id, source_channel)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'dispatch',
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '오더등록', ?, ?, ?, 'kakao')
    RETURNING id
  `, [
    tempOid, account.branch_id, account.requester_group_id || null,
    parsed.origin.address, parsed.origin.contact || null,
    parsed.destination.address || null, parsed.destination.contact || null,
    splitVehicle.vehicleNumber, splitVehicle.vehicleType,
    reservation.date, reservation.time, account.payment_method_id || null,
    geo.origin ? geo.origin.lat : null, geo.origin ? geo.origin.lon : null,
    geo.origin ? geo.origin.sido : null, geo.origin ? geo.origin.sigugun : null, geo.origin ? geo.origin.dong : null,
    geo.destination ? geo.destination.lat : null, geo.destination ? geo.destination.lon : null,
    geo.destination ? geo.destination.sido : null, geo.destination ? geo.destination.sigugun : null,
    geo.destination ? geo.destination.dong : null,
    memo, account.user_id, sessionId,
  ]);

  const orderId = Number(inserted.id);
  const oid = 'OID' + (1000 + orderId);
  await db.run('UPDATE orders SET oid = ? WHERE id = ?', [oid, orderId]);

  // 경유지가 없는 단일 구간이라 leg는 1개. order_legs 마이그레이션이 안 된 DB에서도 접수
  // 자체는 성공해야 하므로 실패는 무시한다(routes/orders.js와 같은 방어).
  await db.run('INSERT INTO order_legs (order_id, seq, driver_id) VALUES (?, 1, NULL)', [orderId])
    .catch((e) => console.error('order_legs 생성 실패(무시):', e.message));

  await db.run(
    `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note)
     VALUES (?, ?, NULL, '오더등록', '카카오 상담톡 자동 접수')`,
    [orderId, account.user_id]
  ).catch((e) => console.error('오더 상태이력 기록 실패(무시):', e.message));

  return { orderId, oid, vehicle: splitVehicle };
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
function buildConfirmationMessage(parsed, created, reservation) {
  const lines = [];
  const receipts = created.map((c) => c.oid).join(', ');
  lines.push(created.length > 1
    ? `${created.length}건 접수했습니다. (${receipts})`
    : `접수했습니다. (${receipts})`);

  created.forEach((c) => {
    const label = [c.vehicle.vehicleType, c.vehicle.vehicleNumber].filter(Boolean).join(' ');
    lines.push(`· ${label || '차량'}`);
  });

  lines.push(`· ${parsed.origin.address} → ${parsed.destination.address || '(도착지 미기재)'}`);
  lines.push(`· ${reservation.date} ${reservation.time}${reservation.immediate ? ' 즉시' : ''}`);

  const opts = [];
  if (parsed.options.insurance) opts.push('책임보험 가입');
  if (parsed.options.refuel) opts.push(parsed.options.refuel.fuel
    ? `${parsed.options.refuel.fuel} ${parsed.options.refuel.amount ? (parsed.options.refuel.amount / 10000) + '만원' : ''} 주유`.trim()
    : '주유 요청');
  if (parsed.options.documents) opts.push(parsed.options.documents);
  if (opts.length) lines.push(`· 옵션: ${opts.join(', ')}`);

  lines.push('기사 배정되면 바로 알려드릴게요. 잘못된 내용이 있으면 알려주세요.');
  return lines.join('\n');
}

// 접수 실행 — preflight를 통과한 폼만 들어온다. 차량 수만큼 오더를 만들고, 각각 콜마너로
// 보낸다. 콜마너 등록 실패는 오더 생성을 되돌리지 않는다(웹 경로와 동일 — 실패 사유가 오더에
// 기록되고 상태 변경 시 재시도된다).
async function createOrdersFromIntake({ session, account, parsed }) {
  const reservation = resolveReservation(parsed.when);
  const geo = await geocodeBoth(parsed);
  const check = await preflight({ account, parsed, reservation, geo });
  if (!check.ok) return { ok: false, reason: check.reason, detail: check.detail, reservation, geo };

  const created = [];
  for (const vehicle of parsed.vehicles) {
    const row = await insertOrder({ account, parsed, vehicle, reservation, geo, sessionId: session.id });
    created.push(row);
    await registerOrderWithCallmaner(row.orderId, account.branch_id);
  }

  return {
    ok: true,
    created,
    reservation,
    geo,
    message: buildConfirmationMessage(parsed, created, reservation),
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
