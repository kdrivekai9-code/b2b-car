const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { archiveOldAccessLogs, purgeArchivedAccessLogs } = require('../lib/accessLogRetention');

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
  res.json({ currentUser: req.session.user, logs, filters });
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
  res.render('access_logs/list', { title: '접속기록', logs, filters });
}));

module.exports = router;
module.exports.cronRouter = cronRouter;