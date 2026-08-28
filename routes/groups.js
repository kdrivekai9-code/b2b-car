const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const bcrypt = require('bcryptjs');
const kakaoOrderNotify = require('../lib/kakaoOrderNotify');
// 기타 정산 내역(주유비·주차요금·톨게이트). 항목 정의를 오더상세 입력화면과 공유한다.
const extraCharges = require('../lib/extraCharges');
// 오지요금 상·하한은 계산 쪽과 한 곳에서 가져온다 — 화면 입력 제한과 실제 적용 범위가 갈리면
// 관리자가 넣은 값이 조용히 다른 금액으로 적용된다.
const { REMOTE_AREA_FEE_MIN, REMOTE_AREA_FEE_MAX } = require('../lib/branchPolicy');
const fareSurcharge = require('../lib/fareSurcharge');
const fareSurchargeInput = require('../lib/fareSurchargeInput');
const multer = require('multer');
// 지점 구간요금 — 거점↔지역 계약표. 거리 구간표보다 먼저 적용된다.
const officeZoneFare = require('../lib/officeZoneFare');
const zoneGeocode = require('../lib/zoneGeocode');
const { routeDistance } = require('../lib/fareQuote');
const { lookupRegion } = require('../lib/kakaoRegion');
// 지사 화면과 같은 표시 규칙을 쓴다 — 복사하면 갈라진다.
const {
  NOTIFY_PHOTO_EVENTS, DISPATCH_CALL_TYPES, parseCallTypes, buildEventRows,
} = require('../lib/customerNotifySettings');

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
  const routeSearchEnabled = checkboxDefaultOn(req.body.route_search_enabled);
  const fareSearchEnabled = checkboxDefaultOn(req.body.fare_search_enabled);

  const finalMainPhone = (main_phone || branch.main_phone || null);
  try {
    await db.run(
      `INSERT INTO groups_tbl (
        branch_id, parent_group_id, name, main_phone,
        business_registration_number, company_phone,
        contact_name, contact_phone, business_address, tax_email,
        tax_invoice_issue_day, payment_due_day, settlement_method, share_activity_feed,
        route_search_enabled, fare_search_enabled
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        routeSearchEnabled,
        fareSearchEnabled,
      ]
    );
  } catch (e) {
    // 마이그레이션 전(route_search_enabled/fare_search_enabled 컬럼 없음)이면 그 칸만 빼고 저장한다 —
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
  // groups는 탭 줄 오른쪽의 법인 전환 선택박스가 쓴다 — 이게 없으면 다른 탭에는 있는 전환이
  // 법인정보 화면에서만 사라진다(다른 화면은 loadGroupWithSiblings로 이미 함께 넘긴다).
  const [{ group, groups }, branches] = await Promise.all([
    loadGroupWithSiblings(req.params.id),
    db.all('SELECT * FROM branches ORDER BY name'),
  ]);
  if (!group) return res.status(404).json({ error: 'not_found' });
  res.json({ currentUser: req.session.user, group, groups, branches });
}));

router.get('/:id/edit', asyncHandler(async (req, res) => {
  const [{ group, groups }, branches] = await Promise.all([
    loadGroupWithSiblings(req.params.id),
    db.all('SELECT * FROM branches ORDER BY name'),
  ]);
  if (!group) return res.status(404).send('법인을 찾을 수 없습니다.');
  res.render('groups/form', { title: '법인 정보', group, groups, branches, mode: 'edit' });
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
  const routeSearchEnabled = checkboxDefaultOn(req.body.route_search_enabled);
  const fareSearchEnabled = checkboxDefaultOn(req.body.fare_search_enabled);

  const finalMainPhone = (main_phone || branch.main_phone || null);
  try {
    await db.run(
      `UPDATE groups_tbl
       SET branch_id=?, name=?, main_phone=?,
           business_registration_number=?, company_phone=?,
           contact_name=?, contact_phone=?, business_address=?, tax_email=?,
           tax_invoice_issue_day=?, payment_due_day=?, settlement_method=?, share_activity_feed=?,
           route_search_enabled=?, fare_search_enabled=?
       WHERE id=?`,
      [
        branch_id, name, finalMainPhone, business_registration_number || null, company_phone || null,
        contact_name || null, contact_phone || null, business_address || null, tax_email || null,
        tax_invoice_issue_day ? Number(tax_invoice_issue_day) : null,
        payment_due_day ? Number(payment_due_day) : null, settlement_method || null,
        shareActivityFeed, routeSearchEnabled, fareSearchEnabled, req.params.id,
      ]
    );
  } catch (e) {
    // 위 INSERT 쪽과 같은 이유 — 새 두 컬럼만 빼고 저장한다.
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

// ============================================================================
// 법인별 설정 (정책 변경: 요금표·고객통보를 지사별에서 법인별로 관리한다)
//
// 지사 설정을 없애지 않는다 — 법인에 값이 없으면 지사 값을 그대로 쓴다. 그래서 각 화면은
// "지금 무엇이 적용되고 있는지"를 반드시 밝힌다. 빈 표만 보여주면 요금이 0원이거나 통보가
// 꺼진 줄 알게 된다.
// ============================================================================

// 탭 전환 셀렉트가 쓸 법인 목록까지 함께 읽는다(지사 화면의 loadBranch*와 같은 방식).
async function loadGroupWithSiblings(groupId) {
  const [group, groups] = await Promise.all([
    db.get(`
      SELECT g.*, b.name AS branch_name
      FROM groups_tbl g
      LEFT JOIN branches b ON b.id = g.branch_id
      WHERE g.id = ?
    `, [groupId]),
    db.all('SELECT id, name FROM groups_tbl ORDER BY name'),
  ]);
  return { group, groups };
}

// ---------------- 계정정보 ----------------
// 법인 소속 계정을 이 화면 안에서 등록/수정한다. 법인이 자동으로 고정되므로 실수로 다른 법인에
// 계정을 만들 일이 없다(사용자 확정). 삭제는 두지 않고 비활성화만 한다 — 그 계정으로 접수된
// 오더·상담 이력이 남아 있어서, 행을 지우면 이력에서 사용자명이 사라진다(사용자 확정).
router.get('/:id/accounts', asyncHandler(async (req, res) => {
  const { group, groups } = await loadGroupWithSiblings(req.params.id);
  if (!group) return res.status(404).send('법인을 찾을 수 없습니다.');
  const [users, branches] = await Promise.all([
    db.all(`
      SELECT u.*, b.name AS branch_name, g.name AS group_name
      FROM users u
      LEFT JOIN branches b ON b.id = u.branch_id
      -- 화면에 법인을 함께 보여준다. 지금은 아래 WHERE로 이 법인만 걸러지므로 값이 모든 행에서
      -- 같지만, 화면이 group.name을 그대로 찍게 하면 나중에 이 목록의 범위가 넓어졌을 때
      -- (예: 소속 없는 계정까지 함께 보기) 틀린 값이 조용히 남는다. 행에서 읽게 둔다.
      LEFT JOIN groups_tbl g ON g.id = u.group_id
      WHERE u.group_id = ?
      ORDER BY u.status = 'active' DESC, u.id DESC
    `, [req.params.id]),
    db.all('SELECT id, name FROM branches ORDER BY id'),
  ]);
  res.render('groups/accounts', {
    title: '계정정보 - ' + group.name,
    group, groups, users, branches,
    editing: users.find((u) => String(u.id) === String(req.query.edit)) || null,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
}));

router.post('/:id/accounts', asyncHandler(async (req, res) => {
  const base = '/groups/' + req.params.id + '/accounts';
  const group = await db.get('SELECT id, branch_id FROM groups_tbl WHERE id = ?', [req.params.id]);
  if (!group) return res.status(404).send('법인을 찾을 수 없습니다.');

  const loginId = String(req.body.login_id || '').trim();
  const name = String(req.body.name || '').trim();
  const password = String(req.body.password || '');
  const role = ['admin', 'branch_manager', 'client'].includes(req.body.role) ? req.body.role : 'client';
  const phone = String(req.body.phone || '').trim();
  // 지사를 고르지 않으면 법인이 속한 지사로 둔다 — 이 화면에서 만드는 계정은 그 법인 소속이라
  // 다른 지사로 새는 편이 오히려 사고다.
  const branchId = Number(req.body.branch_id) || group.branch_id || null;

  if (!loginId) return res.redirect(base + '?error=' + encodeURIComponent('아이디를 입력해주세요.'));
  if (!name) return res.redirect(base + '?error=' + encodeURIComponent('이름을 입력해주세요.'));
  if (!password || password.length < 4) {
    return res.redirect(base + '?error=' + encodeURIComponent('비밀번호는 4자 이상으로 입력해주세요.'));
  }
  const duplicate = await db.get('SELECT id FROM users WHERE login_id = ?', [loginId]);
  if (duplicate) return res.redirect(base + '?error=' + encodeURIComponent(`이미 사용 중인 아이디입니다: ${loginId}`));

  const hash = await bcrypt.hash(password, 10);
  await db.run(
    `INSERT INTO users (login_id, password_hash, name, phone, role, branch_id, group_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
    [loginId, hash, name, phone, role, branchId, req.params.id]
  );
  res.redirect(base + '?notice=' + encodeURIComponent(`계정 "${name}"(${loginId})을 등록했습니다.`));
}));

