// 카카오 상담톡 능동 통보 — 오더 상태가 바뀌면 고객에게 먼저 알린다.
//
// Phase 2의 첫 조각이다. 지금까지 고객은 "배차됐나요?"를 직접 물어야 했고, 상담원 발화의 29.7%가
// 그 답이었다. 상태가 바뀐 걸 우리가 먼저 알려주면 그 질문 자체가 사라진다.
//
// 다루는 사건은 넷이다.
//   dispatched         — 기사 배차 완료
//   completed          — 운행 완료
//   dispatch_cancelled — 배차받은 기사가 취소해서 다시 배차를 찾는 중(오더는 살아 있다)
//   cancelled          — 오더 자체가 취소됨
//
// 뒤의 둘은 로컬 상태로 구분된다. 배차 취소는 '기사배정'에서 미배차 상태로 되돌아가는 것이고,
// 오더 취소는 '취소'로 가는 것이다. 다만 콜마너가 "기사가 배차를 취소한" 상황을 어느 쪽으로
// 넘겨주는지는 실측 기록이 없다 — '취소'로 넘어온다면 다시 배차 중인 건을 종료로 안내하게 되므로,
// 실제 사례가 한 번 생기면 order_status_history로 확인해야 한다.
//
// 상태를 바꾸는 지점은 세 곳이다(콜마너 전체조회 / conf_slip 단건조회 / 관리자 수동 변경).
// 그 셋에 각각 통보 코드를 심는 대신 order_status_history를 읽어 전이를 찾는다 — 셋 다 이미
// 거기에 남기고 있어서, 나중에 상태를 바꾸는 경로가 하나 더 생겨도 통보가 저절로 따라온다.
const db = require('../db');
const kakaoConsult = require('./kakaoConsult');
const { ORDER_TYPE_LABELS } = require('../config');
const { isSessionBusy } = require('./sessionBusy');
const { broadcastMessage } = require('./realtimeChat');
const callmanerPhotos = require('./callmanerPhotos');
const kakaoOrderPhotos = require('./kakaoOrderPhotos');

// 마이그레이션을 아직 적용하지 않은 DB에서도 크론이 조용히 지나가게 한다. 안 그러면 매분 도는
// 크론이 매번 500을 내면서 로그를 채우고, 정작 봐야 할 실패가 묻힌다. 콜마너 동기화가
// callmaner_driver_* 컬럼에 대해 쓰는 폴백과 같은 취지다.
const UNDEFINED_TABLE = '42P01';
const UNDEFINED_COLUMN = '42703';

// 마이그레이션 20260814010000이 추가하는 컬럼들 — 없으면 한 번 실패한 뒤 그 컬럼 없이 돈다.
let supportsChannelColumn = true;
let supportsDeferColumn = true;
let supportsAttachmentsColumn = true;

// 한 통보에 붙일 사진 수 — 카카오 이미지 발송 제한과 같은 값을 쓴다(lib/kakaoOrderPhotos.js).
const MAX_NOTIFY_PHOTOS = 5;

const DISPATCHED_STATUS = '기사배정';
const STARTED_STATUS = '운행시작';
const COMPLETED_STATUS = '완료';
const CANCELLED_STATUS = '취소';
// 이미 기사가 붙은 상태들. 이 둘 사이를 오가는 것은 새 배차가 아니다 — 콜마너가 운행 중에도
// status='배차'를 계속 주기 때문에 운행시작 ↔ 기사배정 왕복이 실제로 생길 수 있다.
const DISPATCHED_LIKE = new Set([DISPATCHED_STATUS, STARTED_STATUS]);
// 배차 상태에서 이 중 하나로 되돌아가면 "기사가 취소해 다시 배차를 찾는 중"이다.
// 완료/취소는 제외한다 — 오더가 끝난 것이지 배차가 취소된 게 아니다.
const AWAITING_DISPATCH_STATUSES = new Set(['접수', '대기', '예약']);

