const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get('/data.json', asyncHandler(async (req, res) => {
  const paymentMethods = await db.all('SELECT * FROM payment_methods ORDER BY id');
  res.json({ currentUser: req.session.user, paymentMethods });
}));

router.get('/', asyncHandler(async (req, res) => {
  const paymentMethods = await db.all('SELECT * FROM payment_methods ORDER BY id');
  res.render('settings/index', { title: '설정', paymentMethods });
}));

router.post('/payment-methods', asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (name && name.trim()) {
    await db.run('INSERT INTO payment_methods (name, is_active) VALUES (?, 1)', [name.trim()]);
  }
  res.redirect('/settings');
}));

router.post('/payment-methods/:id/toggle', asyncHandler(async (req, res) => {
  const pm = await db.get('SELECT * FROM payment_methods WHERE id = ?', [req.params.id]);
  if (pm) await db.run('UPDATE payment_methods SET is_active = ? WHERE id = ?', [pm.is_active ? 0 : 1, req.params.id]);
  res.redirect('/settings');
}));

module.exports = router;