router.post('/:id/accounts/:userId', asyncHandler(async (req, res) => {
  const base = '/groups/' + req.params.id + '/accounts';
  // 이 법인 소속 계정만 고칠 수 있다(주소창으로 남의 계정 id를 넣는 것 방지).
  const user = await db.get('SELECT * FROM users WHERE id = ? AND group_id = ?', [req.params.userId, req.params.id]);
  if (!user) return res.redirect(base + '?error=' + encodeURIComponent('이 법인 소속 계정이 아닙니다.'));

  const name = String(req.body.name || '').trim();
  const phone = String(req.body.phone || '').trim();
  const role = ['admin', 'branch_manager', 'client'].includes(req.body.role) ? req.body.role : user.role;
  const branchId = Number(req.body.branch_id) || user.branch_id || null;
  const password = String(req.body.password || '');
  if (!name) return res.redirect(base + '?error=' + encodeURIComponent('이름을 입력해주세요.'));
  if (password && password.length < 4) {
    return res.redirect(base + '?error=' + encodeURIComponent('비밀번호는 4자 이상으로 입력해주세요.'));
  }

  // 비밀번호는 입력했을 때만 바꾼다 — 빈 칸으로 저장했다고 비밀번호가 지워지면 안 된다.
  if (password) {
    const hash = await bcrypt.hash(password, 10);
    await db.run(
      'UPDATE users SET name=?, phone=?, role=?, branch_id=?, password_hash=? WHERE id=?',
      [name, phone, role, branchId, hash, user.id]
    );
  } else {
    await db.run(
      'UPDATE users SET name=?, phone=?, role=?, branch_id=? WHERE id=?',
      [name, phone, role, branchId, user.id]
    );
  }
  res.redirect(base + '?notice=' + encodeURIComponent(`계정 "${name}" 정보를 저장했습니다.`));
}));

router.post('/:id/accounts/:userId/status', asyncHandler(async (req, res) => {
  const base = '/groups/' + req.params.id + '/accounts';
  const user = await db.get('SELECT * FROM users WHERE id = ? AND group_id = ?', [req.params.userId, req.params.id]);
  if (!user) return res.redirect(base + '?error=' + encodeURIComponent('이 법인 소속 계정이 아닙니다.'));
  // 자기 계정을 스스로 잠그면 화면에서 나가지도 못한다.
  if (String(user.id) === String(req.session.user.id)) {
    return res.redirect(base + '?error=' + encodeURIComponent('본인 계정은 여기서 비활성화할 수 없습니다.'));
  }
  const next = user.status === 'active' ? 'inactive' : 'active';
  await db.run('UPDATE users SET status = ? WHERE id = ?', [next, user.id]);
  res.redirect(base + '?notice=' + encodeURIComponent(
    `계정 "${user.name}"을 ${next === 'active' ? '활성화' : '비활성화'}했습니다.`
  ));
}));

// ---------------- 탁송 요금 ----------------
// 지사 요금표(fare_rules)와 같은 구조·같은 화면 부품을 쓴다. 다른 점은 하나 — 이 표가 비어
// 있으면 지사 표가 적용된다는 사실을 화면이 밝힌다.
// 차종별 대형/화물 할증 화면에 필요한 값. 선택지는 "대형/화물"로 등록된 차종만 준다 —
// 대형이 아닌 차종에 금액을 걸어두면 판정이 false라 영영 적용되지 않는데 화면에는 남는다.
async function loadLargeCarFeeView(scope, id) {
  const keyCol = scope === 'group' ? 'group_id' : 'branch_id';
  const [fees, models] = await Promise.all([
    db.all(`SELECT vehicle_model_id, fee FROM fare_large_car_fees WHERE ${keyCol} = ? ORDER BY seq, id`, [id]).catch(() => []),
    db.all('SELECT id, name FROM vehicle_models WHERE is_large ORDER BY name').catch(() => []),
  ]);
  return { largeCarFees: fees || [], largeCarModels: models || [] };
}

async function loadGroupFarePage(groupId) {
  const { group, groups } = await loadGroupWithSiblings(groupId);
  if (!group) return { group: null };
  const [tiers, extraRow, branchTiers, branchExtra, placeRules, tollRules] = await Promise.all([
    db.all('SELECT * FROM group_fare_rules WHERE group_id = ? ORDER BY tier_seq', [groupId]),
    db.get('SELECT * FROM group_fare_extra_settings WHERE group_id = ?', [groupId]),
    db.all('SELECT * FROM fare_rules WHERE branch_id = ? ORDER BY tier_seq', [group.branch_id]),
    db.get('SELECT * FROM fare_extra_settings WHERE branch_id = ?', [group.branch_id]),
    // 마이그레이션(20260828010000) 전이면 테이블이 없다 — 화면은 빈 목록으로 뜨고 나머지는 그대로 쓴다.
    db.all('SELECT keyword, fee FROM fare_place_surcharges WHERE group_id = ? ORDER BY seq, id', [groupId]).catch(() => []),
    db.all('SELECT name, fee FROM fare_special_tolls WHERE group_id = ? ORDER BY seq, id', [groupId]).catch(() => []),
  ]);
  const extra = extraRow || {};
  const largeCar = await loadLargeCarFeeView('group', groupId);
  return {
    group, groups, tiers, extra, branchTiers, branchExtra: branchExtra || {},
    placeRules: placeRules || [],
    tollRules: tollRules || [],
    extraCostItems: fareSurcharge.extraCostStates(extra),
    ...largeCar,
  };
}

