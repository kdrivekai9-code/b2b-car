// 시스템 장애 알림 크론 + 발송 이력 화면.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const systemAlert = require('../lib/systemAlert');

const router = express.Router();

// 크론 인증은 콜마너 동기화(routes/callmanerSync.js)와 같은 방식을 쓴다 — 인증 규칙이 두 벌이면
// 한쪽만 고쳐져 크론 엔드포인트가 열린 채 남는다.
function checkCronAuth(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return next(); // 미설정 환경(로컬)에서는 그대로 통과
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.secret || '');
  if (token !== secret) return res.status(401).json({ error: 'unauthorized' });
  return next();
}

router.get('/cron/check', checkCronAuth, asyncHandler(async (req, res) => {
  const result = await systemAlert.runChecks();
  res.json(result);
}));

// 실제로 알림이 나갔는지 확인하는 화면. 이게 없으면 "장애였는데 알림이 왔었나?"를 되짚지 못해
// 이 장치 자체를 믿을 수 없다.
router.get('/', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const [logs, states, cfg] = await Promise.all([
    db.all('SELECT * FROM system_alert_log ORDER BY id DESC LIMIT 100').catch(() => null),
    db.all('SELECT * FROM system_alert_state ORDER BY last_sent_at DESC').catch(() => []),
    systemAlert.loadSettings(),
  ]);
  res.render('alerts/index', {
    title: '장애 알림',
    logs: logs || [],
    migrationMissing: logs === null,
    states: states || [],
    cfg,
    syncLimit: Number(process.env.CALLMANER_SYNC_ORDER_LIMIT || 200),
    tested: req.query.tested === '1',
  });
}));

// 알림이 실제로 내 폰까지 오는지 확인하는 버튼. 장애가 났을 때 처음 시험해보면 늦다.
router.post('/test', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { notify } = require('../lib/push');
  await notify({
    branchId: null, eventType: 'system_alert', excludeUserId: 0,
    title: '🔔 장애 알림 테스트',
    body: '이 알림이 보이면 장애 알림이 정상 동작합니다.',
    url: '/alerts',
  });
  res.redirect('/alerts?tested=1');
}));

// 지금 무엇이 걸리는지 즉시 확인(발송 없이). 임계값을 조정할 때 쓴다.
router.get('/dry-run', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const cfg = await systemAlert.loadSettings();
  const syncLimit = Number(process.env.CALLMANER_SYNC_ORDER_LIMIT || 200);
  const alerts = [
    ...await systemAlert.checkErrorSpikes(cfg),
    ...await systemAlert.checkSyncBacklog(cfg, syncLimit),
    ...await systemAlert.checkSyncStalled(cfg),
  ];
  res.json({ config: cfg, syncLimit, alerts });
}));

module.exports = router;
