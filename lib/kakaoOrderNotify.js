// 카카오 상담톡 능동 통보 — 배차 완료 / 배차 취소.
//
// Phase 2의 첫 조각이다. 지금까지 고객은 "배차됐나요?"를 직접 물어야 했고, 상담원 발화의 29.7%가
// 그 답이었다. 상태가 바뀐 걸 우리가 먼저 알려주면 그 질문 자체가 사라진다.
//
// 다루는 사건은 둘뿐이다.
//   dispatched         — 기사 배차 완료
//   dispatch_cancelled — 배차받은 기사가 취소해서 다시 배차를 찾는 중
//
// 상태를 바꾸는 지점은 세 곳이다(콜마너 전체조회 / conf_slip 단건조회 / 관리자 수동 변경).
// 그 셋에 각각 통보 코드를 심는 대신 order_status_history를 읽어 전이를 찾는다 — 셋 다 이미
// 거기에 남기고 있어서, 나중에 상태를 바꾸는 경로가 하나 더 생겨도 통보가 저절로 따라온다.
const db = require('../db');
const kakaoConsult = require('./kakaoConsult');

const DISPATCHED_STATUS = '기사배정';
// 배차 상태에서 이 중 하나로 되돌아가면 "기사가 취소해 다시 배차를 찾는 중"이다.
// 완료/취소는 제외한다 — 오더가 끝난 것이지 배차가 취소된 게 아니다.
const AWAITING_DISPATCH_STATUSES = new Set(['접수', '대기', '예약']);

// 배차 통보를 이만큼 미뤘다가 보낸다. 배차 직후 취소되는 경우가 있어서, 바로 보내면 고객에게
// "배차됐습니다" 다음에 곧장 "취소됐습니다"가 이어진다.
const DISPATCH_NOTICE_DELAY_MS = 60 * 1000;

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

function driverLine(order) {
  const name = String(order.callmaner_driver_name || '').trim();
  const phone = String(order.callmaner_driver_phone || '').trim();
  if (!name && !phone) return null;
  if (name && phone) return `기사: ${name} (${phone})`;
  return `기사: ${name || phone}`;
}

function buildMessage(eventType, order) {
  const oid = String(order.oid || '').trim();
  const head = oid ? `[${oid}] ` : '';
  if (eventType === 'dispatched') {
    return [`${head}배차가 완료되었습니다.`, driverLine(order)].filter(Boolean).join('\n');
  }
  // 문구는 사용자가 지정한 대로다 — 고객에게는 "누가 취소했는지"보다 "지금 다시 배차 중"이
  // 중요하다.
  return `${head}배차받은 기사님이 취소하였고, 다른 기사님께 배차 진행중입니다.`;
}

// 상태 전이 하나를 보고 어떤 통보가 필요한지 판정한다. DB 없이 확인할 수 있도록 따로 뺐다
// (scripts/check-kakao-order-notify.js) — 여기가 틀리면 엉뚱한 사람에게 엉뚱한 안내가 나간다.
//
// 완료/취소로 끝난 오더는 배차 취소가 아니다. 오더 자체가 끝난 것을 "다른 기사님께 배차
// 진행중"이라고 안내하면 고객은 오지 않을 기사를 기다린다.
function classifyTransition(oldStatus, newStatus) {
  if (!oldStatus || !newStatus) return null;
  const wasDispatched = oldStatus === DISPATCHED_STATUS;
  const isDispatched = newStatus === DISPATCHED_STATUS;
  if (!wasDispatched && isDispatched) return 'dispatched';
  if (wasDispatched && AWAITING_DISPATCH_STATUSES.has(newStatus)) return 'dispatch_cancelled';
  return null;
}

// 통보 대상인지 — 카카오로 접수돼 발신 키가 살아 있는 오더만.
async function loadNotifiableOrder(orderId) {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order || !order.chat_session_id) return null;
  const session = await db.get('SELECT * FROM chat_sessions WHERE id = ?', [order.chat_session_id]);
  if (!session || !kakaoConsult.isConfigured(session)) return null;
  return { order, session };
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
  for (const row of rows) {
    const eventType = classifyTransition(row.old_status, row.new_status);
    if (!eventType) continue;

    const target = await loadNotifiableOrder(row.order_id);
    if (!target) continue;

    // 배차 통보만 미룬다. 취소 안내는 고객이 기다리고 있는 상황이라 곧바로 보낸다.
    const delayMs = eventType === 'dispatched' ? DISPATCH_NOTICE_DELAY_MS : 0;
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
  return { scanned: rows.length, scheduled, cursor: nextCursor };
}

// ---------------- 발송 ----------------

async function markNotification(id, status, detail) {
  await db.run(
    `UPDATE kakao_order_notifications
     SET status = ?, detail = ?, sent_at = CASE WHEN ?::text = 'sent' THEN now() ELSE sent_at END
     WHERE id = ?`,
    [status, detail || null, status, id]
  );
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

  for (const notification of due) {
    const target = await loadNotifiableOrder(notification.order_id);
    if (!target) {
      await markNotification(notification.id, 'skipped', '카카오 세션이 없거나 발신 키가 사라졌습니다.');
      skipped += 1;
      continue;
    }

    // 미뤄둔 1분 사이에 상황이 바뀌었을 수 있다 — 배차가 취소됐는데 "배차됐습니다"를 보내면
    // 그게 바로 오발신이다. 보내기 직전에 지금 상태를 다시 본다.
    if (notification.event_type === 'dispatched' && target.order.status !== DISPATCHED_STATUS) {
      await markNotification(notification.id, 'skipped', `발송 직전 상태가 ${target.order.status}(으)로 바뀌어 보내지 않았습니다.`);
      skipped += 1;
      continue;
    }

    const text = buildMessage(notification.event_type, target.order);
    let result;
    try {
      result = await send(target.session, text);
    } catch (e) {
      result = { ok: false, error: e.message };
    }

    if (result && result.ok) {
      await markNotification(notification.id, 'sent', null);
      // 고객 화면에 나간 말은 상담 이력에도 남겨야 상담원이 "무엇이 이미 안내됐는지" 안다.
      // updated_at도 함께 올린다 — 상담관리 목록이 이 값으로 정렬돼서, 빼먹으면 새 메시지가
      // 오간 세션인데도 목록에서 아래로 가라앉는다(예전에 카카오 수신에서 같은 문제가 있었다).
      await db.run(
        `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'system', ?)`,
        [target.session.id, text]
      ).catch((e) => console.error('통보 이력 저장 실패:', e.message));
      await db.run(
        `UPDATE chat_sessions SET updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
        [target.session.id]
      ).catch((e) => console.error('세션 갱신 실패:', e.message));
      sent += 1;
    } else {
      await markNotification(notification.id, 'failed', (result && (result.error || result.message)) || '발신 실패');
      failed += 1;
    }
  }

  return { due: due.length, sent, skipped, failed };
}

// 마이그레이션(20260809010000)을 아직 적용하지 않은 DB에서도 크론이 조용히 지나가게 한다.
// 안 그러면 매분 도는 크론이 매번 500을 내면서 로그를 채우고, 정작 봐야 할 실패가 묻힌다.
// 콜마너 동기화가 callmaner_driver_* 컬럼에 대해 쓰는 폴백과 같은 취지다.
const UNDEFINED_TABLE = '42P01';

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
  driverKey,
  DISPATCH_NOTICE_DELAY_MS,
  DISPATCHED_STATUS,
  AWAITING_DISPATCH_STATUSES,
};
