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
// 오더구분별 대기·취소요금 — 칸 이름과 저장 규칙을 한 곳에서 가져온다.
const tripFees = require('../lib/tripFees');
const clientScope = require('../lib/clientScope');
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
    clientTypes: clientScope.CLIENT_TYPES,
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

  // 법인 계정 구분 — 개인 딜러는 본인 오더만 보고, 별도청구를 켜면 정산서도 따로 받는다.
  const clientType = clientScope.normalizeClientType(req.body.client_type);
  const separate = clientType === 'dealer' && req.body.separate_settlement === '1';

  const hash = await bcrypt.hash(password, 10);
  await db.run(
    `INSERT INTO users (login_id, password_hash, name, phone, role, branch_id, group_id, status,
       client_type, separate_settlement)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [loginId, hash, name, phone, role, branchId, req.params.id, clientType, separate]
  ).catch(async (e) => {
    // 마이그레이션(20260830020000) 전이면 컬럼이 없다 — 계정 생성 자체는 막지 않는다.
    if (!e || e.code !== '42703') throw e;
    console.error('법인 계정 구분 저장 실패(마이그레이션 미적용):', e.message);
    await db.run(
      `INSERT INTO users (login_id, password_hash, name, phone, role, branch_id, group_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      [loginId, hash, name, phone, role, branchId, req.params.id]
    );
  });
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

  // 구분은 별도 UPDATE로 쓴다 — 위 문에 끼우면 마이그레이션 전 DB에서 문 전체가 실패해
  // 이름·연락처·비밀번호 변경까지 함께 날아간다.
  const clientType = clientScope.normalizeClientType(req.body.client_type);
  const separate = clientType === 'dealer' && req.body.separate_settlement === '1';
  await db.run('UPDATE users SET client_type=?, separate_settlement=? WHERE id=?',
    [clientType, separate, user.id])
    .catch((e) => {
      if (e && e.code === '42703') return; // 마이그레이션 20260830020000 전
      console.error('법인 계정 구분 저장 실패(무시):', e.message);
    });
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
  // 지점 구간요금은 이 화면 안에서 켜고 끈다(사용자 지시) — 등록 현황을 함께 보여줘야
  // "켜져 있는데 표가 비어 있다"를 알아챌 수 있다.
  const offices = await officeZoneFare.listOffices(groupId);
  let officeZoneCount = 0;
  for (const o of offices) officeZoneCount += (await officeZoneFare.listZoneFares(o.id)).length;
  return {
    group, groups, tiers, extra, branchTiers, branchExtra: branchExtra || {},
    officeCount: offices.length,
    officeZoneCount,
    placeRules: placeRules || [],
    tollRules: tollRules || [],
    extraCostItems: fareSurcharge.extraCostStates(extra),
    specialTollPresets: fareSurcharge.SPECIAL_TOLL_PRESETS,
    extraCostModes: fareSurcharge.EXTRA_COST_MODES,
    ...largeCar,
  };
}

