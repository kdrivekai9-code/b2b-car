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
async function notify({ branchId, eventType, excludeUserId, title, body, url }) {
  if (!process.env.VAPID_PUBLIC_KEY) return; // 미설정 환경(로컬 등)에서는 조용히 건너뜀
  ensureConfigured();

  // 상담원 호출은 특정 지사에 매이지 않고 opt-in한 관리자 전원에게 즉시 알린다(지사 범위 필터 없음).
  let subs;
  if (eventType === 'agent_call') {
    subs = await db.all(
      `SELECT * FROM push_subscriptions WHERE notify_agent_call = 1 AND user_id != ?`,
      [excludeUserId]
    );
  } else {
    const column = eventType === 'driver_assign' ? 'notify_driver_assign' : 'notify_order_events';
    subs = await db.all(
      `SELECT * FROM push_subscriptions
       WHERE (branch_id IS NULL OR branch_id = ?) AND ${column} = 1 AND user_id != ?`,
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

module.exports = { notify };
