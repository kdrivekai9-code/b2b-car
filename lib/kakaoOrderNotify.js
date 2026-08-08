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

// 마이그레이션을 아직 적용하지 않은 DB에서도 크론이 조용히 지나가게 한다. 안 그러면 매분 도는
// 크론이 매번 500을 내면서 로그를 채우고, 정작 봐야 할 실패가 묻힌다. 콜마너 동기화가
// callmaner_driver_* 컬럼에 대해 쓰는 폴백과 같은 취지다.
const UNDEFINED_TABLE = '42P01';

const DISPATCHED_STATUS = '기사배정';
const COMPLETED_STATUS = '완료';
const CANCELLED_STATUS = '취소';
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
    delayMinutes: 1,
    template: '[{oid}] 배차가 완료되었습니다.\n기사: {driver_name} ({driver_phone})',
  },
  completed: {
    label: '운행완료',
    enabled: true,
    delayMinutes: 0,
    template: '[{oid}] 운행이 완료되었습니다. 이용해주셔서 감사합니다.',
  },
  dispatch_cancelled: {
    label: '배차취소',
    enabled: true,
    delayMinutes: 0,
    template: '[{oid}] 배차받은 기사님이 취소하였고, 다른 기사님께 배차 진행중입니다.',
  },
  cancelled: {
    label: '오더취소',
    enabled: true,
    delayMinutes: 0,
    template: '[{oid}] 오더가 취소되었습니다. 문의사항은 상담원에게 말씀해주세요.',
  },
};

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
      'SELECT enabled, delay_minutes, message_template FROM branch_customer_notifications WHERE branch_id = ? AND event_type = ?',
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
  };
}

// 문구 템플릿 치환. 값이 없는 자리는 빈 문자열로 지우고, 그 때문에 생긴 빈 괄호나 "기사: " 같은
// 껍데기도 함께 정리한다 — 기사 정보가 안 들어온 상태에서 "기사:  ()"가 고객에게 나가면 안 된다.
function renderTemplate(template, order) {
  const values = {
    oid: String(order.oid || '').trim(),
    driver_name: String(order.callmaner_driver_name || '').trim(),
    driver_phone: String(order.callmaner_driver_phone || '').trim(),
    origin: String(order.origin_address || '').trim(),
    destination: String(order.destination_address || '').trim(),
    reserved_at: [order.reserved_date, order.reserved_time].filter(Boolean).join(' ').trim(),
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
    // 치환 결과가 라벨만 남은 줄(예: "기사:")은 통째로 버린다.
    .filter((line) => line && !/^[^:]{1,10}:$/.test(line))
    .join('\n');
}

function buildMessage(eventType, order, setting) {
  const resolved = setting || DEFAULT_EVENT_SETTINGS[eventType];
  return renderTemplate(resolved && resolved.template, order);
}

// 상태 전이 하나를 보고 어떤 통보가 필요한지 판정한다. DB 없이 확인할 수 있도록 따로 뺐다
// (scripts/check-kakao-order-notify.js) — 여기가 틀리면 엉뚱한 사람에게 엉뚱한 안내가 나간다.
//
// 완료/취소로 끝난 오더는 배차 취소가 아니다. 오더 자체가 끝난 것을 "다른 기사님께 배차
// 진행중"이라고 안내하면 고객은 오지 않을 기사를 기다린다.
function classifyTransition(oldStatus, newStatus) {
  if (!oldStatus || !newStatus) return null;
  if (oldStatus === newStatus) return null;

  const wasDispatched = oldStatus === DISPATCHED_STATUS;
  if (newStatus === DISPATCHED_STATUS) return wasDispatched ? null : 'dispatched';
  if (newStatus === COMPLETED_STATUS) return 'completed';
  if (newStatus === CANCELLED_STATUS) return 'cancelled';
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
  dispatched: [DISPATCHED_STATUS],
  completed: [COMPLETED_STATUS],
  cancelled: [CANCELLED_STATUS],
};

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

    const text = buildMessage(notification.event_type, target.order, setting);
    if (!text) {
      await markNotification(notification.id, 'skipped', '보낼 문구가 비어 있습니다.');
      skipped += 1;
      continue;
    }
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
  DISPATCHED_STATUS,
  AWAITING_DISPATCH_STATUSES,
};