router.get('/:id/fare-rules', asyncHandler(async (req, res) => {
  const page = await loadGroupFarePage(req.params.id);
  if (!page.group) return res.status(404).send('법인을 찾을 수 없습니다.');
  res.render('groups/fare_rules', {
    title: '탁송 요금 - ' + page.group.name,
    ...page,
    // 오더구분별 대기·취소요금 칸 정의. 화면에 필드명을 또 적으면 컬럼이 늘 때 한쪽만 바뀐다.
    orderTypeFeeGroups: tripFees.ORDER_TYPE_FEE_GROUPS,
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
  // 위 복사문이 컬럼을 손으로 나열하는 방식이라 여기서 빠지면 복사한 쪽만 조용히 0원이 된다.
  // 지사 표(extra)와 법인 표는 칸 이름이 같아 그대로 넘기면 복사가 된다.
  await tripFees.saveOrderTypeFees(db, 'group_fare_extra_settings', 'group_id', req.params.id, extra)
    .catch((e) => console.error('오더구분별 요금 복사 실패:', e.message));
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

  // 정산서 할증 표시 방식(사용자 지시: 법인별로 고른다). 총 청구액은 어느 쪽이든 같고
  // 표시만 달라진다 — 그래서 요금 저장과 같이 두어도 금액에 영향이 없다.
  // 지점 구간요금 우선 적용. 체크박스는 켜졌을 때만 올라오므로 숨은 필드('0')와 함께 온다.
  const officeFareEnabled = checkboxDefaultOn(req.body.office_fare_enabled);
  await db.run('UPDATE groups_tbl SET office_fare_enabled = ? WHERE id = ?', [officeFareEnabled, req.params.id])
    .catch((e) => {
      if (e && e.code === '42703') return; // 마이그레이션 20260829030000 전
      console.error('지점 구간요금 사용 여부 저장 실패(무시):', e.message);
    });
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
  // 오더구분별 대기·취소요금도 같은 이유로 여기서 저장한다(UPDATE라 행이 만들어진 뒤여야 한다).
  await tripFees.saveOrderTypeFees(db, 'group_fare_extra_settings', 'group_id', req.params.id, req.body);
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
// dealerUserId를 주면 그 딜러가 접수한 건만 본다(딜러 본인 조회).
async function loadSettlement(groupId, month, dealerUserId = null) {
  // 조회 실패를 .catch로 삼켜 빈 목록을 돌려주면 "이 달은 실적이 없다"로 읽힌다 — 정산 화면에서
  // 그건 그냥 오류보다 나쁘다. 던져서 오류 화면이 뜨게 둔다.
  //
  // 다만 차종 분류 컬럼만은 예외다. 마이그레이션(20260828040000) 전에는 그 컬럼이 없는데,
  // 그것 때문에 정산 화면 전체가 안 열리면 배포와 마이그레이션 사이에 정산 업무가 멈춘다.
  // 분류는 보조 정보라 빠져도 정산 금액에는 영향이 없다 — 그 컬럼만 빼고 다시 조회한다.
  const SETTLEMENT_SQL = (vehicleCols, dealerCols, onlyMineSql) => `
    SELECT o.id, o.oid, o.reserved_date, o.reserved_time, o.vehicle_number,
           o.fare_surcharges_json, o.wait_fee_amount, o.wait_fee_note,
           o.cancel_fee_amount, o.cancel_fee_note,
           o.settled_at, o.settled_by, su.name AS settled_by_name,
           -- 누가 접수했는지 — 개인 딜러별로 정산서를 나누려면 이 값이 필요하다.
           o.created_by, cu.name AS created_by_name, cu.login_id AS created_by_login,
           ${dealerCols}
           ${vehicleCols}
           o.origin_address, o.origin_address_detail,
           o.destination_address, o.destination_address_detail,
           o.fare_amount, o.ferry_fare_amount,
           h.completed_at
      FROM orders o
      LEFT JOIN users su ON su.id = o.settled_by
      LEFT JOIN users cu ON cu.id = o.created_by
      JOIN (
        -- 어느 달로 묶을지 정하는 시각. 완료 건은 완료 시각, 취소 건은 취소 시각이다 —
        -- 취소 건에는 완료 이력이 없어서 '완료'만 보면 조인에서 통째로 빠진다.
        SELECT order_id, MAX(created_at) AS completed_at
          FROM order_status_history
         WHERE new_status IN ('완료', '취소')
         GROUP BY order_id
      ) h ON h.order_id = o.id
     WHERE o.requester_group_id = ?
       -- 개인 딜러가 자기 정산서를 볼 때는 본인이 접수한 건만 본다.
       ${onlyMineSql}
       -- 완료 건이 정산 대상이다. 다만 **취소요금이 붙은 취소 건**은 청구할 금액이 있으므로
       -- 함께 넣는다 — 예전에는 완료만 봐서, 취소요금을 계산해 저장해도 청구할 방법이 없었다.
       AND (o.status = '완료' OR (o.status = '취소' AND COALESCE(o.cancel_fee_amount, 0) > 0))
       AND SUBSTRING(h.completed_at, 1, 7) = ?
     ORDER BY h.completed_at ASC, o.id ASC
  `;
  // 딜러 본인 조회면 WHERE를 한 겹 더 좁힌다. 조각을 문자열로 끼우되 값은 바인딩한다.
  const onlyMine = dealerUserId ? 'AND o.created_by = ?' : '';
  const params = dealerUserId ? [groupId, dealerUserId, month] : [groupId, month];

  // 선택 컬럼이 없는 DB(마이그레이션 전)에서도 정산 화면은 열려야 한다 — 보조 정보 때문에
  // 정산 업무가 멈추면 안 된다. 차종 분류와 딜러 구분을 각각 빼면서 다시 시도한다.
  const DEALER_COLS = 'cu.client_type AS created_by_client_type, cu.separate_settlement AS created_by_separate,';
  const VEHICLE_COLS = 'o.vehicle_type, o.car_type, o.fuel_type, o.vehicle_class_source,';
  const sqlFor = (vehicleCols, dealerCols) => SETTLEMENT_SQL(vehicleCols, dealerCols, onlyMine);

  let rows = null;
  // 넓은 것부터 좁혀간다. 한 번에 다 빼면 있는 정보까지 버리게 된다.
  const attempts = [
    [VEHICLE_COLS, DEALER_COLS],
    [VEHICLE_COLS, ''],          // 딜러 구분 컬럼 없음(20260830020000 전)
    ['o.vehicle_type,', ''],     // 차종 분류도 없음(20260828020000 전)
  ];
  for (const [vc, dc] of attempts) {
    try {
      rows = await db.all(sqlFor(vc, dc), params);
      break;
    } catch (e) {
      if (!e || e.code !== '42703') throw e;
      console.error('정산: 선택 컬럼 없음 — 그 열을 빼고 다시 조회합니다:', e.message);
    }
  }
  if (rows === null) throw new Error('정산 조회에 실패했습니다.');

  // 할증을 정산서에 어떻게 보여줄지는 법인이 고른다(사용자 지시).
  //   included  운행요금 한 줄로 두고 내역만 밝힌다 (기본값 = 지금 동작)
  //   itemized  운행요금에서 할증을 떼어 별도 줄로 보여준다
  //
  // **어느 쪽이든 총 청구액은 같다.** 저장된 금액(fare_amount)은 하나이고 모드는 표시 방식일
  // 뿐이다. 그래야 모드를 바꿔도 과거 정산서의 총액이 흔들리지 않는다.
  // 표시 방식은 법인 설정에서 읽는다. loadSettlement는 groupId만 받으므로(호출부가 여럿)
  // 여기서 직접 조회한다 — 호출부마다 넘기게 하면 한 곳만 빠뜨려도 모드가 조용히 무시된다.
  const modeRow = await db.get('SELECT settlement_surcharge_mode FROM groups_tbl WHERE id = ?', [groupId])
    .catch(() => null); // 마이그레이션 전이면 컬럼이 없다 — 기본값(포함)으로 돈다.
  const surchargeMode = String((modeRow && modeRow.settlement_surcharge_mode) || 'included').trim() === 'itemized'
    ? 'itemized' : 'included';

  // 도선료는 탁송료와 별개로 청구되는 실비다 — 합계에서 빠지면 정산서와 맞지 않는다.
  const items = rows.map((r) => {
    const fare = Number(r.fare_amount) || 0;
    const ferry = Number(r.ferry_fare_amount) || 0;
    let surcharges = [];
    try { surcharges = JSON.parse(r.fare_surcharges_json || '[]') || []; } catch (e) { surcharges = []; }
    const surchargeTotal = surcharges.reduce((s2, it) => s2 + (Number(it.amount) || 0), 0);
    // 대기·취소요금은 fare_amount에 합치지 않고 따로 저장한다(lib/tripFees.js) — 정산서에서
    // 구간요금·할증과 나란히 보여야 한다.
    const waitFee = Number(r.wait_fee_amount) || 0;
    const cancelFee = Number(r.cancel_fee_amount) || 0;
    return {
      ...r, fare, ferry,
      // 총액에 대기·취소요금을 더한다. 도선료는 기타 정산으로 옮겨(사용자 지시) 여기서 뺀다 —
      // 총 청구액에는 아래 extraSummary를 통해 그대로 들어간다.
      // 계산은 tripFees.billableTripFare 한 곳에서 한다 — 사진 전송리스트도 같은 함수를 쓴다.
      // 두 화면이 같은 오더를 두고 다른 금액을 말하면 그 차이를 해명하는 데 시간이 다 든다.
      total: tripFees.billableTripFare(r),
      surcharges,
      surchargeTotal,
      waitFee,
      cancelFee,
      // 구간요금은 빼서 구한다 — 저장된 청구액에서 역산하므로 합이 항상 맞는다.
      // 관리자가 요금을 손으로 고쳤어도 그 차이는 구간요금 쪽이 흡수한다(할증은 사실이다).
      baseFare: fare - surchargeTotal,
      settled: !!r.settled_at,
    };
  });
  const sum = (key) => items.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
  const summary = {
    count: items.length,
    fare: sum('fare'),
    ferry: sum('ferry'),
    total: sum('total'),
    surcharge: sum('surchargeTotal'),
    base: sum('baseFare'),
    wait: sum('waitFee'),
    cancel: sum('cancelFee'),
    settledCount: items.filter((r) => r.settled).length,
  };
  // 할증을 항목별로 묶은 합계 — itemized 모드에서 별도 줄로 보여준다.
  const surchargeByLabel = {};
  items.forEach((r) => r.surcharges.forEach((it) => {
    const label = String(it.label || it.code || '할증');
    if (!surchargeByLabel[label]) surchargeByLabel[label] = { count: 0, amount: 0 };
    surchargeByLabel[label].count += 1;
    surchargeByLabel[label].amount += Number(it.amount) || 0;
  }));

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
           e.settled_at, e.settled_by, e.settle_mode, eu.name AS settled_by_name,
           o.oid, o.reserved_date, o.vehicle_number,
           o.origin_address, o.origin_address_detail
      FROM order_extra_charges e
      JOIN orders o ON o.id = e.order_id
      LEFT JOIN users eu ON eu.id = e.settled_by
     WHERE e.billable = true
       -- 접수 때 "주유 가득"으로 잡아둔 줄은 금액을 아직 모른다(amount 0). 0원 줄이 정산서에
       -- 올라가면 받는 쪽이 무엇을 청구받는지 알 수 없다 — 영수증이 들어와 금액이 채워지면
       -- 그때 자동으로 나타난다.
       AND e.amount > 0
       AND e.order_id IN (${items.map(() => '?').join(',')})
     ORDER BY COALESCE(e.charged_on, o.reserved_date), e.id
  `, items.map((r) => r.id)) : [];

  // 정산 방식(월/개별)은 요금설정에서 온다. 청구한 뒤 설정이 바뀌어도 이미 청구한 건의 구분이
  // 따라 바뀌면 안 되므로, 줄에 박아둔 값(settle_mode)이 있으면 그것을 우선한다.
  const feeExtra = await db.get(
    'SELECT * FROM group_fare_extra_settings WHERE group_id = ?', [groupId]
  ).catch(() => null);

  const extras = extraRows.map((r) => ({
    ...r,
    amount: Number(r.amount) || 0,
    // 일자를 안 넣은 줄은 오더 예약일로 본다 — 저장할 때도 같은 규칙을 쓰지만(lib/extraCharges.js),
    // 그 규칙이 생기기 전에 들어간 줄이 빈 칸으로 남지 않도록 여기서도 받아준다.
    charged_on: r.charged_on || r.reserved_date || null,
    settleMode: r.settle_mode || fareSurcharge.settleModeOf(feeExtra, r.charge_type),
    settled: !!r.settled_at,
  }));

  // 도선료는 orders.ferry_fare_amount에서 온다. 데이터를 옮기지 않고 정산서에서만 기타 정산으로
  // 보여준다(사용자 지시) — 옮기면 기존 오더를 모두 손봐야 하고 되돌리기 어렵다.
  // 정산완료 상태는 그 오더의 상태를 따른다(별도 줄이 아니라 오더의 일부이기 때문).
  items.filter((r) => r.ferry > 0).forEach((r) => {
    extras.push({
      id: `ferry-${r.id}`,
      order_id: r.id,
      charge_type: '도선료',
      amount: r.ferry,
      charged_on: r.reserved_date || null,
      note: null,
      oid: r.oid,
      vehicle_number: r.vehicle_number,
      origin_address: r.origin_address,
      origin_address_detail: r.origin_address_detail,
      settleMode: fareSurcharge.settleModeOf(feeExtra, '도선료'),
      settled: r.settled,
      settled_at: r.settled_at,
      settled_by_name: r.settled_by_name,
      // 이 줄은 order_extra_charges 행이 아니다 — 개별 정산완료 처리 대상이 아님을 표시한다.
      derived: true,
    });
  });
  extras.sort((a, b) => String(a.charged_on || '').localeCompare(String(b.charged_on || '')));

  // **월 정산서의 청구 총액에는 월정산 항목만 넣는다.**
  //
  // 개별정산은 건별 청구서로 따로 청구한다(요금설정에서 그렇게 정한 항목이다). 둘 다 총액에
  // 넣으면 같은 금액을 월 정산서와 건별 청구서로 **두 번 청구**하게 된다 — 실제로 그랬다.
  // 목록에는 그대로 보여준다(무엇이 있는지는 알아야 한다). 총액에서만 뺀다.
  const monthlyExtras = extras.filter((e) => e.settleMode !== 'individual');
  const extraSummary = extraCharges.summarize(monthlyExtras);
  // 월정산 / 개별정산으로 갈라 보여준다(사용자 지시 — 입금관리 목적).
  extraSummary.byMode = { monthly: { count: 0, amount: 0 }, individual: { count: 0, amount: 0 } };
  extras.forEach((e) => {
    const bucket = extraSummary.byMode[e.settleMode] || extraSummary.byMode.monthly;
    bucket.count += 1;
    bucket.amount += e.amount;
  });
  extraSummary.settledCount = extras.filter((e) => e.settled).length;
  // 목록에 보이는 줄 수(개별정산 포함)와 청구에 든 건수는 다르다 — 화면이 헷갈리지 않게 나눈다.
  extraSummary.listedCount = extras.length;

  // 고를 수 있는 달 — 이 법인에 완료 오더가 있는 달만 보여준다. 빈 달을 늘어놓을 이유가 없다.
  const months = await db.all(`
    SELECT DISTINCT SUBSTRING(h.created_at, 1, 7) AS month
      FROM orders o
      JOIN order_status_history h ON h.order_id = o.id AND h.new_status IN ('완료', '취소')
     WHERE o.requester_group_id = ?
       AND (o.status = '완료' OR (o.status = '취소' AND COALESCE(o.cancel_fee_amount, 0) > 0))
     ORDER BY 1 DESC
  `, [groupId]);

  // ── 청구 주체별로 나눈다 ──────────────────────────────────────────────────
  //
  // 개인 딜러 중 "별도 정산 청구"로 지정된 사람은 정산서를 따로 받는다. 나머지(본사 직원 +
  // 별도청구를 안 하는 딜러)는 본사 정산서에 합쳐진다.
  //
  // 딜러라고 무조건 나누지 않는다 — 오더는 본인 것만 보되 정산은 본사가 한꺼번에 받는 계약이
  // 흔하다. 그 둘은 별개라 users.separate_settlement로만 가른다.
  //
  // 합계는 여기서 한 번만 낸다. 화면에서 다시 더하면 구분별 합과 총합이 갈릴 수 있는데,
  // 정산에서 그건 가장 나쁜 종류의 버그다.
  const sumOf = (rows) => ({
    count: rows.length,
    fare: rows.reduce((a, r) => a + r.fare, 0),
    ferry: rows.reduce((a, r) => a + r.ferry, 0),
    total: rows.reduce((a, r) => a + r.total, 0),
  });
  const extrasOfOrders = (rows) => {
    const ids = new Set(rows.map((r) => r.id));
    return extras.filter((e) => ids.has(e.order_id));
  };

  const separateByUser = new Map();
  const hqItems = [];
  items.forEach((r) => {
    const isSeparateDealer = r.created_by_client_type === 'dealer' && r.created_by_separate === true;
    if (!isSeparateDealer || !r.created_by) { hqItems.push(r); return; }
    const key = String(r.created_by);
    if (!separateByUser.has(key)) {
      separateByUser.set(key, { userId: r.created_by, name: r.created_by_name || '(이름 없음)', loginId: r.created_by_login || '', rows: [] });
    }
    separateByUser.get(key).rows.push(r);
  });

  const buildGroup = (key, label, sub, rows) => {
    const ex = extrasOfOrders(rows);
    const exSum = extraCharges.summarize(ex);
    const s2 = sumOf(rows);
    return { key, label, sub, items: rows, summary: s2, extras: ex, extraSummary: exSum, grandTotal: s2.total + exSum.total };
  };

  const settlementGroups = [];
  // 본사 묶음은 건이 없어도 보여준다 — 딜러만 나오면 "본사 몫이 0원인지, 화면이 빠뜨린 건지"
  // 알 수 없다. 다만 딜러가 하나도 없으면 굳이 나눌 이유가 없어 통째로 생략한다.
  if (separateByUser.size) {
    settlementGroups.push(buildGroup('hq', '법인 본사', '본사 직원 + 별도청구를 하지 않는 딜러', hqItems));
    [...separateByUser.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
      .forEach((d) => settlementGroups.push(
        buildGroup(`dealer:${d.userId}`, d.name, `개인 딜러${d.loginId ? ` · ${d.loginId}` : ''}`, d.rows)
      ));
  }

  return {
    items, summary, extras, extraSummary, surchargeMode, surchargeByLabel,
    // 거래처에 실제로 청구할 금액 — 운행요금과 실비를 더한 값이다. 화면에서 다시 더하면
    // 목록과 통계가 갈릴 수 있어 여기서 한 번만 계산한다.
    grandTotal: summary.total + extraSummary.total,
    // 별도청구 딜러가 없으면 빈 배열 — 화면은 그때 예전처럼 한 덩어리로만 보여준다.
    settlementGroups,
    months: months.map((m) => m.month).filter(Boolean),
  };
}

// 정산내역 엑셀 내려받기.
//
// 왜 필요한가: 정산은 결국 거래처와 숫자를 맞추는 일이라, 받는 쪽이 자기 회계 양식에 옮겨
// 붙일 수 있어야 한다. 인쇄물(PDF)만으로는 숫자를 다시 쳐 넣어야 하고 그 과정에서 틀린다.
//
// 화면·인쇄물과 **같은 loadSettlement 결과**를 쓴다. 여기서 다시 더하면 세 곳의 숫자가
// 갈릴 수 있는데, 정산에서 그건 가장 나쁜 종류의 버그다.
//
// exceljs는 이미 요금표 업로드에 쓰고 있어 의존성이 늘지 않는다.
router.get('/:id/settlement/excel', asyncHandler(async (req, res) => {
  const group = await db.get(`
    SELECT g.*, b.name AS branch_name FROM groups_tbl g
      LEFT JOIN branches b ON b.id = g.branch_id WHERE g.id = ?`, [req.params.id]);
  if (!group) return res.status(404).send('법인을 찾을 수 없습니다.');

  const month = settlementMonth(req.query.month);
  const data = await loadSettlement(req.params.id, month);
  const itemized = data.surchargeMode === 'itemized';

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'B2B-CAR';

  // ── 시트 1: 운행요금 ──
  const ws = wb.addWorksheet('운행요금');
  ws.addRow([`${group.name} 정산내역`]);
  ws.addRow([`${month} (완료일 기준)`]);
  ws.addRow([]);
  const headerRowIndex = ws.rowCount + 1;
  // 별도 줄 방식이면 기본요금과 할증을 나눠 보여준다 — 화면과 같은 규칙이다.
  const head = ['No', '예약일', '차종', '차량번호', '출발지', '도착지'];
  if (itemized) head.push('기본요금', '할증');
  else head.push('운행요금');
  head.push('도선료', '합계', '완료일');
  ws.addRow(head);

  data.items.forEach((r, i) => {
    const row = [
      i + 1,
      r.reserved_date || '',
      r.vehicle_type || '',
      r.vehicle_number || '',
      [r.origin_address, r.origin_address_detail].filter(Boolean).join(' '),
      [r.destination_address, r.destination_address_detail].filter(Boolean).join(' '),
    ];
    if (itemized) row.push(r.baseFare, r.surchargeTotal);
    else row.push(r.fare);
    row.push(r.ferry, r.total, r.completed_at || '');
    ws.addRow(row);
  });

  const totalRow = ['', '', '', '', '', '합계'];
  if (itemized) {
    totalRow.push(data.summary.base, data.summary.surcharge);
  } else {
    totalRow.push(data.summary.fare);
  }
  totalRow.push(data.summary.ferry, data.summary.total, '');
  ws.addRow(totalRow);

  // ── 시트 2: 기타 정산(실비) ──
  if (data.extras && data.extras.length) {
    const ws2 = wb.addWorksheet('기타 정산');
    ws2.addRow(['일자', 'OID', '항목', '금액', '별도청구', '비고']);
    data.extras.forEach((e) => {
      ws2.addRow([e.charged_on || '', e.oid || '', e.charge_type || '', Number(e.amount) || 0,
        e.billable ? 'O' : '', e.note || '']);
    });
    ws2.addRow(['', '', '합계', data.extraSummary.total, '', '']);
    ws2.getRow(1).font = { bold: true };
    ws2.columns.forEach((c) => { c.width = 16; });
    ws2.getColumn(6).width = 30;
  }

  // ── 서식 ──
  ws.getRow(1).font = { bold: true, size: 14 };
  ws.getRow(headerRowIndex).font = { bold: true };
  ws.getRow(ws.rowCount).font = { bold: true };
  // 금액 칸은 천 단위 구분을 넣는다 — 정산서에서 자릿수를 눈으로 세게 하면 안 된다.
  // 별도 줄 방식이면 금액 칸이 하나 더 있어(기본요금/할증) 범위가 7~10, 아니면 7~9다.
  const moneyTo = itemized ? 10 : 9;
  for (let c = 7; c <= moneyTo; c += 1) ws.getColumn(c).numFmt = '#,##0';
  ws.columns.forEach((c, i) => { c.width = i >= 4 && i <= 5 ? 34 : 14; });

  // 파일명에 법인명과 월을 넣는다 — 여러 법인 것을 받아두면 파일명만으로 구분돼야 한다.
  // 한글 파일명은 브라우저마다 깨져서 RFC 5987(filename*)로 준다.
  const filename = `정산내역_${group.name}_${month}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',
    `attachment; filename="settlement_${month}.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  await wb.xlsx.write(res);
  res.end();
}));

// 정산완료 처리 — 사용자 확정: "정산완료"와 "결재완료"는 같은 것이다. 상태는 하나만 둔다.
//
// 체크한 줄만 한 번에 바꾼다(사용자 지시 — 입금관리는 목록에서 여러 건을 한꺼번에 처리한다).
// 완료 시각과 처리한 계정을 함께 남긴다 — 시각만 남기면 "누가 확정했나"를 못 찾고, 입금
// 대사에서 문제가 생겼을 때 되짚을 수 없다.
router.post('/:id/settlement/settle', asyncHandler(async (req, res) => {
  const month = settlementMonth(req.body.month);
  const back = `/groups/${req.params.id}/settlement?month=${encodeURIComponent(month)}`;
  const arr = (v) => [].concat(v || []).map((x) => Number(x)).filter(Number.isFinite);
  const orderIds = arr(req.body.order_id);
  const extraIds = arr(req.body.extra_id);
  // 되돌리기도 같은 화면에서 한다 — 잘못 누른 것을 되돌릴 길이 없으면 아무도 안 쓴다.
  const undo = String(req.body.action || '') === 'unsettle';
  if (!orderIds.length && !extraIds.length) {
    return res.redirect(back + '&saved=' + encodeURIComponent('선택된 항목이 없습니다.'));
  }

  const now = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const userId = req.session.user.id;
  let done = 0;

  // 다른 법인의 줄이 넘어오지 않도록 소속을 함께 확인한다 — id만 믿으면 URL을 손봐 남의
  // 정산을 확정할 수 있다.
  if (orderIds.length) {
    const r = await db.run(
      `UPDATE orders SET settled_at = ${undo ? 'NULL' : '?'}, settled_by = ${undo ? 'NULL' : '?'}
        WHERE requester_group_id = ? AND id IN (${orderIds.map(() => '?').join(',')})`,
      undo ? [req.params.id, ...orderIds] : [now, userId, req.params.id, ...orderIds]
    );
    done += r.rowCount || 0;
  }
  if (extraIds.length) {
    const r = await db.run(
      `UPDATE order_extra_charges SET settled_at = ${undo ? 'NULL' : '?'}, settled_by = ${undo ? 'NULL' : '?'}
        WHERE id IN (${extraIds.map(() => '?').join(',')})
          AND order_id IN (SELECT id FROM orders WHERE requester_group_id = ?)`,
      undo ? [...extraIds, req.params.id] : [now, userId, ...extraIds, req.params.id]
    );
    done += r.rowCount || 0;
  }

  res.redirect(back + '&saved=' + encodeURIComponent(
    undo ? `${done}건을 미정산으로 되돌렸습니다.` : `${done}건을 정산완료로 변경했습니다. (${now})`
  ));
}));

// 정산서 할증 표시 방식 저장. 정산내역 화면 상단에서 바꾼다(사용자 지시) — 이 설정이 바꾸는
// 것은 정산서의 줄 구성뿐이라, 요금을 설정하는 화면보다 정산서를 보는 화면에 있어야 맞다.
//
// 요금 저장(POST /fare-rules)에서는 뺐다. 필드가 없는 폼이 저장을 지나가면 매번 'included'로
// 덮어써서 설정이 조용히 초기화된다.
router.post('/:id/settlement/surcharge-mode', asyncHandler(async (req, res) => {
  const mode = String(req.body.settlement_surcharge_mode || '').trim() === 'itemized' ? 'itemized' : 'included';
  const month = settlementMonth(req.body.month);
  await db.run('UPDATE groups_tbl SET settlement_surcharge_mode = ? WHERE id = ?', [mode, req.params.id])
    .catch((e) => {
      if (e && e.code === '42703') return; // 마이그레이션 20260829020000 전
      console.error('정산 할증 표시 방식 저장 실패(무시):', e.message);
    });
  // 보던 달로 돌아간다 — 이번 달로 튕기면 방금 확인하던 정산서를 다시 찾아야 한다.
  res.redirect(`/groups/${req.params.id}/settlement?month=${encodeURIComponent(month)}&saved=`
    + encodeURIComponent(mode === 'itemized' ? '할증을 별도 줄로 표시합니다.' : '할증을 운행요금에 포함해 표시합니다.'));
}));

// 개별정산 건별 청구서 — 개별정산으로 설정한 기타 정산 항목을 건마다 한 장씩 뽑는다.
//
// 월정산은 월 정산서 한 장에 모아 청구하지만, 개별정산은 건별로 따로 청구한다(요금설정에서
// 그렇게 정한 항목이다). 그런데 월 정산서만 있어서 개별정산 건을 뽑을 방법이 없었다.
//
// 한 문서에 여러 장을 담는다 — 건마다 창을 열게 하면 열 건이면 열 번 뽑아야 한다.
// 인쇄할 때 건마다 페이지가 나뉜다.
router.get('/:id/settlement/individual-print', asyncHandler(async (req, res) => {
  const group = await db.get(`
    SELECT g.*, b.name AS branch_name, b.main_phone AS branch_phone,
           b.bank_name, b.bank_account, b.bank_holder
      FROM groups_tbl g LEFT JOIN branches b ON b.id = g.branch_id
     WHERE g.id = ?`, [req.params.id]);
  if (!group) return res.status(404).send('법인을 찾을 수 없습니다.');
  const month = settlementMonth(req.query.month);
  const data = await loadSettlement(req.params.id, month);

  // 고른 줄만 뽑는다. 안 고르면 그 달의 개별정산 전부 — 월말에 한꺼번에 뽑는 흐름이 자연스럽다.
  const picked = String(req.query.ids || '').split(',').map((v) => v.trim()).filter(Boolean);
  const items = data.extras.filter((e) => {
    // 도선료처럼 오더에서 파생된 줄은 별도 청구서 대상이 아니다 — 운행요금과 함께 청구된다.
    if (e.derived) return false;
    if (picked.length) return picked.includes(String(e.id));
    return e.settleMode === 'individual';
  });

  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  res.render('groups/settlement_individual_print', {
    group,
    month,
    items,
    total: items.reduce((a, e) => a + (Number(e.amount) || 0), 0),
    issuedOn: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`,
    issuedBy: (req.session.user && req.session.user.name) || '',
  });
}));

// 정산내역서 출력 — 내부 결재용 서류.
//
// 화면(settlement)과 같은 데이터를 쓰되 레이아웃이 다르다: 결재란·공급자/공급받는자·발행일이
// 있고, 헤더/사이드바 없이 종이 한 장으로 떨어져야 한다. 그래서 공용 레이아웃을 쓰지 않는다.
//
// 새 창으로 연다(사용자 지시) — 목록을 보던 화면을 잃지 않고 인쇄만 하고 닫을 수 있어야 한다.
router.get('/:id/settlement/print', asyncHandler(async (req, res) => {
  const group = await db.get(`
    SELECT g.*, b.name AS branch_name, b.main_phone AS branch_phone,
           b.address AS branch_address, b.contact_name AS branch_contact,
           b.bank_name, b.bank_account, b.bank_holder
      FROM groups_tbl g LEFT JOIN branches b ON b.id = g.branch_id
     WHERE g.id = ?`, [req.params.id]);
  if (!group) return res.status(404).send('법인을 찾을 수 없습니다.');
  const month = settlementMonth(req.query.month);
  const data = await loadSettlement(req.params.id, month);

  const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // 발행일은 KST
  res.render('groups/settlement_print', {
    group,
    month,
    issuedOn: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`,
    issuedBy: (req.session.user && req.session.user.name) || '',
    extraChargeTypes: extraCharges.EXTRA_CHARGE_TYPES,
    ...data,
  });
}));

router.get('/:id/settlement', asyncHandler(async (req, res) => {
  const { group, groups } = await loadGroupWithSiblings(req.params.id);
  if (!group) return res.status(404).send('법인을 찾을 수 없습니다.');
  const month = settlementMonth(req.query.month);

  // 개인 딜러가 열면 본인이 접수한 건만 본다. 자기 법인이 아니면 아예 막는다 —
  // 이 화면은 금액이 나오는 곳이라 목록만 좁히는 것으로는 부족하다.
  const me = req.session.user;
  const meIsDealer = clientScope.isDealer(me);
  if (me.role === 'client' && Number(me.group_id) !== Number(req.params.id)) {
    return res.status(403).render('403', { title: '접근 권한 없음' });
  }
  // 관리자·지사장은 특정 딜러만 골라 볼 수 있다(정산서를 딜러별로 끊어 보내는 흐름).
  const viewDealerId = meIsDealer ? me.id : (Number(req.query.dealer) || null);
  const data = await loadSettlement(req.params.id, month, viewDealerId);

  res.render('groups/settlement', {
    title: '정산내역 - ' + group.name,
    group, groups, month,
    saved: req.query.saved || null,
    extraChargeTypes: extraCharges.EXTRA_CHARGE_TYPES,
    // 딜러 본인 화면은 구분 표를 보여줄 이유가 없다(자기 것 하나뿐이다).
    meIsDealer, viewDealerId,
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

// ── 법인 계정용 「내 정산내역」 ────────────────────────────────────────────
//
// 위 /groups 라우터는 관리자 전용이라(router.use requireRole('admin')) 법인 계정은 그 안의
// 정산 화면을 열 수 없다. 그래서 같은 데이터를 쓰는 별도 라우터를 둔다.
//
// 개인 딜러  → 본인이 접수한 건만
// 본사 직원  → 법인 전체(소속 딜러 포함)
const myRouter = express.Router();
myRouter.use(requireAuth, requireRole('client'));

myRouter.get('/', asyncHandler(async (req, res) => {
  const me = req.session.user;
  if (!me.group_id) return res.status(403).render('403', { title: '접근 권한 없음' });

  const group = await db.get(`
    SELECT g.*, b.name AS branch_name FROM groups_tbl g
      LEFT JOIN branches b ON b.id = g.branch_id WHERE g.id = ?`, [me.group_id]);
  if (!group) return res.status(404).send('법인을 찾을 수 없습니다.');

  const month = settlementMonth(req.query.month);
  const meIsDealer = clientScope.isDealer(me);
  // 본사 직원이 특정 딜러만 골라 보는 것도 허용한다 — 딜러에게 정산서를 전달할 때 쓴다.
  const viewDealerId = meIsDealer ? me.id : (Number(req.query.dealer) || null);
  const data = await loadSettlement(me.group_id, month, viewDealerId);

  res.render('groups/settlement', {
    title: '정산내역',
    group,
    // 법인 전환 선택박스는 띄우지 않는다 — 자기 법인 하나뿐이다.
    groups: [],
    month,
    saved: null,
    extraChargeTypes: extraCharges.EXTRA_CHARGE_TYPES,
    meIsDealer, viewDealerId,
    // 관리자 화면과 같은 뷰를 쓰되, 관리자 전용 동작(정산 확정 등)은 뷰가 role로 가린다.
    clientView: true,
    ...data,
  });
}));

module.exports = router;
module.exports.myRouter = myRouter;
module.exports.settlementMonth = settlementMonth;
module.exports.loadSettlement = loadSettlement;