// 지사가 따로 설정하지 않았을 때의 기본값. 지사를 새로 만들 때마다 설정을 넣어주지 않아도
// 통보가 나가야 해서 옵트아웃으로 둔다.
//
// 배차완료만 1분 미룬다 — 배차 직후 취소되는 경우가 있어서, 바로 보내면 "배차됐습니다" 다음에
// 곧장 "취소됐습니다"가 이어진다. 나머지는 이미 결과가 확정된 사건이라 미룰 이유가 없다.
const DEFAULT_EVENT_SETTINGS = {
  dispatched: {
    label: '배차완료',
    enabled: true,
    // 2분 — 배차 직후 기사가 취소하는 경우가 있어서 바로 보내면 "배차됐습니다" 다음에 곧장
    // "취소됐습니다"가 이어진다(사용자 지정: 배차 후 2분).
    delayMinutes: 2,
    attachPhotos: false,
    template: '요청하신 {order_type}건이 기사님 배차되었습니다.\n접수번호: {oid}\n일시: {reserved_at}\n{origin_full} → {destination_full}\n기사명: {driver_name}\n기사전화번호: {driver_phone}',
  },
  started: {
    label: '운행시작',
    enabled: true,
    delayMinutes: 0,
    attachPhotos: false,
    template: '요청하신 {order_type}건이 운행시작 되었습니다.\n접수번호: {oid}\n일시: {reserved_at}\n{origin_full} → {destination_full}',
  },
  completed: {
    label: '운행완료',
    enabled: true,
    delayMinutes: 0,
    attachPhotos: false,
    template: '요청하신 {order_type}건이 운행완료 되었습니다.\n접수번호: {oid}\n일시: {reserved_at}\n{origin_full} → {destination_full}',
  },
  dispatch_cancelled: {
    label: '배차취소',
    enabled: true,
    delayMinutes: 0,
    attachPhotos: false,
    template: '[{oid}] 배차받은 기사님이 취소하였고, 다른 기사님께 배차 진행중입니다.',
  },
  cancelled: {
    label: '오더취소',
    // 기본으로 끈다(사용자 확정). 콜마너의 '취소'를 그대로 믿을 수 없다는 것이 실측으로
    // 확인됐다 — 기사가 배차를 취소하면 콜마너가 잠깐 '취소'를 준 뒤 1분쯤 뒤에 '접수'로
    // 되돌린다(OID1237: 18:41:29 취소 → 18:42:30 접수). 그 순간을 잡아 "오더가 취소되었습니다"를
    // 보내면 멀쩡히 진행 중인 오더를 취소됐다고 통보하는 오발신이 된다.
    // 진짜 취소를 안내하고 싶으면 지사 설정에서 켤 수 있다.
    enabled: false,
    delayMinutes: 0,
    attachPhotos: false,
    template: '[{oid}] 오더가 취소되었습니다. 문의사항은 상담원에게 말씀해주세요.',
  },
};

// 설정 화면(views/branches/customer_notifications.ejs)의 변수 칩과 renderTemplate이 같은
// 목록을 쓰도록 여기서 한 번만 정의한다 — 화면에만 있는 변수(치환 안 됨)나 코드에만 있는
// 변수(관리자가 알 수 없음)가 생기지 않게 한다.
//
// 토큰은 반드시 ASCII다. renderTemplate이 /\{(\w+)\}/로 치환하는데 \w는 한글에 안 걸려서
// {출발지} 같은 토큰은 영원히 치환되지 않고 고객에게 그대로 나간다.
const TEMPLATE_VARIABLES = [
  { token: '{oid}', label: '접수번호', hint: '예: OID1246' },
  { token: '{order_type}', label: '오더종류', hint: '탁송 / 프리미엄대리 / 일일기사' },
  { token: '{reserved_at}', label: '일시', hint: '예약일시(없으면 줄이 사라짐)' },
  { token: '{origin_full}', label: '출발지', hint: '상세주소까지 합친 값' },
  { token: '{destination_full}', label: '도착지', hint: '상세주소까지 합친 값' },
  { token: '{driver_name}', label: '기사명', hint: '배차 전에는 줄이 사라짐' },
  { token: '{driver_phone}', label: '기사전화번호', hint: '콜마너 안심번호(050)' },
  { token: '{odometer_start}', label: '출발지 주행거리', hint: '계기판 인식값, 단위(km) 자동' },
  { token: '{odometer_end}', label: '도착지 주행거리', hint: '계기판 인식값, 단위(km) 자동' },
  { token: '{distance_total}', label: '최종 운행 거리', hint: '도착지 − 출발지, 단위(km) 자동' },
];

const EVENT_TYPES = Object.keys(DEFAULT_EVENT_SETTINGS);

