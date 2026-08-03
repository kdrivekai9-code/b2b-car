const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get('/data.json', asyncHandler(async (req, res) => {
  const users = await db.all(`
    SELECT u.id, u.login_id, u.name, u.phone, u.role, u.grade, u.status, u.branch_id, u.group_id,
           b.name AS branch_name, g.name AS group_name,
           (u.active_session_hash IS NOT NULL AND u.active_session_expires_at > now()) AS is_logged_in
    FROM users u
    LEFT JOIN branches b ON b.id = u.branch_id
    LEFT JOIN groups_tbl g ON g.id = u.group_id
    ORDER BY u.id
  `);
  res.json({ currentUser: req.session.user, users });
}));

router.get('/', asyncHandler(async (req, res) => {
  const users = await db.all(`
    SELECT u.*, b.name AS branch_name, g.name AS group_name,
           (u.active_session_hash IS NOT NULL AND u.active_session_expires_at > now()) AS is_logged_in
    FROM users u
    LEFT JOIN branches b ON b.id = u.branch_id
    LEFT JOIN groups_tbl g ON g.id = u.group_id
    ORDER BY u.id
  `);
  res.render('users/list', { title: '사용자 관리', users });
}));

router.post('/:id/revoke-session', asyncHandler(async (req, res) => {
  await db.run(
    'UPDATE users SET active_session_hash = NULL, active_session_expires_at = NULL WHERE id = ?',
    [req.params.id]
  );
  res.redirect('/users');
}));

router.get('/new/data.json', asyncHandler(async (req, res) => {
  const [branches, groups] = await Promise.all([
    db.all("SELECT * FROM branches WHERE status='active' ORDER BY name"),
    db.all('SELECT * FROM groups_tbl ORDER BY name'),
  ]);
  res.json({ currentUser: req.session.user, branches, groups });
}));

router.get('/new', asyncHandler(async (req, res) => {
  const [branches, groups] = await Promise.all([
    db.all("SELECT * FROM branches WHERE status='active' ORDER BY name"),
    db.all('SELECT * FROM groups_tbl ORDER BY name'),
  ]);
  res.render('users/form', { title: '사용자 등록', user: {}, branches, groups, mode: 'create' });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { login_id, password, name, phone, role, branch_id, group_id, grade } = req.body;
  const hash = await bcrypt.hash(password || '1234', 10);
  await db.run(
    `INSERT INTO users (login_id, password_hash, name, phone, role, branch_id, group_id, grade, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    [login_id, hash, name, phone, role, branch_id || null, group_id || null, role === 'client' ? grade : null]
  );
  res.redirect('/users');
}));

router.get('/:id/edit/data.json', asyncHandler(async (req, res) => {
  const [user, branches, groups] = await Promise.all([
    db.get('SELECT * FROM users WHERE id = ?', [req.params.id]),
    db.all('SELECT * FROM branches ORDER BY name'),
    db.all('SELECT * FROM groups_tbl ORDER BY name'),
  ]);
  if (!user) return res.status(404).json({ error: 'not_found' });
  res.json({ currentUser: req.session.user, user, branches, groups });
}));

router.get('/:id/edit', asyncHandler(async (req, res) => {
  const [user, branches, groups] = await Promise.all([
    db.get('SELECT * FROM users WHERE id = ?', [req.params.id]),
    db.all('SELECT * FROM branches ORDER BY name'),
    db.all('SELECT * FROM groups_tbl ORDER BY name'),
  ]);
  if (!user) return res.status(404).send('사용자를 찾을 수 없습니다.');
  res.render('users/form', { title: '사용자 수정', user, branches, groups, mode: 'edit' });
}));

router.post('/:id', asyncHandler(async (req, res) => {
  const { name, phone, role, branch_id, group_id, grade, status, password } = req.body;
  if (password && password.trim()) {
    const hash = await bcrypt.hash(password, 10);
    await db.run(
      `UPDATE users SET name=?, phone=?, role=?, branch_id=?, group_id=?, grade=?, status=?, password_hash=?
       WHERE id=?`,
      [name, phone, role, branch_id || null, group_id || null, role === 'client' ? grade : null, status, hash, req.params.id]
    );
  } else {
    await db.run(
      `UPDATE users SET name=?, phone=?, role=?, branch_id=?, group_id=?, grade=?, status=?
       WHERE id=?`,
      [name, phone, role, branch_id || null, group_id || null, role === 'client' ? grade : null, status, req.params.id]
    );
  }
  res.redirect('/users');
}));

module.exports = router;
