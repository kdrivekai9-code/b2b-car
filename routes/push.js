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

router.get('/status', asyncHandler(async (req, res) => {
  const { endpoint } = req.query;
  if (!endpoint) return res.json({ subscribed: false });
  const sub = await db.get('SELECT * FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [endpoint, req.session.user.id]);
  res.json({ subscribed: !!sub, sub: sub || null });
}));

router.post('/subscribe', asyncHandler(async (req, res) => {
  const { endpoint, keys, notify_order_events, notify_driver_assign, notify_agent_call, branch_id } = req.body;
  if (!endpoint || !keys) return res.status(400).json({ error: 'invalid subscription' });
  await db.run(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, branch_id, notify_order_events, notify_driver_assign, notify_agent_call)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth,
      branch_id=excluded.branch_id, notify_order_events=excluded.notify_order_events, notify_driver_assign=excluded.notify_driver_assign,
      notify_agent_call=excluded.notify_agent_call
  `, [
    req.session.user.id, endpoint, keys.p256dh, keys.auth,
    branch_id || null, notify_order_events === false ? 0 : 1, notify_driver_assign === false ? 0 : 1,
    notify_agent_call === false ? 0 : 1,
  ]);
  res.json({ ok: true });
}));

router.post('/unsubscribe', asyncHandler(async (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) await db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [endpoint, req.session.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