// 한 번에 훑는 이력 수 — 크론이 1분마다 도는데 그 안에 끝나야 한다.
const HISTORY_SCAN_LIMIT = 500;
const SEND_BATCH_LIMIT = 50;

// 같은 오더가 취소 후 다시 배차될 수 있다. 기사가 바뀌면 새 통보여야 하므로 기사 식별값을
// 중복 판정에 함께 쓴다 — 이것 없이 (오더, 사건)만 잠그면 재배차 통보가 막힌다.
function driverKey(order) {
  return String(
    order.callmaner_driver_sabun
    || order.callmaner_driver_phone
    || order.callmaner_driver_name
    || ''
  ).trim();
}

// 지사 설정을 읽는다. 행이 없으면 기본값 — 설정 테이블이 아직 없는 DB에서도 통보는 나가야 한다.
async function loadEventSetting(branchId, eventType) {
  const fallback = DEFAULT_EVENT_SETTINGS[eventType];
  if (!branchId) return fallback;
  let row = null;
  try {
    row = await db.get(
      // 컬럼을 나열하면 attach_photos가 없는 DB에서 42703이 난다 — *로 받아 코드에서 판단한다.
      'SELECT * FROM branch_customer_notifications WHERE branch_id = ? AND event_type = ?',
      [branchId, eventType]
    );
  } catch (e) {
    if (!e || e.code !== UNDEFINED_TABLE) throw e;
  }
  if (!row) return fallback;
  return {
    label: fallback.label,
    enabled: row.enabled !== false,
    delayMinutes: Number.isFinite(Number(row.delay_minutes)) ? Number(row.delay_minutes) : fallback.delayMinutes,
    template: String(row.message_template || '').trim() || fallback.template,
    // attach_photos 컬럼이 없는 DB(마이그레이션 전)에서는 undefined → 기본값(꺼짐)으로 본다.
    attachPhotos: row.attach_photos === undefined ? !!fallback.attachPhotos : row.attach_photos === true,
  };
}

// 주소와 상세주소를 합친다. 그냥 이어붙이면 안 되는 이유: 웹 오더등록(routes/orders.js의
// combineAddress)은 origin_address에 상세주소를 **이미 합쳐서** 저장하는데, 카카오/AI 접수
// (lib/kakaoIntakeService.js)는 따로 저장한다. 구분 없이 붙이면 웹 오더에서 상세주소가 두 번
// 나온다("서울 강서구 양천로53길 30 3층 3층").
function mergeAddress(address, detail) {
  const a = String(address || '').trim();
  const d = String(detail || '').trim();
  if (!d) return a;
  if (!a) return d;
  return a.endsWith(d) ? a : `${a} ${d}`;
}

// 주행거리는 단위를 값 안에 넣는다. 템플릿에 "{distance_total}km"로 두면 값이 없을 때
// "최종 운행 거리: km"라는 껍데기가 남는데, 값에 단위를 넣으면 빈 값일 때 라벨만 남은 줄로
// 판정돼 줄 전체가 깔끔하게 사라진다.
function formatKm(value) {
  // null/undefined/빈 문자열을 Number()에 그대로 넘기면 0이 된다 — 그러면 "아직 못 읽었다"가
  // "0km 달렸다"로 바뀌어 고객에게 나간다. 값 없음을 먼저 걸러낸다.
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '';
  return `${n.toLocaleString('ko-KR')}km`;
}

