const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requireAuth);

router.get('/data.json', asyncHandler(async (req, res) => {
  const notices = await db.all(`
    SELECT n.id, n.title, n.created_at, u.name AS author_name
    FROM notices n LEFT JOIN users u ON u.id = n.author_id
    ORDER BY n.id DESC
  `);
  res.json({ currentUser: req.session.user, notices });
}));

router.get('/', asyncHandler(async (req, res) => {
  const notices = await db.all(`
    SELECT n.*, u.name AS author_name
    FROM notices n LEFT JOIN users u ON u.id = n.author_id
    ORDER BY n.id DESC
  `);
  res.render('notices/list', { title: '공지사항', notices });
}));

router.get('/new/data.json', requireRole('admin'), (req, res) => {
  res.json({ currentUser: req.session.user });
});

router.get('/new', requireRole('admin'), (req, res) => {
  res.render('notices/form', { title: '공지사항 등록', notice: {}, mode: 'create' });
});

router.post('/', requireRole('admin'), asyncHandler(async (req, res) => {
  const { title, content } = req.body;
  const inserted = await db.run(
    'INSERT INTO notices (title, content, author_id) VALUES (?, ?, ?) RETURNING id',
    [title, content, req.session.user.id]
  );
  res.redirect('/notices/' + inserted.lastInsertRowid);
}));

router.get('/:id/data.json', asyncHandler(async (req, res) => {
  const notice = await db.get(`
    SELECT n.*, u.name AS author_name
    FROM notices n LEFT JOIN users u ON u.id = n.author_id
    WHERE n.id = ?
  `, [req.params.id]);
  if (!notice) return res.status(404).json({ error: 'not_found' });
  res.json({ currentUser: req.session.user, notice });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const notice = await db.get(`
    SELECT n.*, u.name AS author_name
    FROM notices n LEFT JOIN users u ON u.id = n.author_id
    WHERE n.id = ?
  `, [req.params.id]);
  if (!notice) return res.status(404).send('공지사항을 찾을 수 없습니다.');
  res.render('notices/detail', { title: notice.title, notice });
}));

router.get('/:id/edit/data.json', requireRole('admin'), asyncHandler(async (req, res) => {
  const notice = await db.get('SELECT * FROM notices WHERE id = ?', [req.params.id]);
  if (!notice) return res.status(404).json({ error: 'not_found' });
  res.json({ currentUser: req.session.user, notice });
}));

router.get('/:id/edit', requireRole('admin'), asyncHandler(async (req, res) => {
  const notice = await db.get('SELECT * FROM notices WHERE id = ?', [req.params.id]);
  if (!notice) return res.status(404).send('공지사항을 찾을 수 없습니다.');
  res.render('notices/form', { title: '공지사항 수정', notice, mode: 'edit' });
}));

router.post('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const { title, content } = req.body;
  await db.run('UPDATE notices SET title = ?, content = ? WHERE id = ?', [title, content, req.params.id]);
  res.redirect('/notices/' + req.params.id);
}));

router.post('/:id/delete', requireRole('admin'), asyncHandler(async (req, res) => {
  await db.run('DELETE FROM notices WHERE id = ?', [req.params.id]);
  res.redirect('/notices');
}));

module.exports = router;
