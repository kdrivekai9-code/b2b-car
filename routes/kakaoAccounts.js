// 카카오 상담톡 채널 ↔ 담당 계정 매핑 관리 — 관리자 전용.
//
// 카카오 고객은 b2b-car 로그인 계정이 없어서(연동 계획서 5.1) 오더를 만들 주체도, 조회 권한을
// 판단할 기준도 없다. 이 매핑이 그 자리를 대신한다.
//   · 접수 자동화(lib/kakaoIntakeService.js) — 이 계정·지사·법인·결제수단으로 오더를 만든다.
//   · 배차 도우미(routes/kakaoConsult.js) — 이 계정 자격으로 주문 조회/변경/취소를 처리한다.
// 매핑이 없는 채널은 둘 다 하지 않고 상담원에게 넘어간다(옵트인).
//
// 조회 우선순위는 lib/kakaoIntakeService.js findIntakeAccount와 같다 —
// 고객 단위(service_key + external_user_key)를 먼저 보고, 없으면 채널 전체(service_key)로 떨어진다.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

async function loadPageData() {
  const [accounts, branches, groups, users, paymentMethods, recentSessions] = await Promise.all([
    db.all(`
      SELECT a.*, u.name AS user_name, u.login_id, b.name AS branch_name, g.name AS group_name, p.name AS payment_name
      FROM kakao_consult_accounts a
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN branches b ON b.id = a.branch_id
      LEFT JOIN groups_tbl g ON g.id = a.requester_group_id
      LEFT JOIN payment_methods p ON p.id = a.payment_method_id
      ORDER BY a.enabled DESC, a.id DESC
    `).catch(() => []),
    db.all("SELECT id, name FROM branches WHERE status = 'active' ORDER BY name"),
    db.all('SELECT id, name, branch_id FROM groups_tbl ORDER BY name'),
    db.all("SELECT id, name, login_id, branch_id FROM users WHERE status = 'active' AND role IN ('client','branch_manager','admin') ORDER BY name"),
    db.all('SELECT id, name FROM payment_methods WHERE is_active = 1 ORDER BY id'),
    // 최근 카카오 세션의 키를 보여줘야 관리자가 service_key를 손으로 옮겨적지 않는다.
    db.all(`
      SELECT DISTINCT ON (kakao_service_key, external_user_key)
        id, kakao_service_key, external_user_key, created_at
      FROM chat_sessions
      WHERE channel = 'kakao' AND kakao_service_key IS NOT NULL
      ORDER BY kakao_service_key, external_user_key, id DESC
      LIMIT 20
    `).catch(() => []),
  ]);
  return { accounts, branches, groups, users, paymentMethods, recentSessions };
}

router.get('/', asyncHandler(async (req, res) => {
  const data = await loadPageData();
  res.render('kakao_accounts/index', {
    title: '카카오 채널 매핑',
    error: req.query.error || null,
    notice: req.query.notice || null,
    ...data,
  });
}));

router.post('/', asyncHandler(async (req, res) => {
  const base = '/kakao-accounts';
  const serviceKey = String(req.body.service_key || '').trim();
  const externalUserKey = String(req.body.external_user_key || '').trim();
  const label = String(req.body.label || '').trim();
  const userId = Number(req.body.user_id);
  const branchId = Number(req.body.branch_id);
  const groupId = Number(req.body.requester_group_id) || null;
  const paymentMethodId = Number(req.body.payment_method_id) || null;
  const autoRegister = req.body.auto_register === '1';
  const enabled = req.body.enabled !== '0';

  if (!serviceKey && !externalUserKey) {
    return res.redirect(base + '?error=' + encodeURIComponent('service_key 또는 고객 키(external_user_key) 중 하나는 입력해야 합니다.'));
  }
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.redirect(base + '?error=' + encodeURIComponent('담당 계정을 선택해주세요.'));
  }
  if (!Number.isInteger(branchId) || branchId <= 0) {
    return res.redirect(base + '?error=' + encodeURIComponent('지사를 선택해주세요.'));
  }
  // 요청 법인은 필수다 — 청구·귀속 정확도뿐 아니라, 담당 계정을 여러 법인 매핑이 함께 쓸 때
  // 조회 범위를 법인으로 가르는 유일한 값이라서다(lib/mcpDispatchAccess.js loadUsageCids).
  // 법인 없이 만들면 그 매핑의 고객이 같은 계정의 다른 법인 접수 건까지 볼 수 있다.
  if (!Number.isInteger(groupId) || groupId <= 0) {
    return res.redirect(base + '?error=' + encodeURIComponent('요청 법인을 선택해주세요.'));
  }
  // 그 지사 소속 법인인지 확인한다 — 폼 조작으로 다른 지사 법인이 들어오는 것 방지.
  const group = await db.get('SELECT id FROM groups_tbl WHERE id = ? AND branch_id = ?', [groupId, branchId]);
  if (!group) return res.redirect(base + '?error=' + encodeURIComponent('선택한 지사에 속한 법인이 아닙니다.'));

  try {
    await db.run(
      `INSERT INTO kakao_consult_accounts
         (service_key, external_user_key, label, user_id, branch_id, requester_group_id, payment_method_id, auto_register, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [serviceKey || null, externalUserKey || null, label || null, userId, branchId, groupId, paymentMethodId, autoRegister, enabled]
    );
  } catch (e) {
    return res.redirect(base + '?error=' + encodeURIComponent('저장에 실패했습니다: ' + e.message));
  }
  res.redirect(base + '?notice=' + encodeURIComponent('채널 매핑이 등록되었습니다.'));
}));

// 자동 등록 스위치만 따로 토글 — 새 채널은 꺼둔 채 파싱 결과를 관찰하다가 켜는 운영을 권장한다.
router.post('/:id/toggle-auto', asyncHandler(async (req, res) => {
  await db.run('UPDATE kakao_consult_accounts SET auto_register = NOT auto_register WHERE id = ?', [req.params.id]);
  res.redirect('/kakao-accounts?notice=' + encodeURIComponent('자동 등록 설정을 변경했습니다.'));
}));

router.post('/:id/toggle-enabled', asyncHandler(async (req, res) => {
  await db.run('UPDATE kakao_consult_accounts SET enabled = NOT enabled WHERE id = ?', [req.params.id]);
  res.redirect('/kakao-accounts?notice=' + encodeURIComponent('사용 여부를 변경했습니다.'));
}));

router.post('/:id/delete', asyncHandler(async (req, res) => {
  await db.run('DELETE FROM kakao_consult_accounts WHERE id = ?', [req.params.id]);
  res.redirect('/kakao-accounts?notice=' + encodeURIComponent('채널 매핑을 삭제했습니다.'));
}));

module.exports = router;