router.get('/:id/fare-rules', asyncHandler(async (req, res) => {
  const page = await loadGroupFarePage(req.params.id);
  if (!page.group) return res.status(404).send('법인을 찾을 수 없습니다.');
  res.render('groups/fare_rules', {
    title: '탁송 요금 - ' + page.group.name,
    ...page,
    saved: req.query.saved === '1',
    copied: req.query.copied === '1',
    error: req.query.error || null,
    remoteAreaFeeMin: REMOTE_AREA_FEE_MIN,
    remoteAreaFeeMax: REMOTE_AREA_FEE_MAX,
    surchargeMin: fareSurcharge.SURCHARGE_FEE_MIN,
    surchargeMax: fareSurcharge.SURCHARGE_FEE_MAX,
  });
}));

// 지사 표를 그대로 가져와 시작한다(사용자 확정) — 같은 표를 손으로 다시 넣게 하지 않는다.
router.post('/:id/fare-rules/copy', asyncHandler(async (req, res) => {
  const base = '/groups/' + req.params.id + '/fare-rules';
  const group = await db.get('SELECT id, branch_id FROM groups_tbl WHERE id = ?', [req.params.id]);
  if (!group) return res.status(404).send('법인을 찾을 수 없습니다.');
  if (!group.branch_id) return res.redirect(base + '?error=' + encodeURIComponent('이 법인에 소속 지사가 없습니다.'));

  const [tiers, extra] = await Promise.all([
    db.all('SELECT * FROM fare_rules WHERE branch_id = ? ORDER BY tier_seq', [group.branch_id]),
    db.get('SELECT * FROM fare_extra_settings WHERE branch_id = ?', [group.branch_id]),
  ]);
  if (!tiers.length) return res.redirect(base + '?error=' + encodeURIComponent('소속 지사에 등록된 탁송 요금표가 없습니다.'));

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM group_fare_rules WHERE group_id = $1', [req.params.id]);
    for (const t of tiers) {
      await client.query(
        `INSERT INTO group_fare_rules (group_id, tier_seq, base_distance_km, base_fare, surcharge_unit_km,
                                       surcharge_fare, max_distance_km, max_fare, round_unit, round_method, is_representative)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [req.params.id, t.tier_seq, t.base_distance_km, t.base_fare, t.surcharge_unit_km,
          t.surcharge_fare, t.max_distance_km, t.max_fare, t.round_unit, t.round_method, t.is_representative]
      );
    }
    const e = extra || {};
    await client.query(
      `INSERT INTO group_fare_extra_settings (group_id, round_trip_ratio, wait_threshold_min, wait_fee,
                                              cancel_before_fee, cancel_after_fee, fare_table_enabled,
                                              fare_visible_to_client, fare_editable_by_client)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (group_id) DO UPDATE SET
         round_trip_ratio = excluded.round_trip_ratio,
         wait_threshold_min = excluded.wait_threshold_min,
         wait_fee = excluded.wait_fee,
         cancel_before_fee = excluded.cancel_before_fee,
         cancel_after_fee = excluded.cancel_after_fee,
         fare_table_enabled = excluded.fare_table_enabled,
         fare_visible_to_client = excluded.fare_visible_to_client,
         fare_editable_by_client = excluded.fare_editable_by_client`,
      [req.params.id, e.round_trip_ratio || 180, e.wait_threshold_min || 15, e.wait_fee || 0,
        e.cancel_before_fee || 0, e.cancel_after_fee || 0, e.fare_table_enabled ? 1 : 0,
        e.fare_visible_to_client === 0 ? 0 : 1, e.fare_editable_by_client ? 1 : 0]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.redirect(base + '?copied=1');
}));

router.post('/:id/fare-rules', asyncHandler(async (req, res) => {
  const b = (v) => [].concat(v || []);
  const baseDist = b(req.body.base_distance_km);
  const baseFare = b(req.body.base_fare);
  const surUnit = b(req.body.surcharge_unit_km);
  const surFare = b(req.body.surcharge_fare);
  const maxDist = b(req.body.max_distance_km);
  const maxFare = b(req.body.max_fare);
  const roundUnit = b(req.body.round_unit);
  const roundMethod = b(req.body.round_method);

  await db.run('DELETE FROM group_fare_rules WHERE group_id = ?', [req.params.id]);
  for (let i = 0; i < baseDist.length; i++) {
    if (baseDist[i] === '' && baseFare[i] === '') continue;
    await db.run(`
      INSERT INTO group_fare_rules (group_id, tier_seq, base_distance_km, base_fare, surcharge_unit_km,
                                    surcharge_fare, max_distance_km, max_fare, round_unit, round_method)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      req.params.id, i + 1,
      Number(baseDist[i]) || 0, Number(baseFare[i]) || 0,
      Number(surUnit[i]) || 1, Number(surFare[i]) || 0,
      maxDist[i] ? Number(maxDist[i]) : null, maxFare[i] ? Number(maxFare[i]) : null,
      Number(roundUnit[i]) || 1000, roundMethod[i] || 'round',
    ]);
  }

  const {
    round_trip_ratio, wait_threshold_min, wait_fee, cancel_before_fee, cancel_after_fee,
    fare_table_enabled, fare_visible_to_client, fare_editable_by_client,
  } = req.body;

  // 할증 금액 — 0(안 받음)이거나 상·하한 사이여야 한다. 그 사이가 아닌 값(예: 500원)을 그대로
  // 저장하면 계산 쪽이 하한으로 끌어올려 적용해, 관리자가 넣은 금액과 실제 청구액이 갈린다.
  const badFee = fareSurchargeInput.findBadFee(req.body);
  if (badFee) {
    return res.redirect('/groups/' + req.params.id + '/fare-rules?error=' + encodeURIComponent(badFee));
  }
  const remoteAreaFee = Number(req.body.remote_area_fee) || 0;

  await db.run(
    `INSERT INTO group_fare_extra_settings (group_id, round_trip_ratio, wait_threshold_min, wait_fee,
                                            cancel_before_fee, cancel_after_fee, fare_table_enabled,
                                            fare_visible_to_client, fare_editable_by_client, remote_area_fee)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (group_id) DO UPDATE SET
       round_trip_ratio = excluded.round_trip_ratio,
       wait_threshold_min = excluded.wait_threshold_min,
       wait_fee = excluded.wait_fee,
       cancel_before_fee = excluded.cancel_before_fee,
       cancel_after_fee = excluded.cancel_after_fee,
       fare_table_enabled = excluded.fare_table_enabled,
       fare_visible_to_client = excluded.fare_visible_to_client,
       fare_editable_by_client = excluded.fare_editable_by_client,
       remote_area_fee = excluded.remote_area_fee`,
    [req.params.id, Number(round_trip_ratio) || 180, Number(wait_threshold_min) || 15,
      Number(wait_fee) || 0, Number(cancel_before_fee) || 0, Number(cancel_after_fee) || 0,
      fare_table_enabled ? 1 : 0, fare_visible_to_client ? 1 : 0, fare_editable_by_client ? 1 : 0,
      remoteAreaFee]
  ).catch(async (e) => {
    // 마이그레이션(20260825020000) 전이면 컬럼이 없다 — 오지요금만 빼고 나머지는 저장한다.
    if (!e || e.code !== '42703') throw e;
    console.error('오지요금 저장 실패(마이그레이션 미적용):', e.message);
    await db.run(
      `INSERT INTO group_fare_extra_settings (group_id, round_trip_ratio, wait_threshold_min, wait_fee,
                                              cancel_before_fee, cancel_after_fee, fare_table_enabled,
                                              fare_visible_to_client, fare_editable_by_client)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (group_id) DO UPDATE SET
         round_trip_ratio = excluded.round_trip_ratio,
         wait_threshold_min = excluded.wait_threshold_min,
         wait_fee = excluded.wait_fee,
         cancel_before_fee = excluded.cancel_before_fee,
         cancel_after_fee = excluded.cancel_after_fee,
         fare_table_enabled = excluded.fare_table_enabled,
         fare_visible_to_client = excluded.fare_visible_to_client,
         fare_editable_by_client = excluded.fare_editable_by_client`,
      [req.params.id, Number(round_trip_ratio) || 180, Number(wait_threshold_min) || 15,
        Number(wait_fee) || 0, Number(cancel_before_fee) || 0, Number(cancel_after_fee) || 0,
        fare_table_enabled ? 1 : 0, fare_visible_to_client ? 1 : 0, fare_editable_by_client ? 1 : 0]
    );
  });

  // 위 upsert가 행을 만든 **뒤**에 돌아야 한다 — UPDATE라 행이 없으면 아무것도 저장되지 않는다.
  const saved = await fareSurchargeInput.saveSettings('group', req.params.id, req.body);
  const savedRules = await fareSurchargeInput.saveScopedRules('group', req.params.id, req.body);
  if (!saved.ok || !savedRules.ok) {
    return res.redirect('/groups/' + req.params.id + '/fare-rules?error='
      + encodeURIComponent('할증·부대비용 설정은 저장되지 않았습니다. 마이그레이션(20260828010000)을 먼저 실행해주세요.'));
  }
  res.redirect('/groups/' + req.params.id + '/fare-rules?saved=1');
}));