// 문구 템플릿 치환. 값이 없는 자리는 빈 문자열로 지우고, 그 때문에 생긴 빈 괄호나 "기사: " 같은
// 껍데기도 함께 정리한다 — 기사 정보가 안 들어온 상태에서 "기사:  ()"가 고객에게 나가면 안 된다.
// context는 오더 컬럼에 없는 값(계기판 인식 결과 등)을 넘길 때 쓴다 — 없으면 orders 컬럼을 본다.
function renderTemplate(template, order, context = {}) {
  const ctx = context || {};
  const pick = (a, b) => (a === undefined || a === null ? b : a);
  const values = {
    oid: String(order.oid || '').trim(),
    order_type: ORDER_TYPE_LABELS[order.order_type] || '',
    driver_name: String(order.callmaner_driver_name || '').trim(),
    driver_phone: String(order.callmaner_driver_phone || '').trim(),
    origin: String(order.origin_address || '').trim(),
    destination: String(order.destination_address || '').trim(),
    origin_full: mergeAddress(order.origin_address, order.origin_address_detail),
    destination_full: mergeAddress(order.destination_address, order.destination_address_detail),
    reserved_at: [order.reserved_date, order.reserved_time].filter(Boolean).join(' ').trim(),
    odometer_start: formatKm(pick(ctx.odometerStart, order.odometer_start)),
    odometer_end: formatKm(pick(ctx.odometerEnd, order.odometer_end)),
    distance_total: formatKm(pick(ctx.distanceTotal, order.distance_total)),
    // {photos}는 텍스트가 아니라 스위치다(buildMessage가 읽는다) — 문구에서는 지운다.
    photos: '',
  };

  return String(template || '')
    .replace(/\{(\w+)\}/g, (whole, key) => (key in values ? values[key] : whole))
    // 저장 시점에 정규화하지만(routes/branches.js), 그 전에 저장된 값에도 \r이 남아 있을 수 있다.
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line
      .replace(/\(\s*\)/g, '')      // 값이 비어 남은 빈 괄호
      .replace(/\[\s*\]/g, '')      // 값이 비어 남은 빈 대괄호
      .replace(/[ \t]{2,}/g, ' ')
      .trim())
    // 한쪽 주소만 비면 "→ 도착지" / "출발지 →"처럼 화살표가 매달린다 — 떼어낸다.
    .map((line) => line.replace(/^(?:→|->)\s*/, '').replace(/\s*(?:→|->)$/, '').trim())
    // 라벨만 남은 줄("기사명:")과 구분자만 남은 줄("→")은 통째로 버린다. 라벨 길이 한도를
    // 20자로 둔 이유: "출발지 주행거리:"(9자)는 기존 10자에도 걸리지만 여유가 없었다.
    .filter((line) => line && !/^[^:]{1,20}:$/.test(line) && !/^[→\-–—>·,/]+$/.test(line))
    .join('\n');
}

// 문구와 "사진을 함께 보낼지"를 함께 돌려준다. 사진은 텍스트가 아니라 별도 발송이라
// (카카오는 이미지 메시지, 웹은 첨부) 문구 안에 위치를 지정할 수 없어 스위치로 다룬다.
// 관리자가 문구에 {photos}를 직접 적은 경우도 스위치를 켠 것으로 받아준다.
function buildMessage(eventType, order, setting, context = {}) {
  const resolved = setting || DEFAULT_EVENT_SETTINGS[eventType];
  const template = resolved && resolved.template;
  return {
    text: renderTemplate(template, order, context),
    attachPhotos: !!(resolved && resolved.attachPhotos) || /\{photos\}/.test(String(template || '')),
  };
}

// 상태 전이 하나를 보고 어떤 통보가 필요한지 판정한다. DB 없이 확인할 수 있도록 따로 뺐다
// (scripts/check-kakao-order-notify.js) — 여기가 틀리면 엉뚱한 사람에게 엉뚱한 안내가 나간다.
//
// 완료/취소로 끝난 오더는 배차 취소가 아니다. 오더 자체가 끝난 것을 "다른 기사님께 배차
// 진행중"이라고 안내하면 고객은 오지 않을 기사를 기다린다.
function classifyTransition(oldStatus, newStatus) {
  if (!oldStatus || !newStatus) return null;
  if (oldStatus === newStatus) return null;

  // 운행시작도 "이미 기사가 붙은" 상태다. 운행시작 → 기사배정은 콜마너 쪽 흔들림(운행 중에도
  // status='배차'를 계속 주는 특성)일 뿐이라 배차 통보를 다시 보내면 안 된다.
  const wasDispatched = DISPATCHED_LIKE.has(oldStatus);
  if (newStatus === DISPATCHED_STATUS) return wasDispatched ? null : 'dispatched';
  if (newStatus === STARTED_STATUS) return 'started';
  if (newStatus === COMPLETED_STATUS) return 'completed';
  if (newStatus === CANCELLED_STATUS) return 'cancelled';
  if (wasDispatched && AWAITING_DISPATCH_STATUSES.has(newStatus)) return 'dispatch_cancelled';
  return null;
}

