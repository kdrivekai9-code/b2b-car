// FAQ 챗봇 — RAG 지식베이스에서 질문과 가장 유사한 항목을 찾아 답변한다. (모든 로그인 사용자 이용 가능)
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { searchKnowledgeBase } = require('../lib/knowledgeSearch');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  res.render('knowledge_base/faq_chat', { title: 'FAQ 문의' });
});

router.post('/ask', asyncHandler(async (req, res) => {
  const question = (req.body.question || '').trim();
  if (!question) return res.status(400).json({ error: '질문을 입력해주세요.' });
  try {
    const matches = await searchKnowledgeBase(question, { limit: 3, threshold: 0.6 });
    res.json({ matches });
  } catch (e) {
    res.status(500).json({ error: '검색 중 오류가 발생했습니다: ' + e.message });
  }
}));

module.exports = router;
