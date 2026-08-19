const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { archiveOldAccessLogs, purgeArchivedAccessLogs } = require('../lib/accessLogRetention');
const appSettings = require('../lib/appSettings');
const aiUsageCounter = require('../lib/aiUsageCounter');
const {
  KEY_PER_MINUTE, KEY_PER_HOUR, DEFAULT_PER_MINUTE, DEFAULT_PER_HOUR, MAX_ALLOWED,
  NO_LIMIT, BLOCK_EVENT_TYPE,
} = require('../middleware/aiRateLimit');

// AI 사용량 제한 설정 — 이 화면에 두는 이유: 로그인 차단 기록(LOGIN_RATE_LIMITED)을 보는 자리와
// "얼마나 허용할지"를 정하는 자리가 같아야 관리자가 한 화면에서 판단할 수 있다.
async function loadAiRateLimitSettings() {
  const [perMinute, perHour, usage, blocks] = await Promise.all([
    appSettings.getNumber(KEY_PER_MINUTE, DEFAULT_PER_MINUTE, { min: 0, max: MAX_ALLOWED }),
    appSettings.getNumber(KEY_PER_HOUR, DEFAULT_PER_HOUR, { min: 0, max: MAX_ALLOWED }),
    aiUsageCounter.currentUsage({ limit: 10 }),
    loadRecentBlocks(),
  ]);

  // 남은 양을 서버에서 계산해 내려준다 — 화면마다 다시 계산하면(EJS/Next) 규칙이 갈린다.
  // 한도가 0(제한 없음)이면 "남은 양"이라는 개념 자체가 없으므로 null이다.
  const remaining = (limit, used) => (limit === NO_LIMIT ? null : Math.max(0, limit - used));
  const rows = usage.map((u) => ({
    ...u,
    minuteRemaining: remaining(perMinute, u.minute),
    hourRemaining: remaining(perHour, u.hour),
    // 어느 한 창이라도 한도에 닿았으면 지금 막히는 중이다.
    blocked: (perMinute !== NO_LIMIT && u.minute >= perMinute) || (perHour !== NO_LIMIT && u.hour >= perHour),
  }));

  return {
    perMinute, perHour,
    defaultPerMinute: DEFAULT_PER_MINUTE,
    defaultPerHour: DEFAULT_PER_HOUR,
    cacheSeconds: Math.round(appSettings.CACHE_TTL_MS / 1000),
    usage: rows,
    blocks,
    blockEventType: BLOCK_EVENT_TYPE,
  };
}

