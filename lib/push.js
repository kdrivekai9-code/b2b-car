// 브라우저 푸시 알림 발송 헬퍼 (Web Push, VAPID — 무료, 별도 API 키/과금 불필요)
const webpush = require('web-push');
const db = require('../db');

let configured = false;
function ensureConfigured() {
  if (configured) return;
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    throw new Error('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 환경변수가 필요합니다.');
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  configured = true;
}

// eventType: 'order_events' | 'driver_assign' | 'agent_call'
// 고객 한 사람에게 보낸다 — 자기 오더 통보용.
//
// 왜 따로 두나: 위 notify()는 지사·이벤트 단위로 **관리자에게** 보내도록 짜여 있다
// (notify_agent_call, notify_order_events 같은 칸을 지사 범위와 함께 본다). 고객은 지사가
// 아니라 자기 오더가 기준이라 그 조건을 재사용할 수 없다.
//
// 왜 필요한가(실사용 지적 2026-09-08): 웹 통보는 상담창에 꽂히는데, 창을 열지 않으면 도착한
// 줄을 모른다. 안읽음 배지를 붙였지만 그것도 화면을 열어야 보인다. 카카오는 앱 알림이 저절로
// 뜨는데 웹은 그게 없었다.
//
// 실패해도 통보 자체를 막지 않는다. 브라우저 알림은 덤이고, 상담창 메시지가 본체다.
// 고객이 고른 종류만 남긴다.
//
// event_types는 켤 종류를 쉼표로 이은 값이다. NULL이나 빈 값은 **전부 켜짐** — 이미 있는
// 구독이 그대로 동작해야 하고(마이그레이션 전 데이터 포함), "고르지 않았다"의 자연스러운
// 뜻이다. eventType을 안 넘긴 호출부는 종류를 가리지 않는다(예전 동작).
function wantsEvent(sub, eventType) {
  if (!eventType) return true;
  const raw = String((sub && sub.event_types) || '').trim();
  if (!raw) return true;
  return raw.split(',').map((v) => v.trim()).filter(Boolean).includes(String(eventType));
}

async function notifyUser({ userId, eventType, title, body, url }) {
  if (!process.env.VAPID_PUBLIC_KEY) return { sent: 0, skipped: 'not_configured' };
  if (!userId) return { sent: 0, skipped: 'no_user' };
  ensureConfigured();

  // 고객이 오더 알림 설정에서 켠 구독만. notify_order_events를 재사용한다 — 고객에게는
  // 알림 종류가 하나뿐이라 칸을 새로 만들 이유가 없다(마이그레이션 없이 동작한다).
  const subs = await db.all(
    'SELECT * FROM push_subscriptions WHERE user_id = ? AND notify_order_events = 1',
    [userId]
  ).catch((e) => {
    console.error('고객 푸시 대상 조회 실패:', e.message);
    return [];
  });
  if (!subs.length) return { sent: 0, skipped: 'no_subscription' };

  // 종류별 선택을 적용한다. 컬럼이 없는 DB(마이그레이션 전)에서는 event_types가 undefined라
  // wantsEvent가 전부 통과시킨다 — 알림이 조용히 사라지지 않는다.
  const wanted = subs.filter((sub) => wantsEvent(sub, eventType));
  if (!wanted.length) return { sent: 0, skipped: 'event_off' };

  const payload = JSON.stringify({ title, body, url: url || '/orders/ai-intake' });
  let sent = 0;
  // 구독마다 독립적인 외부 요청이라 서로 기다릴 필요가 없다(위 notify()와 같은 이유).
  await Promise.all(wanted.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      sent += 1;
    } catch (err) {
      // 만료된 기기는 지운다 — 안 지우면 영원히 재시도한다.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await db.run('DELETE FROM push_subscriptions WHERE id = ?', [sub.id]).catch(() => {});
      } else {
        console.error('고객 푸시 발송 실패:', err.message);
      }
    }
  }));
  return { sent, total: subs.length };
}

