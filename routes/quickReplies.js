// 상담원 빠른 답변(상용구) 관리 — 관리자 전용.
//
// 상담원이 매번 손으로 치던 반복 문구를 등록해 두고 채팅 입력창 옆에서 골라 넣는다.
// AI 초안(chat_suggestions)과는 성격이 다르다 — 초안은 고객 발화를 이해해야 만들어지는
// 상황 의존적 제안이고, 이건 상황과 무관하게 언제든 꺼내 쓰는 고정 문구다.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// 본문의 치환 토큰을 실제 값으로 바꾼다. 지금은 {상담원} 하나 — 인사말을 공용으로 쓰려면
// 이름이 자동으로 들어가야 한다. 이름을 매번 고쳐 넣게 하면 결국 손으로 치는 것과 같다.
function renderQuickReply(body, agentName) {
  return String(body || '').replace(/\{상담원\}/g, String(agentName || '').trim());
}

// 채팅 화면(상담원 입력창 옆 목록)이 쓰는 조회 — 활성 문구만, 카테고리 순서대로.
// 여기만 admin 권한이면 되고 별도 화면이 없어 라우터 앞쪽에 둔다.
router.get('/data.json', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const rows = await db.all(
    `SELECT id, category, title, body FROM quick_replies
     WHERE is_active = true ORDER BY sort_order, id`
  ).catch(() => []);
  const agentName = req.session.user ? req.session.user.name : '';
  res.json({
    replies: rows.map((r) => ({
      id: r.id,
      category: r.category,
      title: r.title,
      body: renderQuickReply(r.body, agentName),
    })),
  });
}));

router.use(requireAuth, requireRole('admin'));

const CATEGORIES = ['인사', '대기', '접수', '완료', '안내', '기타'];

router.get('/', asyncHandler(async (req, res) => {
  const replies = await db.all(
    `SELECT q.*, u.name AS created_by_name FROM quick_replies q
     LEFT JOIN users u ON u.id = q.created_by
     ORDER BY q.is_active DESC, q.sort_order, q.id`
  ).catch(() => []);
  res.render('quick_replies/index', {
    title: '빠른 답변 관리',
    replies,
    categories: CATEGORIES,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
}));

function readForm(body) {
  const category = CATEGORIES.includes(String(body.category || '').trim()) ? String(body.category).trim() : '기타';
  return {
    category,
    title: String(body.title || '').trim(),
    text: String(body.body || '').trim(),
    sortOrder: Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0,
    isActive: body.is_active !== '0',
  };
}

router.post('/', asyncHandler(async (req, res) => {
  const base = '/quick-replies';
  const { category, title, text, sortOrder, isActive } = readForm(req.body);
  if (!title) return res.redirect(base + '?error=' + encodeURIComponent('제목을 입력해주세요.'));
  if (!text) return res.redirect(base + '?error=' + encodeURIComponent('문구 내용을 입력해주세요.'));

  try {
    await db.run(
      `INSERT INTO quick_replies (category, title, body, sort_order, is_active, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [category, title, text, sortOrder, isActive, req.session.user.id]
    );
  } catch (e) {
    return res.redirect(base + '?error=' + encodeURIComponent('저장에 실패했습니다: ' + e.message));
  }
  res.redirect(base + '?notice=' + encodeURIComponent('빠른 답변이 등록되었습니다.'));
}));

router.post('/:id', asyncHandler(async (req, res) => {
  const base = '/quick-replies';
  const { category, title, text, sortOrder, isActive } = readForm(req.body);
  if (!title || !text) return res.redirect(base + '?error=' + encodeURIComponent('제목과 문구 내용을 모두 입력해주세요.'));

  await db.run(
    `UPDATE quick_replies SET category = ?, title = ?, body = ?, sort_order = ?, is_active = ?,
     updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [category, title, text, sortOrder, isActive, req.params.id]
  );
  res.redirect(base + '?notice=' + encodeURIComponent('빠른 답변을 수정했습니다.'));
}));

// 사용 여부만 토글 — 문구를 지우지 않고 잠시 내리는 경우가 많다(계절/이벤트 안내 등).
router.post('/:id/toggle', asyncHandler(async (req, res) => {
  await db.run('UPDATE quick_replies SET is_active = NOT is_active WHERE id = ?', [req.params.id]);
  res.redirect('/quick-replies?notice=' + encodeURIComponent('사용 여부를 변경했습니다.'));
}));

router.post('/:id/delete', asyncHandler(async (req, res) => {
  await db.run('DELETE FROM quick_replies WHERE id = ?', [req.params.id]);
  res.redirect('/quick-replies?notice=' + encodeURIComponent('빠른 답변을 삭제했습니다.'));
}));

module.exports = router;
module.exports.renderQuickReply = renderQuickReply;
