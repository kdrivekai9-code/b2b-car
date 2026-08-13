const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

// 숨은 필드(항상 '0')와 체크박스('1')가 같은 이름으로 온다 — 체크됐으면 urlencoded 파서가
// ['0','1'] 배열로 묶어준다(server.js가 extended:true), 체크 해제면 '0' 단일값만 온다.
// 필드 자체가 아예 없으면(마이그레이션 전 옛 페이지 캐시 등) 기존 동작 유지 차원에서 켜짐으로 본다.
function checkboxDefaultOn(value) {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.includes('1');
  return value === '1';
}

router.get('/data.json', asyncHandler(async (req, res) => {
  const groups = await db.all(`
    SELECT g.id, g.name, g.main_phone, g.branch_id, b.name AS branch_name,
           g.contact_name, g.contact_phone, g.settlement_method
    FROM groups_tbl g JOIN branches b ON b.id = g.branch_id
    ORDER BY g.id
  `);
  res.json({ currentUser: req.session.user, groups });
}));

router.get('/', asyncHandler(async (req, res) => {
  const groups = await db.all(`
    SELECT g.*, b.name AS branch_name
    FROM groups_tbl g JOIN branches b ON b.id = g.branch_id
    ORDER BY g.id
  `);
  res.render('groups/list', { title: '법인 관리', groups });
}));

router.get('/new/data.json', asyncHandler(async (req, res) => {
  const branches = await db.all('SELECT * FROM branches WHERE status = ? ORDER BY name', ['active']);
  res.json({ currentUser: req.session.user, branches });
}));

router.get('/new', asyncHandler(async (req, res) => {
  const branches = await db.all('SELECT * FROM branches WHERE status = ? ORDER BY name', ['active']);
  res.render('groups/form', { title: '법인 등록', group: {}, branches, mode: 'create' });
}));

router.post('/', asyncHandler(async (req, res) => {
  const {
    branch_id, name, main_phone, business_registration_number, company_phone,
    contact_name, contact_phone, business_address, tax_email,
    tax_invoice_issue_day, payment_due_day, settlement_method,
  } = req.body;
  const branch = await db.get('SELECT id, main_phone FROM branches WHERE id = ?', [branch_id]);
  if (!branch) return res.status(400).send('유효한 소속 지사를 선택해주세요.');
  const shareActivityFeed = req.body.share_activity_feed === '1';
  const routeFareSearchEnabled = checkboxDefaultOn(req.body.route_fare_search_enabled);

  const finalMainPhone = (main_phone || branch.main_phone || null);
  try {
    await db.run(
      `INSERT INTO groups_tbl (
        branch_id, parent_group_id, name, main_phone,
        business_registration_number, company_phone,
        contact_name, contact_phone, business_address, tax_email,
        tax_invoice_issue_day, payment_due_day, settlement_method, share_activity_feed,
        route_fare_search_enabled
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        branch_id,
        name,
        finalMainPhone,
        business_registration_number || null,
        company_phone || null,
        contact_name || null,
        contact_phone || null,
        business_address || null,
        tax_email || null,
        tax_invoice_issue_day ? Number(tax_invoice_issue_day) : null,
        payment_due_day ? Number(payment_due_day) : null,
        settlement_method || null,
        shareActivityFeed,
        routeFareSearchEnabled,
      ]
    );
  } catch (e) {
    // 마이그레이션 전(route_fare_search_enabled 컬럼 없음)이면 그 칸만 빼고 저장한다 —
    // 법인 등록 자체가 이 기능 하나 때문에 막히면 안 된다. share_activity_feed는 이미
    // 배포된 컬럼이라 여기서 같이 빼면 안 된다(빼면 그 설정이 조용히 저장되지 않는다).
    if (!e || e.code !== '42703') throw e;
    await db.run(
      `INSERT INTO groups_tbl (
        branch_id, parent_group_id, name, main_phone,
        business_registration_number, company_phone,
        contact_name, contact_phone, business_address, tax_email,
        tax_invoice_issue_day, payment_due_day, settlement_method, share_activity_feed
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        branch_id, name, finalMainPhone, business_registration_number || null, company_phone || null,
        contact_name || null, contact_phone || null, business_address || null, tax_email || null,
        tax_invoice_issue_day ? Number(tax_invoice_issue_day) : null,
        payment_due_day ? Number(payment_due_day) : null, settlement_method || null,
        shareActivityFeed,
      ]
    );
  }
  res.redirect('/groups');
}));

