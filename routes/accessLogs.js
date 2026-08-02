const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
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