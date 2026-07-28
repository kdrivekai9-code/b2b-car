const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => {
  const favorites = await db.all('SELECT * FROM favorite_addresses WHERE user_id = ? ORDER BY id DESC', [req.session.user.id]);
  res.json({ favorites });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { label, address } = req.body;
  if (!label || !address) return res.status(400).json({ error: '이름과 주소를 입력하세요.' });
  const inserted = await db.run(
    'INSERT INTO favorite_addresses (user_id, label, address) VALUES (?, ?, ?) RETURNING id',
    [req.session.user.id, label, address]
  );
  res.json({ ok: true, id: inserted.lastInsertRowid });
}));

router.post('/:id', asyncHandler(async (req, res) => {
  const { label, address } = req.body;
  await db.run(
    'UPDATE favorite_addresses SET label = ?, address = ? WHERE id = ? AND user_id = ?',
    [label, address, req.params.id, req.session.user.id]
  );
  res.json({ ok: true });
}));

router.post('/:id/delete', asyncHandler(async (req, res) => {
  await db.run('DELETE FROM favorite_addresses WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
