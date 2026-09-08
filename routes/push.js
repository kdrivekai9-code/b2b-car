const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requireAuth);

router.get('/vapid-public-key', (req, res) => {
  res.type('text/plain').send(process.env.VAPID_PUBLIC_KEY || '');
});

router.get('/settings/data.json', asyncHandler(async (req, res) => {
  const branches = req.session.user.role === 'admin'
    ? await db.all('SELECT * FROM branches ORDER BY name')
    : [];
  res.json({ currentUser: req.session.user, branches });
}));

router.get('/settings', asyncHandler(async (req, res) => {
  const branches = req.session.user.role === 'admin' ? await db.all('SELECT * FROM branches ORDER BY name') : [];
  res.render('push_settings', { title: '오더 알림 설정', branches });
}));

// 이 브라우저의 구독 상태.
//
// effective를 함께 준다 — "구독이 있다"와 "알림이 실제로 온다"는 다르다. 오더 알림 설정에서
// 체크를 끄고 저장하면 구독은 남고 플래그만 0이 되는데, 사이드바 버튼은 브라우저 구독 유무만
// 보고 "🔔 알림 켜짐"이라고 적고 있었다(실사용 지적 2026-09-08: 두 곳이 다른 말을 한다).
// 판정을 서버에 두는 이유는 역할마다 기준이 다르기 때문이다 — 고객에게 의미 있는 칸은
// notify_order_events 하나뿐이고, 나머지는 애초에 고객에게 보내지 않는다(lib/push.js notify).
router.get('/status', asyncHandler(async (req, res) => {
  const { endpoint } = req.query;
  if (!endpoint) return res.json({ subscribed: false, effective: false });
  const sub = await db.get('SELECT * FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [endpoint, req.session.user.id]);
  res.json({ subscribed: !!sub, effective: isEffective(req.session.user, sub), sub: sub || null });
}));

// 이 사용자에게 **실제로 알림이 갈 수 있는가**. 켜진 칸이 하나도 없으면 구독이 있어도 안 온다.
function isEffective(user, sub) {
  if (!sub) return false;
  const on = (v) => Number(v) === 1;
  if (user.role === 'client') return on(sub.notify_order_events);
  // 내부 사용자는 종류가 여럿이라 하나라도 켜져 있으면 "켜짐"이다.
  return ['notify_order_events', 'notify_driver_assign', 'notify_agent_call',
    'notify_system_alert', 'notify_plate_mismatch'].some((k) => on(sub[k]));
}

router.post('/subscribe', asyncHandler(async (req, res) => {
  const { endpoint, keys, notify_order_events, notify_driver_assign, notify_agent_call, notify_system_alert, notify_plate_mismatch, branch_id } = req.body;
  if (!endpoint || !keys) return res.status(400).json({ error: 'invalid subscription' });
  // 컬럼과 플레이스홀더 수를 손으로 맞추지 않는다.
  //
  // 2026-08-29에 notify_plate_mismatch 컬럼이 추가될 때 컬럼 목록만 늘리고 VALUES의 물음표를
  // 안 늘려서(10개 컬럼 / 8개 물음표) 이 INSERT가 42601로 항상 실패했다 — 그날부터 **아무도
  // 웹푸시를 구독할 수 없었다.** 알림이 안 오는 것은 조용해서, 남아 있는 구독 3건이 전부
  // 2026-08-03 이전 것인 걸 세어보고서야 알았다.
  //
  // 컬럼을 배열로 두고 물음표를 그 길이에서 만든다. 다음에 알림 종류가 늘어도 한 곳만 고친다.
  const COLUMNS = [
    'user_id', 'endpoint', 'p256dh', 'auth', 'branch_id',
    'notify_order_events', 'notify_driver_assign',
    'notify_agent_call', 'notify_system_alert', 'notify_plate_mismatch',
  ];
  const assignments = COLUMNS.slice(1).filter((c) => c !== 'endpoint')
    .map((c) => `${c}=excluded.${c}`).join(', ');
  await db.run(`
    INSERT INTO push_subscriptions (${COLUMNS.join(', ')})
    VALUES (${COLUMNS.map(() => '?').join(', ')})
    ON CONFLICT (endpoint) DO UPDATE SET ${assignments}
  `, [
    req.session.user.id, endpoint, keys.p256dh, keys.auth,
    branch_id || null, notify_order_events === false ? 0 : 1, notify_driver_assign === false ? 0 : 1,
    notify_agent_call === false ? 0 : 1, notify_system_alert === false ? 0 : 1,
    notify_plate_mismatch === false ? 0 : 1,
  ]);
  res.json({ ok: true });
}));

router.post('/unsubscribe', asyncHandler(async (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) await db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [endpoint, req.session.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