// ---------------- 일일기사 요금 ----------------
// 시간 구간 기반(지사의 premium_fare_rules와 같은 구조). 이 상품에 실제로 쓰이는 표라 이름을
// 일일기사로 맞췄다 — 프리미엄(대리)은 요금 체계가 나오면 별도 표를 만든다.
router.get('/:id/daily-driver-fare-rules', asyncHandler(async (req, res) => {
  const { group, groups } = await loadGroupWithSiblings(req.params.id);
  if (!group) return res.status(404).send('법인을 찾을 수 없습니다.');
  const [tiers, branchTiers] = await Promise.all([
    db.all('SELECT * FROM group_daily_driver_fare_rules WHERE group_id = ? ORDER BY tier_seq', [req.params.id]),
    db.all('SELECT * FROM premium_fare_rules WHERE branch_id = ? ORDER BY tier_seq', [group.branch_id]),
  ]);
  res.render('groups/daily_driver_fare_rules', {
    title: '일일기사 요금 - ' + group.name,
    group, groups, tiers, branchTiers,
    saved: req.query.saved === '1',
    copied: req.query.copied === '1',
    error: req.query.error || null,
  });
}));

router.post('/:id/daily-driver-fare-rules/copy', asyncHandler(async (req, res) => {
  const base = '/groups/' + req.params.id + '/daily-driver-fare-rules';
  const group = await db.get('SELECT id, branch_id FROM groups_tbl WHERE id = ?', [req.params.id]);
  if (!group) return res.status(404).send('법인을 찾을 수 없습니다.');
  const tiers = await db.all('SELECT * FROM premium_fare_rules WHERE branch_id = ? ORDER BY tier_seq', [group.branch_id]);
  if (!tiers.length) return res.redirect(base + '?error=' + encodeURIComponent('소속 지사에 등록된 일일기사 요금표가 없습니다.'));

  await db.run('DELETE FROM group_daily_driver_fare_rules WHERE group_id = ?', [req.params.id]);
  for (const t of tiers) {
    await db.run(
      `INSERT INTO group_daily_driver_fare_rules (group_id, tier_seq, base_hours, fare_amount, extra_per_hour, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.params.id, t.tier_seq, t.base_hours, t.fare_amount, t.extra_per_hour, t.note || null]
    );
  }
  res.redirect(base + '?copied=1');
}));

router.post('/:id/daily-driver-fare-rules', asyncHandler(async (req, res) => {
  const b = (v) => [].concat(v || []);
  const baseHours = b(req.body.base_hours);
  const fareAmount = b(req.body.fare_amount);
  const extraPerHour = b(req.body.extra_per_hour);
  const note = b(req.body.note);

  await db.run('DELETE FROM group_daily_driver_fare_rules WHERE group_id = ?', [req.params.id]);
  for (let i = 0; i < baseHours.length; i++) {
    if (baseHours[i] === '' && fareAmount[i] === '') continue;
    await db.run(
      `INSERT INTO group_daily_driver_fare_rules (group_id, tier_seq, base_hours, fare_amount, extra_per_hour, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.params.id, i + 1, Number(baseHours[i]) || 0, Number(fareAmount[i]) || 0,
        Number(extraPerHour[i]) || 0, (note[i] || '').trim() || null]
    );
  }
  res.redirect('/groups/' + req.params.id + '/daily-driver-fare-rules?saved=1');
}));

// ---------------- 프리미엄(대리) 요금 ----------------
// 요금 체계가 아직 정해지지 않아 자리만 만들어 둔다(사용자 확정). 표를 미리 만들어두면 비어 있는
// 표가 계산에 끼어들 수 있어, 저장할 곳 자체를 두지 않았다.
router.get('/:id/premium-fare-rules', asyncHandler(async (req, res) => {
  const { group, groups } = await loadGroupWithSiblings(req.params.id);
  if (!group) return res.status(404).send('법인을 찾을 수 없습니다.');
  res.render('groups/premium_fare_rules', { title: '프리미엄(대리) 요금 - ' + group.name, group, groups });
}));