// 통보 대상인지 + 어느 채널로 보낼지.
//
// 예전에는 카카오 발신 키가 있는 세션만 대상이라, 웹 챗봇으로 접수한 고객은 능동 통보를 한 건도
// 못 받았다(웹 세션에는 kakao_service_key/kakao_user_key가 없어 여기서 전부 걸러졌다). 웹은
// 대화창에 남기는 것 자체가 전달이므로(고객 화면이 SSE로 받는다) 채널을 판정해 양쪽 다 태운다.
//
// 오더 하나에는 세션이 하나뿐이다(orders.chat_session_id) — 두 채널로 동시에 보내는 게 아니라,
// 그 세션이 웹이면 웹으로 보낸다는 뜻이다.
async function loadNotifiableOrder(orderId) {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order || !order.chat_session_id) return null;
  const session = await db.get('SELECT * FROM chat_sessions WHERE id = ?', [order.chat_session_id]);
  if (!session) return null;
  if (kakaoConsult.isConfigured(session)) return { order, session, channel: 'kakao' };
  if (session.channel === 'web') return { order, session, channel: 'web' };
  // 카카오 세션인데 발신 키가 사라진 경우 — 예전과 같이 대상 아님.
  return null;
}

// ---------------- 감지 ----------------

async function collectFromHistory() {
  const cursorRow = await db.get('SELECT last_history_id FROM kakao_notification_cursor WHERE id = 1');
  const lastId = Number(cursorRow && cursorRow.last_history_id) || 0;

  const rows = await db.all(
    `SELECT id, order_id, old_status, new_status FROM order_status_history
     WHERE id > ? AND old_status IS NOT NULL AND new_status IS NOT NULL
     ORDER BY id ASC LIMIT ${HISTORY_SCAN_LIMIT}`,
    [lastId]
  );
  if (!rows.length) return { scanned: 0, scheduled: 0, cursor: lastId };

  let scheduled = 0;
  let disabled = 0;
  for (const row of rows) {
    const eventType = classifyTransition(row.old_status, row.new_status);
    if (!eventType) continue;

    const target = await loadNotifiableOrder(row.order_id);
    if (!target) continue;

    // 지사가 이 사건을 끈 상태면 예약 자체를 만들지 않는다.
    const setting = await loadEventSetting(target.order.branch_id, eventType);
    if (!setting.enabled) { disabled += 1; continue; }

    const delayMs = Math.max(0, Number(setting.delayMinutes) || 0) * 60 * 1000;
    const inserted = await db.run(
      `INSERT INTO kakao_order_notifications (order_id, chat_session_id, event_type, dedupe_key, scheduled_at)
       VALUES (?, ?, ?, ?, now() + (?::text || ' milliseconds')::interval)
       ON CONFLICT (order_id, event_type, dedupe_key) DO NOTHING`,
      [target.order.id, target.session.id, eventType, driverKey(target.order), String(delayMs)]
    );
    if (inserted && inserted.rowCount) scheduled += 1;
  }

  const nextCursor = rows[rows.length - 1].id;
  await db.run(
    'UPDATE kakao_notification_cursor SET last_history_id = ?, updated_at = now() WHERE id = 1',
    [nextCursor]
  );
  return { scanned: rows.length, scheduled, disabled, cursor: nextCursor };
}

// ---------------- 발송 ----------------

// 발송 직전에 "그 사건이 여전히 사실인지" 확인할 상태. 지연을 두고 보내는 사건은 그 사이에
// 상황이 뒤집힐 수 있다. 배차취소는 여기에 넣지 않는다 — 취소 직후 다른 기사가 잡히면 상태가
// 다시 '기사배정'이 되는데, 그렇다고 "기사가 취소했다"는 사실이 없던 일이 되지는 않는다.
const EXPECTED_STATUS_AT_SEND = {
  // 배차 통보는 2분 뒤에 나가는데 그 사이 기사가 출발하면 상태가 '운행시작'이 된다.
  // 운행시작을 여기 넣지 않으면 배차 안내가 통째로 사라져 고객이 배차 사실을 영영 못 듣는다.
  dispatched: [DISPATCHED_STATUS, STARTED_STATUS],
  // 운행시작은 엄격하게 본다 — 이미 완료된 뒤에 "운행시작 되었습니다"가 도착하는 것보다
  // 안 보내는 게 낫다.
  started: [STARTED_STATUS],
  completed: [COMPLETED_STATUS],
  cancelled: [CANCELLED_STATUS],
};

