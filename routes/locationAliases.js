const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get('/data.json', asyncHandler(async (req, res) => {
  const aliases = await db.all(`
    SELECT la.id, la.canonical_name, la.address, la.aliases, la.branch_id, b.name AS branch_name
    FROM location_aliases la JOIN branches b ON b.id = la.branch_id
    ORDER BY la.id DESC
  `);
  res.json({ currentUser: req.session.user, aliases });
}));

router.get('/', asyncHandler(async (req, res) => {
  const aliases = await db.all(`
    SELECT la.*, b.name AS branch_name
    FROM location_aliases la JOIN branches b ON b.id = la.branch_id
    ORDER BY la.id DESC
  `);
  res.render('location_aliases/list', { title: '거점 별칭 관리', aliases });
}));

router.get('/new/data.json', asyncHandler(async (req, res) => {
  const branches = await db.all('SELECT * FROM branches ORDER BY name');
  res.json({ currentUser: req.session.user, branches });
}));

router.get('/new', asyncHandler(async (req, res) => {
  const branches = await db.all('SELECT * FROM branches ORDER BY name');
  res.render('location_aliases/form', { title: '거점 별칭 등록', alias: {}, branches, mode: 'create' });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { branch_id, canonical_name, address, aliases } = req.body;
  await db.run(
    'INSERT INTO location_aliases (branch_id, canonical_name, address, aliases) VALUES (?, ?, ?, ?)',
    [branch_id, canonical_name, address, aliases || null]
  );
  res.redirect('/location-aliases');
}));

router.get('/:id/edit/data.json', asyncHandler(async (req, res) => {
  const [alias, branches] = await Promise.all([
    db.get('SELECT * FROM location_aliases WHERE id = ?', [req.params.id]),
    db.all('SELECT * FROM branches ORDER BY name'),
  ]);
  if (!alias) return res.status(404).json({ error: 'not_found' });
  res.json({ currentUser: req.session.user, alias, branches });
}));

router.get('/:id/edit', asyncHandler(async (req, res) => {
  const [alias, branches] = await Promise.all([
    db.get('SELECT * FROM location_aliases WHERE id = ?', [req.params.id]),
    db.all('SELECT * FROM branches ORDER BY name'),
  ]);
  if (!alias) return res.status(404).send('거점 별칭을 찾을 수 없습니다.');
  res.render('location_aliases/form', { title: '거점 별칭 수정', alias, branches, mode: 'edit' });
}));

router.post('/:id', asyncHandler(async (req, res) => {
  const { branch_id, canonical_name, address, aliases } = req.body;
  await db.run(
    'UPDATE location_aliases SET branch_id=?, canonical_name=?, address=?, aliases=? WHERE id=?',
    [branch_id, canonical_name, address, aliases || null, req.params.id]
  );
  res.redirect('/location-aliases');
}));

router.post('/:id/delete', asyncHandler(async (req, res) => {
  await db.run('DELETE FROM location_aliases WHERE id = ?', [req.params.id]);
  res.redirect('/location-aliases');
}));

module.exports = router;
