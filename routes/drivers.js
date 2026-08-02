const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get('/data.json', asyncHandler(async (req, res) => {
  const drivers = await db.all(`
    SELECT d.id, d.name, d.phone, d.status, d.branch_id, b.name AS branch_name
    FROM drivers d JOIN branches b ON b.id = d.branch_id
    ORDER BY d.id
  `);
  res.json({ currentUser: req.session.user, drivers });
}));

router.get('/', asyncHandler(async (req, res) => {
  const drivers = await db.all(`
    SELECT d.*, b.name AS branch_name
    FROM drivers d JOIN branches b ON b.id = d.branch_id
    ORDER BY d.id
  `);
  res.render('drivers/list', { title: '기사 관리', drivers });
}));

router.get('/new', asyncHandler(async (req, res) => {
  const branches = await db.all('SELECT * FROM branches ORDER BY name');
  res.render('drivers/form', { title: '기사 등록', driver: {}, branches, mode: 'create' });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { branch_id, name, phone } = req.body;
  await db.run(`INSERT INTO drivers (branch_id, name, phone, status) VALUES (?, ?, ?, 'active')`, [branch_id, name, phone || null]);
  res.redirect('/drivers');
}));

router.get('/:id/edit', asyncHandler(async (req, res) => {
  const [driver, branches] = await Promise.all([
    db.get('SELECT * FROM drivers WHERE id = ?', [req.params.id]),
    db.all('SELECT * FROM branches ORDER BY name'),
  ]);
  if (!driver) return res.status(404).send('기사를 찾을 수 없습니다.');
  res.render('drivers/form', { title: '기사 수정', driver, branches, mode: 'edit' });
}));

router.post('/:id', asyncHandler(async (req, res) => {
  const { branch_id, name, phone } = req.body;
  await db.run('UPDATE drivers SET branch_id=?, name=?, phone=? WHERE id=?', [branch_id, name, phone || null, req.params.id]);
  res.redirect('/drivers');
}));

router.post('/:id/toggle', asyncHandler(async (req, res) => {
  const driver = await db.get('SELECT * FROM drivers WHERE id = ?', [req.params.id]);
  const next = driver.status === 'active' ? 'inactive' : 'active';
  await db.run('UPDATE drivers SET status=? WHERE id=?', [next, req.params.id]);
  res.redirect('/drivers');
}));

module.exports = router;