async function markNotification(id, status, detail, channel) {
  // channel 컬럼이 없는 DB(마이그레이션 전)에서도 통보 자체는 나가야 한다 — 한 번 실패하면
  // 플래그를 내려 다음부터는 그 컬럼 없이 쓴다(콜마너 driver 컬럼들과 같은 방식).
  if (channel && supportsChannelColumn) {
    try {
      await db.run(
        `UPDATE kakao_order_notifications
         SET status = ?, detail = ?, channel = ?, sent_at = CASE WHEN ?::text = 'sent' THEN now() ELSE sent_at END
         WHERE id = ?`,
        [status, detail || null, channel, status, id]
      );
      return;
    } catch (e) {
      if (!e || e.code !== UNDEFINED_COLUMN) throw e;
      supportsChannelColumn = false;
    }
  }
  await db.run(
    `UPDATE kakao_order_notifications
     SET status = ?, detail = ?, sent_at = CASE WHEN ?::text = 'sent' THEN now() ELSE sent_at END
     WHERE id = ?`,
    [status, detail || null, status, id]
  );
}

// 고객이 봇 질문에 답을 쓰는 중이면 끼어들지 않고 미룬다. 법인 공유 피드(groupActivityFeed)는
// 같은 상황에서 알림을 그냥 버리는데, 배차 통보는 버리면 고객이 배차 사실을 영영 못 듣는다 —
// 우리는 durable 큐(kakao_order_notifications)가 있으니 다시 시도하는 쪽이 맞다.
// 무한히 미루면 통보가 무의미해지므로 한도를 두고, 넘으면 그냥 보낸다.
const DEFER_MINUTES = 2;
const MAX_DEFERS = 10; // 최대 20분

async function deferNotification(id, currentCount) {
  if (!supportsDeferColumn) return false;
  try {
    await db.run(
      `UPDATE kakao_order_notifications
       SET scheduled_at = now() + (?::text || ' minutes')::interval, defer_count = ?
       WHERE id = ?`,
      [String(DEFER_MINUTES), Number(currentCount || 0) + 1, id]
    );
    return true;
  } catch (e) {
    if (!e || e.code !== UNDEFINED_COLUMN) throw e;
    // 컬럼이 없으면 미룰 방법이 없다 — 예전처럼 그냥 보낸다(끼어들 수는 있지만 유실은 없다).
    supportsDeferColumn = false;
    return false;
  }
}

// 웹 세션 전달 — 대화창에 남기는 것이 곧 전달이다(고객 화면이 SSE로 받는다).
// broadcast 실패는 전달 실패로 보지 않는다: 위젯이 폴링으로도 따라잡기 때문에 메시지는 도착한다.
//
// attachments가 있으면 chat_messages.attachments_json에 넣어 렌더러가 썸네일+링크를 그린다.
// 그 컬럼이 없는 DB(마이그레이션 전)에서는 링크를 본문 뒤에 덧붙인다 — 사진을 아예 못 보는
// 것보다 링크라도 나가는 게 낫다.
async function deliverWeb(session, text, options, attachments) {
  const broadcast = options.broadcast || broadcastMessage;
  const list = Array.isArray(attachments) ? attachments : [];

  if (list.length && supportsAttachmentsColumn) {
    try {
      const inserted = await db.get(
        `INSERT INTO chat_messages (session_id, sender, message, attachments_json)
         VALUES (?, 'system', ?, ?) RETURNING *`,
        [session.id, text, JSON.stringify(list)]
      );
      Promise.resolve(broadcast(session.id, inserted))
        .catch((e) => console.error('통보(웹) 브로드캐스트 실패:', e.message));
      return { ok: true, inserted };
    } catch (e) {
      if (!e || e.code !== UNDEFINED_COLUMN) throw e;
      supportsAttachmentsColumn = false;
    }
  }

  const body = list.length
    ? `${text}\n${list.map((a) => `사진: ${a.url}`).join('\n')}`
    : text;
  const inserted = await db.get(
    `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'system', ?) RETURNING *`,
    [session.id, body]
  );
  Promise.resolve(broadcast(session.id, inserted))
    .catch((e) => console.error('통보(웹) 브로드캐스트 실패:', e.message));
  return { ok: true, inserted };
}