// ---------------- 고객 통보 ----------------
// 사건 목록·문구 규칙·미리보기는 지사 화면과 한 벌을 쓴다(lib/customerNotifySettings.js).
// 저장된 값이 없으면 지사 값을 보여주고, 그 사실을 화면이 밝힌다(inherited).
router.get('/:id/customer-notifications', asyncHandler(async (req, res) => {
  const { group, groups } = await loadGroupWithSiblings(req.params.id);
  if (!group) return res.status(404).send('법인을 찾을 수 없습니다.');
  const [saved, branchSaved] = await Promise.all([
    db.all('SELECT * FROM group_customer_notifications WHERE group_id = ?', [req.params.id]).catch(() => []),
    db.all('SELECT * FROM branch_customer_notifications WHERE branch_id = ?', [group.branch_id]).catch(() => []),
  ]);
  res.render('groups/customer_notifications', {
    title: '고객 통보 - ' + group.name,
    group, groups,
    events: buildEventRows(saved, { inheritedRows: branchSaved }),
    variables: kakaoOrderNotify.TEMPLATE_VARIABLES,
    hasOwnSettings: saved.length > 0,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
}));

router.post('/:id/customer-notifications', asyncHandler(async (req, res) => {
  const base = '/groups/' + req.params.id + '/customer-notifications';
  const group = await db.get('SELECT id FROM groups_tbl WHERE id = ?', [req.params.id]);
  if (!group) return res.status(404).send('법인을 찾을 수 없습니다.');

  // 한 번에 다 받는다 — 절반만 저장되면 화면에 보이는 것과 실제로 나가는 문구가 어긋난다.
  const rows = [];
  for (const key of kakaoOrderNotify.EVENT_TYPES) {
    const fallback = kakaoOrderNotify.DEFAULT_EVENT_SETTINGS[key];
    const delayMinutes = Number(req.body['delay_' + key]);
    // textarea의 \r\n을 그대로 저장하면 고객에게 나가는 문구에 캐리지 리턴이 섞인다.
    const template = String(req.body['message_' + key] || '').replace(/\r\n?/g, '\n').trim();
    if (!Number.isInteger(delayMinutes) || delayMinutes < 0 || delayMinutes > 120) {
      return res.redirect(base + '?error=' + encodeURIComponent(`${fallback.label}의 보내는 시점은 0~120분 사이로 입력해주세요.`));
    }
    if (!template) {
      return res.redirect(base + '?error=' + encodeURIComponent(`${fallback.label}의 문구를 입력해주세요.`));
    }
    rows.push({
      key,
      enabled: !!req.body['enabled_' + key],
      delayMinutes,
      template,
      attachPhotos: NOTIFY_PHOTO_EVENTS.has(key) && !!req.body['attach_photos_' + key],
    });
  }

  for (const row of rows) {
    await db.run(`
      INSERT INTO group_customer_notifications (group_id, event_type, enabled, delay_minutes, message_template, attach_photos)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (group_id, event_type) DO UPDATE SET
        enabled = excluded.enabled,
        delay_minutes = excluded.delay_minutes,
        message_template = excluded.message_template,
        attach_photos = excluded.attach_photos,
        updated_at = now()
    `, [req.params.id, row.key, row.enabled, row.delayMinutes, row.template, row.attachPhotos]);
  }
  res.redirect(base + '?notice=' + encodeURIComponent('고객 통보 설정이 저장되었습니다.'));
}));

// 법인 설정을 지우면 다시 지사 설정을 따른다 — "지사와 같게 되돌리기"를 이렇게 제공한다.
router.post('/:id/customer-notifications/reset', asyncHandler(async (req, res) => {
  await db.run('DELETE FROM group_customer_notifications WHERE group_id = ?', [req.params.id]);
  res.redirect('/groups/' + req.params.id + '/customer-notifications?notice='
    + encodeURIComponent('법인 설정을 지웠습니다. 이제 소속 지사 설정을 따릅니다.'));
}));

// ---------------- 배차지연 알림 ----------------
// 저장소는 지사 화면과 같은 dispatch_delay_settings다(이미 group_id로 법인별이었다). 지사 화면은
// 그 지사의 모든 법인을 한 줄씩 관리하고, 이 화면은 이 법인 한 줄만 관리한다 — 같은 행이다.
router.get('/:id/dispatch-delay', asyncHandler(async (req, res) => {
  const { group, groups } = await loadGroupWithSiblings(req.params.id);
  if (!group) return res.status(404).send('법인을 찾을 수 없습니다.');
  const setting = await db.get(
    'SELECT * FROM dispatch_delay_settings WHERE branch_id = ? AND group_id = ?',
    [group.branch_id, req.params.id]
  ).catch(() => null);
  res.render('groups/dispatch_delay', {
    title: '배차지연 알림 - ' + group.name,
    group, groups, setting,
    callTypes: DISPATCH_CALL_TYPES,
    selected: setting ? String(setting.call_types || '').split(',').map((v) => v.trim()) : [],
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
}));

router.post('/:id/dispatch-delay', asyncHandler(async (req, res) => {
  const base = '/groups/' + req.params.id + '/dispatch-delay';
  const group = await db.get('SELECT id, branch_id FROM groups_tbl WHERE id = ?', [req.params.id]);
  if (!group) return res.status(404).send('법인을 찾을 수 없습니다.');
  if (!group.branch_id) return res.redirect(base + '?error=' + encodeURIComponent('이 법인에 소속 지사가 없습니다.'));

  const callTypes = parseCallTypes(req.body.call_types);
  const delayMinutes = Number(req.body.delay_minutes);
  const raiseAmount = Number(req.body.raise_amount);
  if (!callTypes.length) {
    return res.redirect(base + '?error=' + encodeURIComponent('적용할 콜 유형을 하나 이상 선택해주세요.'));
  }
  if (!Number.isInteger(delayMinutes) || delayMinutes < 1 || delayMinutes > 120) {
    return res.redirect(base + '?error=' + encodeURIComponent('배차지연 판단 시간은 1~120분 사이로 입력해주세요.'));
  }
  if (!Number.isInteger(raiseAmount) || raiseAmount < 1000 || raiseAmount > 10000 || raiseAmount % 1000 !== 0) {
    return res.redirect(base + '?error=' + encodeURIComponent('요금 상향금액은 1,000원 단위로 10,000원까지 선택해주세요.'));
  }

  await db.run(`
    INSERT INTO dispatch_delay_settings (branch_id, group_id, call_types, delay_minutes, raise_amount)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (branch_id, group_id) DO UPDATE SET
      call_types = excluded.call_types,
      delay_minutes = excluded.delay_minutes,
      raise_amount = excluded.raise_amount,
      updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
  `, [group.branch_id, req.params.id, callTypes.join(','), delayMinutes, raiseAmount]);
  res.redirect(base + '?notice=' + encodeURIComponent('배차지연 알림 설정이 저장되었습니다.'));
}));

router.post('/:id/dispatch-delay/delete', asyncHandler(async (req, res) => {
  const group = await db.get('SELECT branch_id FROM groups_tbl WHERE id = ?', [req.params.id]);
  await db.run('DELETE FROM dispatch_delay_settings WHERE branch_id = ? AND group_id = ?',
    [group && group.branch_id, req.params.id]);
  res.redirect('/groups/' + req.params.id + '/dispatch-delay?notice='
    + encodeURIComponent('설정을 삭제했습니다. 이 법인에는 배차지연 선제 안내가 나가지 않습니다.'));
}));

// ---------------- 월별 정산내역 ----------------
// 완료된 오더를 **완료일** 기준으로 묶는다(사용자 확정). 완료 시각은 orders에 컬럼이 없어
// order_status_history에서 '완료'로 바뀐 시각을 쓴다 — 같은 오더가 여러 번 완료로 기록될 수
// 있어(콜마너 흔들림) 가장 마지막 것을 본다.
//
// 요금은 계약 요금(fare_amount)이다 — 고객에게 청구하는 값이라 정산의 근거가 된다.
// 배차 요금(dispatch_fare_amount)은 콜마너에 거는 원가라 여기 넣지 않는다.
function settlementMonth(raw) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(raw || '').trim());
  if (m) return `${m[1]}-${m[2]}`;
  // 기본값은 이번 달(KST) — 서버가 UTC로 돌아서 그냥 new Date()를 쓰면 월초·월말에 한 달이 밀린다.
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}`;
}

// created_at은 text(KST 문자열)다 — timestamptz로 캐스팅해 비교하면 다른 곳에서 겪었던 타입
// 충돌이 그대로 재현되므로 앞 7글자('YYYY-MM')를 문자열로 자른다.
async function loadSettlement(groupId, month) {
  // 조회 실패를 .catch로 삼켜 빈 목록을 돌려주면 "이 달은 실적이 없다"로 읽힌다 — 정산 화면에서
  // 그건 그냥 오류보다 나쁘다. 던져서 오류 화면이 뜨게 둔다.
  //
  // 다만 차종 분류 컬럼만은 예외다. 마이그레이션(20260828040000) 전에는 그 컬럼이 없는데,
  // 그것 때문에 정산 화면 전체가 안 열리면 배포와 마이그레이션 사이에 정산 업무가 멈춘다.
  // 분류는 보조 정보라 빠져도 정산 금액에는 영향이 없다 — 그 컬럼만 빼고 다시 조회한다.
  const SETTLEMENT_SQL = (vehicleCols) => `
    SELECT o.id, o.oid, o.reserved_date, o.reserved_time, o.vehicle_number,
           ${vehicleCols}
           o.origin_address, o.origin_address_detail,
           o.destination_address, o.destination_address_detail,
           o.fare_amount, o.ferry_fare_amount,
           h.completed_at
      FROM orders o
      JOIN (
        SELECT order_id, MAX(created_at) AS completed_at
          FROM order_status_history
         WHERE new_status = '완료'
         GROUP BY order_id
      ) h ON h.order_id = o.id
     WHERE o.requester_group_id = ?
       AND o.status = '완료'
       AND SUBSTRING(h.completed_at, 1, 7) = ?
     ORDER BY h.completed_at ASC, o.id ASC
  `;
  const rows = await db.all(
    SETTLEMENT_SQL('o.vehicle_type, o.car_type, o.fuel_type, o.vehicle_class_source,'),
    [groupId, month]
  ).catch((e) => {
    if (!e || e.code !== '42703') throw e;
    console.error('정산: 차종 분류 컬럼 없음 — 그 열을 빼고 조회합니다:', e.message);
    return db.all(SETTLEMENT_SQL('o.vehicle_type,'), [groupId, month]);
  });

  // 도선료는 탁송료와 별개로 청구되는 실비다 — 합계에서 빠지면 정산서와 맞지 않는다.
  const items = rows.map((r) => {
    const fare = Number(r.fare_amount) || 0;
    const ferry = Number(r.ferry_fare_amount) || 0;
    return { ...r, fare, ferry, total: fare + ferry };
  });
  const summary = {
    count: items.length,
    fare: items.reduce((s, r) => s + r.fare, 0),
    ferry: items.reduce((s, r) => s + r.ferry, 0),
    total: items.reduce((s, r) => s + r.total, 0),
  };

  // 기타 정산 내역 — 운행요금과 별도로 청구하는 실비(주유비 · 주차요금 · 톨게이트).
  //
  // 어느 달에 넣을지는 **오더를 따라간다**(발생일자가 아니라). 실비 일자로 묶으면 월말 오더의
  // 톨게이트비만 다음 달 정산서로 넘어가서, 운행요금과 실비가 서로 다른 청구서에 실린다.
  // 목록의 '일자' 칸은 실제 발생일(charged_on)을 그대로 보여준다.
  //
  // billable = false는 거래처에 청구하지 않고 지사가 부담하는 실비다 — 기록은 남기되 여기엔
  // 올리지 않는다("별도 청구 항목만", 사용자 지시).
  const extraRows = items.length ? await db.all(`
    SELECT e.id, e.order_id, e.charge_type, e.amount, e.charged_on, e.note,
           o.oid, o.reserved_date, o.vehicle_number,
           o.origin_address, o.origin_address_detail
      FROM order_extra_charges e
      JOIN orders o ON o.id = e.order_id
     WHERE e.billable = true
       AND e.order_id IN (${items.map(() => '?').join(',')})
     ORDER BY COALESCE(e.charged_on, o.reserved_date), e.id
  `, items.map((r) => r.id)) : [];

  const extras = extraRows.map((r) => ({
    ...r,
    amount: Number(r.amount) || 0,
    // 일자를 안 넣은 줄은 오더 예약일로 본다 — 저장할 때도 같은 규칙을 쓰지만(lib/extraCharges.js),
    // 그 규칙이 생기기 전에 들어간 줄이 빈 칸으로 남지 않도록 여기서도 받아준다.
    charged_on: r.charged_on || r.reserved_date || null,
  }));
  const extraSummary = extraCharges.summarize(extras);

  // 고를 수 있는 달 — 이 법인에 완료 오더가 있는 달만 보여준다. 빈 달을 늘어놓을 이유가 없다.
  const months = await db.all(`
    SELECT DISTINCT SUBSTRING(h.created_at, 1, 7) AS month
      FROM orders o
      JOIN order_status_history h ON h.order_id = o.id AND h.new_status = '완료'
     WHERE o.requester_group_id = ? AND o.status = '완료'
     ORDER BY 1 DESC
  `, [groupId]);

  return {
    items, summary, extras, extraSummary,
    // 거래처에 실제로 청구할 금액 — 운행요금과 실비를 더한 값이다. 화면에서 다시 더하면
    // 목록과 통계가 갈릴 수 있어 여기서 한 번만 계산한다.
    grandTotal: summary.total + extraSummary.total,
    months: months.map((m) => m.month).filter(Boolean),
  };
}

router.get('/:id/settlement', asyncHandler(async (req, res) => {
  const { group, groups } = await loadGroupWithSiblings(req.params.id);
  if (!group) return res.status(404).send('법인을 찾을 수 없습니다.');
  const month = settlementMonth(req.query.month);
  const data = await loadSettlement(req.params.id, month);

  res.render('groups/settlement', {
    title: '정산내역 - ' + group.name,
    group, groups, month,
    extraChargeTypes: extraCharges.EXTRA_CHARGE_TYPES,
    ...data,
  });
}));

// ---------------- 지점 구간요금표 ----------------
// 계약이 "강남지점 ↔ 서울 강남구 = 20,000원"처럼 표로 맺어지는 경우가 많다(첨부 단가표).
// 이 표가 있으면 거리 구간표보다 먼저 본다(lib/branchPolicy.js calculateFare).
//
// 엑셀 업로드는 메모리에서만 읽는다 — 요금표는 계약 정보라 디스크에 남길 이유가 없다.
const officeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

async function loadOfficeFarePage(groupId) {
  const { group, groups } = await loadGroupWithSiblings(groupId);
  if (!group) return { group: null };
  const offices = await officeZoneFare.listOffices(groupId);
  // 지점마다 요금 줄을 따로 읽는다. 한 번에 조인해 가져오면 요금이 하나도 없는 지점이
  // 목록에서 사라져 "등록은 했는데 안 보인다"가 된다.
  const zonesByOffice = {};
  for (const o of offices) zonesByOffice[o.id] = await officeZoneFare.listZoneFares(o.id);
  return { group, groups, offices, zonesByOffice };
}

router.get('/:id/office-fares', asyncHandler(async (req, res) => {
  const page = await loadOfficeFarePage(req.params.id);
  if (!page.group) return res.status(404).send('법인을 찾을 수 없습니다.');
  res.render('groups/office_fares', {
    title: '지점 구간요금 - ' + page.group.name,
    ...page,
    saved: req.query.saved || null,
    error: req.query.error || null,
    uploadResult: req.query.uploaded ? JSON.parse(decodeURIComponent(req.query.uploaded)) : null,
  });
}));

// 지점 등록 — 상호 + 주소(좌표까지). 좌표가 없으면 등록을 막는다: 좌표가 이 기능의 전부다
// (출발/도착이 그 지점인지 좌표로 판정한다 — lib/officeZoneFare.js).
router.post('/:id/office-fares/offices', asyncHandler(async (req, res) => {
  const base = '/groups/' + req.params.id + '/office-fares';
  const name = String(req.body.name || '').trim();
  const address = String(req.body.address || '').trim();
  const lat = Number(req.body.lat);
  const lon = Number(req.body.lon);
  if (!name || !address) return res.redirect(base + '?error=' + encodeURIComponent('지점명과 주소를 입력해주세요.'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.redirect(base + '?error=' + encodeURIComponent('주소를 검색해서 좌표를 확정해주세요. 좌표가 없으면 지점을 알아볼 수 없습니다.'));
  }
  const region = await lookupRegion(lat, lon).catch(() => null);
  try {
    await db.run(
      `INSERT INTO group_branch_offices (group_id, name, address, address_detail, lat, lon, sido, sigugun, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(seq) + 1 FROM group_branch_offices WHERE group_id = ?), 1))`,
      [req.params.id, name, address, String(req.body.address_detail || '').trim() || null,
        lat, lon, (region && region.sido) || null, (region && region.sigugun) || null, req.params.id]
    );
  } catch (e) {
    if (e && e.code === '23505') return res.redirect(base + '?error=' + encodeURIComponent('같은 이름의 지점이 이미 있습니다.'));
    throw e;
  }
  res.redirect(base + '?saved=' + encodeURIComponent('지점을 등록했습니다.'));
}));

router.post('/:id/office-fares/offices/:officeId/delete', asyncHandler(async (req, res) => {
  // 요금 줄은 외래키(on delete cascade)로 함께 지워진다.
  await db.run('DELETE FROM group_branch_offices WHERE id = ? AND group_id = ?', [req.params.officeId, req.params.id]);
  res.redirect('/groups/' + req.params.id + '/office-fares?saved=' + encodeURIComponent('지점과 그 요금표를 삭제했습니다.'));
}));

// 요금 한 줄 등록. 거리는 지역 청사(시청/군청/구청)까지 실제 경로로 계산해 채운다 —
// 사람이 손으로 넣게 하면 지점마다 기준이 달라진다.
router.post('/:id/office-fares/zones', asyncHandler(async (req, res) => {
  const base = '/groups/' + req.params.id + '/office-fares';
  const officeId = Number(req.body.office_id);
  const sido = officeZoneFare.normSido(req.body.sido);
  const sigugun = officeZoneFare.normSigugun(req.body.sigugun);
  const fare = Math.round(Number(req.body.fare));
  if (!officeId || !sido || !sigugun) return res.redirect(base + '?error=' + encodeURIComponent('지점과 지역을 모두 선택해주세요.'));
  if (!Number.isFinite(fare) || fare < 0) return res.redirect(base + '?error=' + encodeURIComponent('요금을 숫자로 입력해주세요.'));

  const office = await db.get('SELECT * FROM group_branch_offices WHERE id = ? AND group_id = ?', [officeId, req.params.id]);
  if (!office) return res.redirect(base + '?error=' + encodeURIComponent('지점을 찾을 수 없습니다.'));

  // 적힌 시도를 우리 지오코더가 붙이는 시도로 교정한다 — 안 하면 광주처럼 행정구역이 바뀐
  // 지역이 영영 안 맞는다(lib/zoneGeocode.js resolveZoneRegion).
  const resolved = await zoneGeocode.resolveZoneRegion(sido, sigugun);
  const distance = await computeZoneDistance(office, sido, sigugun);
  await upsertZoneFare(officeId, resolved.sido || sido, sigugun, fare, distance);
  res.redirect(base + '?saved=' + encodeURIComponent(
    `${office.name} · ${sido} ${sigugun} 요금을 저장했습니다.` + (distance == null ? ' (거리 계산 실패 — 요금은 저장됐습니다)' : ` (거리 ${distance}km)`)
  ));
}));

router.post('/:id/office-fares/zones/:zoneId/delete', asyncHandler(async (req, res) => {
  await db.run(
    `DELETE FROM group_office_zone_fares WHERE id = ?
      AND office_id IN (SELECT id FROM group_branch_offices WHERE group_id = ?)`,
    [req.params.zoneId, req.params.id]
  );
  res.redirect('/groups/' + req.params.id + '/office-fares?saved=' + encodeURIComponent('요금 줄을 삭제했습니다.'));
}));

// 지역 청사까지의 실제 경로 거리(소수점 한 자리). 실패해도 요금 저장은 막지 않는다 —
// 거리는 안내용이고, 청구 금액은 입력한 요금 그대로다.
async function computeZoneDistance(office, sido, sigugun) {
  const center = await zoneGeocode.lookupZoneCenter(sido, sigugun).catch(() => null);
  if (!center) return null;
  const route = await routeDistance(
    { lat: Number(office.lat), lon: Number(office.lon) },
    { lat: center.lat, lon: center.lon }
  ).catch(() => null);
  return route ? zoneGeocode.roundKm(route.distanceKm) : null;
}

async function upsertZoneFare(officeId, sido, sigugun, fare, distanceKm) {
  // 재등록·재업로드는 덮어쓴다 — 같은 지역이 두 줄이면 어느 금액을 청구할지 알 수 없다.
  await db.run(
    `INSERT INTO group_office_zone_fares (office_id, sido, sigugun, fare, distance_km)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (office_id, sido, sigugun) DO UPDATE SET
       fare = excluded.fare,
       -- 거리 계산이 실패하면(null) 전에 넣어둔 값을 지우지 않는다.
       distance_km = COALESCE(excluded.distance_km, group_office_zone_fares.distance_km),
       updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')`,
    [officeId, sido, sigugun, fare, distanceKm]
  );
}

