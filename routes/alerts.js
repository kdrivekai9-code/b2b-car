// 시스템 장애 알림 크론 + 발송 이력 화면.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const systemAlert = require('../lib/systemAlert');
const appSettings = require('../lib/appSettings');

// 화면에서 고칠 수 있는 임계값. lib/systemAlert.js의 SETTINGS와 키·범위가 같아야 한다 —
// 갈리면 화면에서 저장한 값이 범위 밖이라 조용히 무시된다.
const SETTING_FIELDS = Object.entries(systemAlert.SETTINGS).map(([name, [key, , min, max]]) => ({
  name, key, min, max,
  label: {
    errorWindowMin: '오류 관측 구간(분)',
    errorThreshold: '오류 임계(건)',
    cooldownMin: '재알림 간격(분)',
    backlogPercent: '백로그 기준(%)',
    stalledMin: '동기화 정지 기준(분)',
    timeBudgetThreshold: '시간 초과 임계(회)',
  }[name] || name,
}));

const router = express.Router();
// 크론은 세션 로그인이 없는 서버 대 서버 호출이라, requireAuth보다 **먼저** 마운트해야 한다.
// 그래서 라우터를 분리한다 — 한 라우터에 담으면 /alerts 화면까지 인증 없이 열리거나,
// 반대로 크론이 로그인 화면으로 302된다(실제로 302가 났다).
const cronRouter = express.Router();

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

cronRouter.get('/cron/check', checkCronAuth, asyncHandler(async (req, res) => {
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
    // 화면에서 바로 고칠 수 있도록 키·범위를 함께 넘긴다. 임계는 장애 중에 조정하고 싶은
    // 값이라(시끄러우면 올리고, 놓쳤으면 내리고) 배포를 기다리게 하면 안 된다.
    settingFields: SETTING_FIELDS.map((f) => ({ ...f, value: cfg[f.name] })),
    syncLimit: Number(process.env.CALLMANER_SYNC_ORDER_LIMIT || 500),
    tested: req.query.tested === '1',
    saved: req.query.saved === '1',
    error: req.query.error || null,
  });
}));

// 알림이 실제로 내 폰까지 오는지 확인하는 버튼. 장애가 났을 때 처음 시험해보면 늦다.
// 임계값 저장. 환경변수가 아니라 app_settings(DB)에 넣는다 — 즉시 반영되고 배포가 필요 없다.
router.post('/settings', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  for (const f of SETTING_FIELDS) {
    const raw = String(req.body[f.key] ?? '').trim();
    if (raw === '') continue;
    const n = Number(raw);
    // 범위를 벗어난 값은 저장하지 않고 넘어간다 — appSettings.getNumber가 범위 밖 값을
    // fallback으로 되돌리므로, 저장해두면 화면에는 내가 넣은 값이 보이는데 실제로는 기본값이
    // 동작하는 상태가 된다(가장 헷갈리는 실패다).
    if (!Number.isFinite(n) || n < f.min || n > f.max) {
      return res.redirect('/alerts?error=' + encodeURIComponent(`${f.label}은(는) ${f.min}~${f.max} 사이여야 합니다.`));
    }
    await appSettings.set(f.key, n, req.session.user.id);
  }
  res.redirect('/alerts?saved=1');
}));

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
  const syncLimit = Number(process.env.CALLMANER_SYNC_ORDER_LIMIT || 500);
  const alerts = [
    ...await systemAlert.checkErrorSpikes(cfg),
    ...await systemAlert.checkSyncBacklog(cfg, syncLimit),
    ...await systemAlert.checkSyncTimeBudget(cfg),
    ...await systemAlert.checkSyncStalled(cfg),
  ];
  res.json({ config: cfg, syncLimit, alerts });
}));

module.exports = { router, cronRouter };