// 통보에 붙일 탁송사진을 고른다. 사건별로 시점이 다르다 — 운행시작은 운행전 사진,
// 운행완료는 운행후 사진. 고객 열람 권한은 화면·챗봇과 같은 설정을 그대로 쓴다
// (branch_photo_settings.client_can_view) — 화면에서 막아놓고 통보로 나가면 그 설정이 무의미해진다.
const PHOTO_PHASE_BY_EVENT = {
  started: callmanerPhotos.PHASE_START,
  completed: callmanerPhotos.PHASE_END,
};

async function loadNotifyPhotos(eventType, order) {
  const phase = PHOTO_PHASE_BY_EVENT[eventType];
  if (!phase) return [];
  if (!(await kakaoOrderPhotos.canCustomerViewPhotos(order.branch_id))) return [];
  const rows = await callmanerPhotos.loadPhotos(order.id, phase);
  return rows.slice(0, MAX_NOTIFY_PHOTOS);
}

// 카카오는 이미지를 본문과 별도 메시지로 보낸다. 본문을 먼저 보낸 뒤 사진을 붙이고, 사진이
// 실패해도 통보 자체는 성공으로 둔다 — 사진 한 장 때문에 배차 안내가 사라지면 안 된다.
async function sendKakaoPhotos(session, order, photos, options) {
  const { uploaded, failed } = await kakaoOrderPhotos.uploadPhotosToKakao(session, photos, options);
  if (!uploaded.length) return { sent: 0, failed: failed.length };
  const sendImages = options.sendImages || kakaoConsult.sendImages;
  const caption = failed.length
    ? `사진 ${photos.length}장 중 ${uploaded.length}장을 보내드립니다.`
    : `사진 ${uploaded.length}장을 보내드립니다.`;
  const result = await sendImages(session, uploaded, caption)
    .catch((e) => ({ ok: false, error: e.message }));
  return { sent: result && result.ok ? uploaded.length : 0, failed: failed.length };
}