router.get('/:id/edit/data.json', asyncHandler(async (req, res) => {
  const [group, branches] = await Promise.all([
    db.get('SELECT * FROM groups_tbl WHERE id = ?', [req.params.id]),
    db.all('SELECT * FROM branches ORDER BY name'),
  ]);
  if (!group) return res.status(404).json({ error: 'not_found' });
  res.json({ currentUser: req.session.user, group, branches });
}));

router.get('/:id/edit', asyncHandler(async (req, res) => {
  const [group, branches] = await Promise.all([
    db.get('SELECT * FROM groups_tbl WHERE id = ?', [req.params.id]),
    db.all('SELECT * FROM branches ORDER BY name'),
  ]);
  if (!group) return res.status(404).send('법인을 찾을 수 없습니다.');
  res.render('groups/form', { title: '법인 정보', group, branches, mode: 'edit' });
}));

router.post('/:id', asyncHandler(async (req, res) => {
  const {
    branch_id, name, main_phone, business_registration_number, company_phone,
    contact_name, contact_phone, business_address, tax_email,
    tax_invoice_issue_day, payment_due_day, settlement_method,
  } = req.body;

  const branch = await db.get('SELECT id, main_phone FROM branches WHERE id = ?', [branch_id]);
  if (!branch) return res.status(400).send('유효한 소속 지사를 선택해주세요.');
  const shareActivityFeed = req.body.share_activity_feed === '1';
  const routeFareSearchEnabled = checkboxDefaultOn(req.body.route_fare_search_enabled);

  const finalMainPhone = (main_phone || branch.main_phone || null);
  try {
    await db.run(
      `UPDATE groups_tbl
       SET branch_id=?, name=?, main_phone=?,
           business_registration_number=?, company_phone=?,
           contact_name=?, contact_phone=?, business_address=?, tax_email=?,
           tax_invoice_issue_day=?, payment_due_day=?, settlement_method=?, share_activity_feed=?,
           route_fare_search_enabled=?
       WHERE id=?`,
      [
        branch_id, name, finalMainPhone, business_registration_number || null, company_phone || null,
        contact_name || null, contact_phone || null, business_address || null, tax_email || null,
        tax_invoice_issue_day ? Number(tax_invoice_issue_day) : null,
        payment_due_day ? Number(payment_due_day) : null, settlement_method || null,
        shareActivityFeed, routeFareSearchEnabled, req.params.id,
      ]
    );
  } catch (e) {
    // 위 INSERT 쪽과 같은 이유 — route_fare_search_enabled만 빼고 저장한다.
    if (!e || e.code !== '42703') throw e;
    await db.run(
      `UPDATE groups_tbl
       SET branch_id=?, name=?, main_phone=?,
           business_registration_number=?, company_phone=?,
           contact_name=?, contact_phone=?, business_address=?, tax_email=?,
           tax_invoice_issue_day=?, payment_due_day=?, settlement_method=?, share_activity_feed=?
       WHERE id=?`,
      [
        branch_id, name, finalMainPhone, business_registration_number || null, company_phone || null,
        contact_name || null, contact_phone || null, business_address || null, tax_email || null,
        tax_invoice_issue_day ? Number(tax_invoice_issue_day) : null,
        payment_due_day ? Number(payment_due_day) : null, settlement_method || null,
        shareActivityFeed, req.params.id,
      ]
    );
  }
  res.redirect('/groups');
}));

router.get('/:id/users/data.json', asyncHandler(async (req, res) => {
  const [group, users] = await Promise.all([
    db.get(`
      SELECT g.*, b.name AS branch_name
      FROM groups_tbl g
      LEFT JOIN branches b ON b.id = g.branch_id
      WHERE g.id = ?
    `, [req.params.id]),
    db.all(`
      SELECT u.*, b.name AS branch_name
      FROM users u
      LEFT JOIN branches b ON b.id = u.branch_id
      WHERE u.group_id = ?
      ORDER BY u.id DESC
    `, [req.params.id]),
  ]);
  if (!group) return res.status(404).json({ error: 'not_found' });
  res.json({ currentUser: req.session.user, group, users });
}));

router.get('/:id/users', asyncHandler(async (req, res) => {
  const [group, users] = await Promise.all([
    db.get(`
      SELECT g.*, b.name AS branch_name
      FROM groups_tbl g
      LEFT JOIN branches b ON b.id = g.branch_id
      WHERE g.id = ?
    `, [req.params.id]),
    db.all(`
      SELECT u.*, b.name AS branch_name
      FROM users u
      LEFT JOIN branches b ON b.id = u.branch_id
      WHERE u.group_id = ?
      ORDER BY u.id DESC
    `, [req.params.id]),
  ]);

  if (!group) return res.status(404).send('법인을 찾을 수 없습니다.');
  res.render('groups/users', { title: '법인 사용자 리스트', group, users });
}));

module.exports = router;