// ── 엑셀 업로드 ─────────────────────────────────────────────────────────────
// 첨부한 단가표처럼 지역이 수백 줄이라 손으로 넣을 수 없다. 열 이름으로 읽는다(순서 무관) —
// 사람이 만든 표는 열 순서가 자주 바뀐다.
//
// 거리는 비어 있으면 청사 기준으로 자동 계산한다. 줄마다 카카오 API를 두 번(검색+길찾기)
// 부르므로 수백 줄이면 오래 걸린다 — 이미 계산해둔 거리가 있으면 그대로 쓴다.
const OFFICE_SHEET_COLUMNS = {
  office: ['지점', '지점명', '상호', 'office'],
  sido: ['시도', '광역시도', '시·도', 'sido'],
  sigugun: ['시군구', '구분', '시·군·구', '지역', 'sigugun'],
  fare: ['요금', '금액', 'fare'],
  distance: ['km', '거리', 'distance'],
};

function pickColumn(header, keys) {
  const norm = (v) => String(v || '').replace(/\s+/g, '').toLowerCase();
  for (let i = 0; i < header.length; i += 1) {
    const cell = norm(header[i]);
    if (!cell) continue;
    if (keys.some((k) => cell === norm(k))) return i;
  }
  return -1;
}

router.post('/:id/office-fares/upload', officeUpload.single('file'), asyncHandler(async (req, res) => {
  const base = '/groups/' + req.params.id + '/office-fares';
  if (!req.file || !req.file.buffer || !req.file.buffer.length) {
    return res.redirect(base + '?error=' + encodeURIComponent('파일을 선택해주세요.'));
  }

  let rows;
  try {
    rows = await readSheetRows(req.file);
  } catch (e) {
    console.error('지점 구간요금 업로드 파싱 실패:', e.message);
    return res.redirect(base + '?error=' + encodeURIComponent('파일을 읽지 못했습니다. 엑셀(.xlsx) 또는 CSV로 저장해서 올려주세요.'));
  }
  if (!rows.length) return res.redirect(base + '?error=' + encodeURIComponent('내용이 비어 있습니다.'));

  const header = rows[0];
  const col = {};
  Object.entries(OFFICE_SHEET_COLUMNS).forEach(([k, keys]) => { col[k] = pickColumn(header, keys); });
  if (col.office < 0 || col.sigugun < 0 || col.fare < 0) {
    return res.redirect(base + '?error=' + encodeURIComponent('첫 줄에 "지점 · 시도 · 시군구 · 요금" 열 이름이 있어야 합니다. 샘플 양식을 받아 확인해주세요.'));
  }

  const offices = await officeZoneFare.listOffices(req.params.id);
  const byName = new Map(offices.map((o) => [String(o.name).replace(/\s+/g, '').toLowerCase(), o]));

  const result = { saved: 0, skipped: 0, distanceFilled: 0, regionCorrected: 0, errors: [] };
  // 거리 계산은 줄마다 외부 API를 부른다 — 같은 지역이 여러 지점에 반복되므로 한 번만 부른다.
  const centerCache = new Map();
  const regionCache = new Map();

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i] || [];
    const officeName = String(row[col.office] || '').trim();
    const sigugun = officeZoneFare.normSigugun(row[col.sigugun]);
    const fareRaw = String(row[col.fare] == null ? '' : row[col.fare]).replace(/[^0-9.-]/g, '');
    const fare = Math.round(Number(fareRaw));
    if (!officeName && !sigugun) continue; // 빈 줄
    const line = i + 1;

    const office = byName.get(officeName.replace(/\s+/g, '').toLowerCase());
    if (!office) { result.skipped += 1; if (result.errors.length < 20) result.errors.push(`${line}행: 등록되지 않은 지점 "${officeName}"`); continue; }
    if (!sigugun) { result.skipped += 1; if (result.errors.length < 20) result.errors.push(`${line}행: 시군구가 비어 있습니다`); continue; }
    if (!Number.isFinite(fare) || fare < 0) { result.skipped += 1; if (result.errors.length < 20) result.errors.push(`${line}행: 요금을 읽지 못했습니다 ("${row[col.fare]}")`); continue; }

    // 시도가 비면 지점의 시도를 쓴다 — 같은 이름의 구가 여러 시도에 있어서(중구 등)
    // 시도가 없으면 엉뚱한 청사가 잡힌다.
    const sido = officeZoneFare.normSido(col.sido >= 0 ? row[col.sido] : '') || office.sido || '';
    if (!sido) { result.skipped += 1; if (result.errors.length < 20) result.errors.push(`${line}행: 시도를 알 수 없습니다`); continue; }

    let distance = col.distance >= 0 ? zoneGeocode.roundKm(String(row[col.distance] || '').replace(/[^0-9.]/g, '')) : null;
    if (distance == null) {
      const key = `${office.id}|${sido}|${sigugun}`;
      if (!centerCache.has(key)) centerCache.set(key, await computeZoneDistance(office, sido, sigugun));
      distance = centerCache.get(key);
      if (distance != null) result.distanceFilled += 1;
    }

    // 시도 교정(광주→전남 등). 지역마다 외부 조회가 들어가므로 같은 지역은 한 번만 본다.
    const regionKey = `${sido}|${sigugun}`;
    if (!regionCache.has(regionKey)) regionCache.set(regionKey, await zoneGeocode.resolveZoneRegion(sido, sigugun));
    const resolved = regionCache.get(regionKey);
    if (resolved.corrected) result.regionCorrected += 1;

    await upsertZoneFare(office.id, resolved.sido || sido, sigugun, fare, distance);
    result.saved += 1;
  }

  res.redirect(base + '?uploaded=' + encodeURIComponent(JSON.stringify(result)));
}));

