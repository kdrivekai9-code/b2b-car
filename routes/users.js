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

// 카카오 채널 매핑 화면("미등록계정")에서 이름·연락처·지사를 쿼리로 실어 넘겨준다 —
// 개인정보 동의로 받은 값을 다시 타이핑하지 않게 프리필한다(사용자 확정 요청). 그 화면에서
// 넘어온 사람은 거의 항상 거래처(고객사) 담당자라 role도 client로 미리 골라둔다 — 관리자가
// 매번 바꿔야 했던 수고를 던다(틀렸으면 그 자리에서 바로 고칠 수 있다).
function prefillFromQuery(query) {
  const name = String(query.name || '').trim();
  const phone = String(query.phone || '').trim();
  return {
    name, phone,
    branch_id: String(query.branch_id || '').trim(),
    role: (name || phone) ? 'client' : '',
  };
}

// return_to는 열린 리다이렉트가 되지 않도록 허용된 값만 통과시킨다.
const ALLOWED_RETURN_TO = new Set(['/kakao-accounts']);

router.get('/new/data.json', asyncHandler(async (req, res) => {
  const [branches, groups] = await Promise.all([
    db.all("SELECT * FROM branches WHERE status='active' ORDER BY name"),
    db.all('SELECT * FROM groups_tbl ORDER BY name'),
  ]);
  res.json({
    currentUser: req.session.user, branches, groups,
    prefill: prefillFromQuery(req.query),
    returnTo: ALLOWED_RETURN_TO.has(req.query.return_to) ? req.query.return_to : '',
  });
}));

router.get('/new', asyncHandler(async (req, res) => {
  const [branches, groups] = await Promise.all([
    db.all("SELECT * FROM branches WHERE status='active' ORDER BY name"),
    db.all('SELECT * FROM groups_tbl ORDER BY name'),
  ]);
  res.render('users/form', {
    title: '사용자 등록', user: prefillFromQuery(req.query), branches, groups, mode: 'create',
    returnTo: ALLOWED_RETURN_TO.has(req.query.return_to) ? req.query.return_to : '',
  });
}));

// login_id를 비워두고 등록하면 자동으로 만들어준다(사용자 확정 요청 — 카카오로만 소통하는
// 고객은 로그인할 일이 없어 아이디를 새로 정하게 하는 게 오히려 번거롭다). users.login_id는
// UNIQUE NOT NULL이라(마이그레이션 20260721000000) 빈 문자열을 그대로 넣으면 두 번째부터
// 충돌한다 — 연락처 기반으로 후보를 만들고, 겹치면 숫자를 붙여 가며 비어있는 값을 찾는다.
async function ensureUniqueLoginId(hint) {
  const base = String(hint || '').replace(/[^a-zA-Z0-9_]/g, '') || ('user' + Date.now().toString().slice(-8));
  for (let suffix = 0; suffix < 50; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}${suffix}`;
    const exists = await db.get('SELECT id FROM users WHERE login_id = ?', [candidate]);
    if (!exists) return candidate;
  }
  return `${base}${Date.now()}`;
}

router.post('/', asyncHandler(async (req, res) => {
  const { login_id, password, name, phone, role, branch_id, group_id, grade, return_to } = req.body;
  const trimmedLoginId = String(login_id || '').trim();
  const finalLoginId = trimmedLoginId
    || await ensureUniqueLoginId(phone ? `kakao_${String(phone).replace(/\D/g, '')}` : null);
  const hash = await bcrypt.hash(password || '1234', 10);
  await db.run(
    `INSERT INTO users (login_id, password_hash, name, phone, role, branch_id, group_id, grade, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    [finalLoginId, hash, name, phone, role, branch_id || null, group_id || null, role === 'client' ? grade : null]
  );
  if (ALLOWED_RETURN_TO.has(return_to)) {
    return res.redirect(return_to + '?notice=' + encodeURIComponent(`사용자 "${name}"(${finalLoginId})가 등록되었습니다. 담당 계정에서 선택해주세요.`));
  }
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