// 이 알림들을 받을 수 있는 사람 — **내부 사용자만**이다.
//
// 왜 조건이 필요한가(실측 2026-09-08): 여기에 역할 조건이 없어서 고객 구독이 내부 알림
// 전부에 잡히고 있었다. 실제 데이터로 확인했다 — 고객(seoulmotors) 구독 2건이 상담원 호출·
// 시스템 장애·번호판 상이·지사 오더 등록/수정 대상에 모두 들어 있었다.
//
// 왜 그렇게 됐나: 고객 설정 화면에는 체크박스가 하나뿐이라(내 오더 진행 알림) 나머지 칸을
// 끌 방법이 없고, 서버는 지정되지 않은 칸을 켜짐으로 저장한다(`=== false ? 0 : 1`).
// 그래서 고객 구독은 모든 플래그가 1로 남는다. 칸을 끄는 UI를 더하는 것으로는 못 막는다 —
// 애초에 받을 대상이 아니다.
//
// 무엇이 새는 문제였나: "🚨 상담원 호출"(다른 고객의 상담 요청), 시스템 장애(연동 오류),
// 번호판 상이(다른 오더의 차량번호), 지사 범위 오더 등록/수정(남의 오더). 고객에게 갈 값이
// 아니다. 고객용 알림은 notifyUser가 자기 오더만 골라 따로 보낸다.
const INTERNAL_ROLES = "('admin', 'branch_manager')";

async function notify({ branchId, eventType, excludeUserId, title, body, url }) {
  if (!process.env.VAPID_PUBLIC_KEY) return; // 미설정 환경(로컬 등)에서는 조용히 건너뜀
  ensureConfigured();

  // 상담원 호출은 특정 지사에 매이지 않고 opt-in한 관리자 전원에게 즉시 알린다(지사 범위 필터 없음).
  let subs;
  if (eventType === 'agent_call') {
    subs = await db.all(
      `SELECT p.* FROM push_subscriptions p JOIN users u ON u.id = p.user_id
        WHERE u.role IN ${INTERNAL_ROLES} AND p.notify_agent_call = 1 AND p.user_id != ?`,
      [excludeUserId]
    );
  } else if (eventType === 'plate_mismatch') {
    // 번호판 상이는 해당 지사 관리자에게 간다 — 현장에서 바로 확인해야 하는 사건이다.
    subs = await db.all(
      `SELECT p.* FROM push_subscriptions p JOIN users u ON u.id = p.user_id
        WHERE u.role IN ${INTERNAL_ROLES}
          AND (p.branch_id IS NULL OR p.branch_id = ?) AND p.notify_plate_mismatch = 1 AND p.user_id != ?`,
      [branchId, excludeUserId]
    ).catch((e) => {
      if (!e || e.code !== '42703') throw e;
      console.error('번호판 상이 알림 대상 조회 실패(마이그레이션 미적용):', e.message);
      return [];
    });
  } else if (eventType === 'system_alert') {
    // 장애 알림도 지사에 매이지 않는다 — 시스템 전체가 멈춘 상황이라 범위를 좁힐 이유가 없다.
    // 컬럼이 없으면(마이그레이션 20260829020000 전) 알림 자체를 건너뛴다. 다른 알림은 계속 나가야 한다.
    subs = await db.all(
      `SELECT p.* FROM push_subscriptions p JOIN users u ON u.id = p.user_id
        WHERE u.role IN ${INTERNAL_ROLES} AND p.notify_system_alert = 1`
    ).catch((e) => {
      if (!e || e.code !== '42703') throw e;
      console.error('장애 알림 대상 조회 실패(마이그레이션 미적용):', e.message);
      return [];
    });
  } else {
    const column = eventType === 'driver_assign' ? 'notify_driver_assign' : 'notify_order_events';
    subs = await db.all(
      `SELECT p.* FROM push_subscriptions p JOIN users u ON u.id = p.user_id
        WHERE u.role IN ${INTERNAL_ROLES}
          AND (p.branch_id IS NULL OR p.branch_id = ?) AND p.${column} = 1 AND p.user_id != ?`,
      [branchId, excludeUserId]
    );
  }

  const payload = JSON.stringify({ title, body, url: url || '/' });
  // 구독자마다 별도의 외부 푸시 서비스로 나가는 독립적인 요청이라 서로 기다릴 필요가 없다 —
  // 순차로 하나씩 보내면 구독자 수만큼 왕복시간이 그대로 곱연산돼서, 이 함수를 await하는
  // 호출부(오더 등록 등)의 응답이 구독자가 많을수록 느려졌다.
  await Promise.all(subs.map(async (sub) => {
    const pushSubscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    try {
      await webpush.sendNotification(pushSubscription, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await db.run('DELETE FROM push_subscriptions WHERE id = ?', [sub.id]);
      } else {
        console.error('푸시 발송 실패:', err.message);
      }
    }
  }));
}

module.exports = { notify, notifyUser, wantsEvent };