// 차단이 실제로 일어났는지 — 접속기록에 남긴 것을 세어 보여준다(같은 화면 안에서 확인 가능).
async function loadRecentBlocks() {
  const row = await db.get(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour') AS last_hour,
            to_char(MAX(created_at) at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') AS last_at
       FROM access_logs
      WHERE event_type = ? AND created_at > now() - interval '24 hours'`,
    [BLOCK_EVENT_TYPE]
  ).catch((e) => {
    console.error('AI 차단 기록 조회 실패:', e.message);
    return null;
  });
  return {
    last24h: row ? Number(row.total) || 0 : 0,
    lastHour: row ? Number(row.last_hour) || 0 : 0,
    lastAt: (row && row.last_at) || null,
  };
}

const router = express.Router();

// 보관 정책 크론 — 세션 로그인 사용자가 없는 서버 대 서버 호출이라 별도 라우터로 뺀다.
// 아래 router.use(requireAuth)에 걸리면 크론이 로그인 화면으로 리다이렉트된다(routes/chat.js와 같은 이유).
function checkCronAuth(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: 'CRON_SECRET 환경변수가 설정되어 있지 않습니다.' });
  if (req.get('Authorization') !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const cronRouter = express.Router();
// 하루 한 번 돈다. 보관 기간을 넘긴 행을 아카이브로 옮기고, 남은 건수를 함께 돌려준다 —
// 한 번에 다 못 옮기면(배치 상한) 다음 실행이 이어간다.
cronRouter.get('/cron/archive', checkCronAuth, asyncHandler(async (req, res) => {
  // 순서가 중요하다: 먼저 오래된 것을 아카이브로 옮기고, 그다음 아카이브에서 상한을 넘긴 것을
  // 지운다. 반대로 하면 방금 옮긴 행이 같은 실행에서 지워질 수 있다(설정에 따라).
  const archived = await archiveOldAccessLogs();
  const purged = await purgeArchivedAccessLogs();
  res.json({ archived, purged });
}));

router.use(requireAuth, requireRole('admin'));

router.get('/data.json', asyncHandler(async (req, res) => {
  const filters = {
    account: String(req.query.account || '').trim(),
    event_type: String(req.query.event_type || '').trim(),
    from: String(req.query.from || '').trim(),
    to: String(req.query.to || '').trim(),
  };
  const where = [];
  const params = [];
  if (filters.account) { where.push('account ILIKE ?'); params.push(`%${filters.account}%`); }
  if (filters.event_type) { where.push('event_type = ?'); params.push(filters.event_type); }
  if (filters.from) { where.push('created_at >= ?::date'); params.push(filters.from); }
  if (filters.to) { where.push("created_at < (?::date + interval '1 day')"); params.push(filters.to); }

  const logs = await db.all(
    `SELECT id, account, event_type, work_detail, subject_info, ip_address, success,
            to_char(created_at at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') AS accessed_at
     FROM access_logs
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC
     LIMIT 1000`,
    params
  );
  res.json({ currentUser: req.session.user, logs, filters, aiRateLimit: await loadAiRateLimitSettings() });
}));

router.get('/', asyncHandler(async (req, res) => {
  const filters = {
    account: String(req.query.account || '').trim(),
    event_type: String(req.query.event_type || '').trim(),
    from: String(req.query.from || '').trim(),
    to: String(req.query.to || '').trim(),
  };
  const where = [];
  const params = [];
  if (filters.account) {
    where.push('account ILIKE ?');
    params.push(`%${filters.account}%`);
  }
  if (filters.event_type) {
    where.push('event_type = ?');
    params.push(filters.event_type);
  }
  if (filters.from) {
    where.push('created_at >= ?::date');
    params.push(filters.from);
  }
  if (filters.to) {
    where.push("created_at < (?::date + interval '1 day')");
    params.push(filters.to);
  }

  const logs = await db.all(
    `SELECT id, account, event_type, work_detail, subject_info, ip_address, success,
            to_char(created_at at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') AS accessed_at
     FROM access_logs
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC
     LIMIT 1000`,
    params
  );
  res.render('access_logs/list', {
    title: '접속기록', logs, filters,
    aiRateLimit: await loadAiRateLimitSettings(),
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
}));

// AI 사용량 제한 저장. 0은 "제한 없음"이다 — 사고가 났을 때 배포 없이 즉시 풀 수 있어야 한다.
router.post('/ai-rate-limit', asyncHandler(async (req, res) => {
  const base = '/access-logs';
  const perMinute = Number(req.body.per_minute);
  const perHour = Number(req.body.per_hour);
  const bad = (msg) => res.redirect(base + '?error=' + encodeURIComponent(msg));

  if (!Number.isInteger(perMinute) || perMinute < 0 || perMinute > MAX_ALLOWED) {
    return bad(`분당 한도는 0~${MAX_ALLOWED} 사이의 정수로 입력해주세요(0은 제한 없음).`);
  }
  if (!Number.isInteger(perHour) || perHour < 0 || perHour > MAX_ALLOWED) {
    return bad(`시간당 한도는 0~${MAX_ALLOWED} 사이의 정수로 입력해주세요(0은 제한 없음).`);
  }
  // 시간당이 분당보다 작으면 분당 한도가 아무 의미가 없다 — 관리자가 알아채기 어려운 실수라 막는다.
  if (perHour !== 0 && perMinute !== 0 && perHour < perMinute) {
    return bad('시간당 한도는 분당 한도보다 작을 수 없습니다.');
  }

  await appSettings.set(KEY_PER_MINUTE, perMinute, req.session.user.id);
  await appSettings.set(KEY_PER_HOUR, perHour, req.session.user.id);
  res.redirect(base + '?notice=' + encodeURIComponent('AI 사용량 제한을 저장했습니다.'));
}));

module.exports = router;
module.exports.cronRouter = cronRouter;