// .xlsx와 .csv를 모두 받는다. 엑셀에서 "CSV UTF-8"로 저장해 올리는 사람이 많다.
async function readSheetRows(file) {
  const name = String(file.originalname || '').toLowerCase();
  if (name.endsWith('.csv') || /text\/csv/.test(String(file.mimetype || ''))) {
    return parseCsv(file.buffer.toString('utf8'));
  }
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return [];
  const out = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = [];
    // exceljs의 row.values는 1번부터 시작한다(0번은 비어 있다).
    for (let c = 1; c <= sheet.columnCount; c += 1) {
      const v = row.getCell(c).value;
      // 수식 셀은 { formula, result } 형태로 온다 — 사람이 보는 값은 result다.
      values.push(v && typeof v === 'object' && 'result' in v ? v.result : v);
    }
    out.push(values);
  });
  return out;
}

// 따옴표 안의 쉼표·줄바꿈까지 처리하는 최소 CSV 파서. 엑셀이 내보내는 형식을 그대로 받는다.
function parseCsv(text) {
  const src = text.replace(/^\uFEFF/, ''); // 엑셀 UTF-8 CSV의 BOM
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c || '').trim() !== ''));
}

// 샘플 양식 — 열 이름을 말로 설명하는 것보다 받아서 채우는 편이 확실하다.
router.get('/:id/office-fares/sample', asyncHandler(async (req, res) => {
  const offices = await officeZoneFare.listOffices(req.params.id);
  const example = offices.length ? offices[0].name : '강남지점';
  const lines = [
    ['지점', '시도', '시군구', '요금', 'km'],
    [example, '서울특별시', '강남구', '20000', ''],
    [example, '서울특별시', '강동구', '30000', ''],
    [example, '경기도', '수원시', '30000', ''],
    [example, '경기도', '성남시분당구', '25000', '18.1'],
    [example, '강원특별자치도', '양평군', '90000', ''],
  ];
  // BOM을 붙인다 — 없으면 엑셀이 UTF-8을 못 알아보고 한글이 깨진다.
  const csv = '\uFEFF' + lines.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="office-zone-fares-sample.csv"');
  res.send(csv);
}));

module.exports = router;
module.exports.settlementMonth = settlementMonth;
module.exports.loadSettlement = loadSettlement;