// options.send로 발신 함수를 갈아끼울 수 있다. 검증 스크립트가 실제 중계서버로 메시지를 쏘지
// 않고도 중복방지·발송 직전 재확인·이력 저장까지 그대로 확인하기 위한 것이다 — 이 기능은
// 고객에게 직접 말을 거는 쪽이라, 확인하려다 진짜 발신이 나가는 일은 없어야 한다.
async function sendDue(options = {}) {
  const send = options.send || kakaoConsult.sendMessage;
  const due = await db.all(
    `SELECT * FROM kakao_order_notifications
     WHERE status = 'pending' AND scheduled_at <= now()
     ORDER BY scheduled_at ASC LIMIT ${SEND_BATCH_LIMIT}`
  );

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let deferred = 0;
  const byChannel = { kakao: 0, web: 0 };

  for (const notification of due) {
    const target = await loadNotifiableOrder(notification.order_id);
    if (!target) {
      await markNotification(notification.id, 'skipped', '상담 세션이 없거나 발신 키가 사라졌습니다.');
      skipped += 1;
      continue;
    }

    const setting = await loadEventSetting(target.order.branch_id, notification.event_type);
    // 예약해둔 사이에 지사가 이 통보를 껐을 수 있다.
    if (!setting.enabled) {
      await markNotification(notification.id, 'skipped', '지사 설정에서 이 통보가 꺼져 있습니다.');
      skipped += 1;
      continue;
    }

    // 미뤄둔 사이에 상황이 바뀌었을 수 있다 — 배차가 취소됐는데 "배차됐습니다"를 보내면 그게
    // 바로 오발신이다. 보내기 직전에 지금 상태를 다시 본다. 지연을 두는 사건마다 필요한 확인이라
    // 사건별로 "지금도 여전히 맞는 상태인지"를 정해둔다.
    const stillTrue = EXPECTED_STATUS_AT_SEND[notification.event_type];
    if (stillTrue && !stillTrue.includes(target.order.status)) {
      await markNotification(notification.id, 'skipped', `발송 직전 상태가 ${target.order.status}(으)로 바뀌어 보내지 않았습니다.`);
      skipped += 1;
      continue;
    }

    // 고객이 봇 질문에 답을 쓰는 중이면 끼어들지 않고 미룬다.
    if (isSessionBusy(target.session) && Number(notification.defer_count || 0) < MAX_DEFERS) {
      if (await deferNotification(notification.id, notification.defer_count)) {
        deferred += 1;
        continue;
      }
    }

    const { text, attachPhotos } = buildMessage(notification.event_type, target.order, setting);
    if (!text) {
      await markNotification(notification.id, 'skipped', '보낼 문구가 비어 있습니다.');
      skipped += 1;
      continue;
    }

    const photos = attachPhotos
      ? await loadNotifyPhotos(notification.event_type, target.order)
          .catch((e) => { console.error('통보 사진 조회 실패:', e.message); return []; })
      : [];

    let result;
    let photoDetail = null;
    try {
      if (target.channel === 'web') {
        // 웹은 첨부를 한 메시지에 함께 담는다.
        result = await deliverWeb(target.session, text, options, photos.map((p) => ({
          url: p.url,
          caption: `${p.phase === callmanerPhotos.PHASE_START ? '운행전' : '운행후'} ${p.seq}`,
        })));
      } else {
        result = await send(target.session, text);
        // 본문이 나간 뒤에만 사진을 붙인다 — 사진 실패가 본문을 막으면 안 된다.
        if (result && result.ok && photos.length) {
          const photoResult = await sendKakaoPhotos(target.session, target.order, photos, options)
            .catch((e) => ({ sent: 0, failed: photos.length, error: e.message }));
          if (photoResult.sent < photos.length) {
            photoDetail = `사진 ${photos.length}장 중 ${photoResult.sent}장 발송`;
          }
        }
      }
    } catch (e) {
      result = { ok: false, error: e.message };
    }

    if (result && result.ok) {
      await markNotification(notification.id, 'sent', photoDetail, target.channel);
      byChannel[target.channel] = (byChannel[target.channel] || 0) + 1;
      // 고객 화면에 나간 말은 상담 이력에도 남겨야 상담원이 "무엇이 이미 안내됐는지" 안다.
      // updated_at도 함께 올린다 — 상담관리 목록이 이 값으로 정렬돼서, 빼먹으면 새 메시지가
      // 오간 세션인데도 목록에서 아래로 가라앉는다(예전에 카카오 수신에서 같은 문제가 있었다).
      // 웹은 deliverWeb이 이미 넣었으므로(그게 곧 전달이다) 여기서 또 넣지 않는다.
      if (target.channel !== 'web') {
        const inserted = await db.get(
          `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'system', ?) RETURNING *`,
          [target.session.id, text]
        ).catch((e) => { console.error('통보 이력 저장 실패:', e.message); return null; });
        // 관리자 상담 화면도 실시간으로 받아야 한다 — 예전에는 이 브로드캐스트가 빠져서
        // 통보 메시지가 화면을 새로 고칠 때까지 안 보였다.
        if (inserted) {
          Promise.resolve((options.broadcast || broadcastMessage)(target.session.id, inserted))
            .catch((e) => console.error('통보(카카오) 브로드캐스트 실패:', e.message));
        }
      }
      await db.run(
        `UPDATE chat_sessions SET updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
        [target.session.id]
      ).catch((e) => console.error('세션 갱신 실패:', e.message));
      sent += 1;
    } else {
      await markNotification(notification.id, 'failed', (result && (result.error || result.message)) || '발신 실패', target.channel);
      failed += 1;
    }
  }

  return { due: due.length, sent, skipped, failed, deferred, byChannel };
}

async function runKakaoOrderNotifications(options = {}) {
  try {
    const collected = await collectFromHistory();
    const delivered = await sendDue(options);
    return { collected, delivered };
  } catch (e) {
    if (e && e.code === UNDEFINED_TABLE) {
      return { skipped: '통보 테이블이 아직 없습니다 — 마이그레이션 20260809010000을 적용해주세요.' };
    }
    throw e;
  }
}

module.exports = {
  runKakaoOrderNotifications,
  collectFromHistory,
  sendDue,
  classifyTransition,
  buildMessage,
  renderTemplate,
  loadEventSetting,
  driverKey,
  DEFAULT_EVENT_SETTINGS,
  EVENT_TYPES,
  TEMPLATE_VARIABLES,
  mergeAddress,
  DISPATCHED_STATUS,
  STARTED_STATUS,
  AWAITING_DISPATCH_STATUSES,
};
