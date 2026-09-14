// FAQ 챗봇 — RAG 지식베이스에서 질문과 가장 유사한 항목을 찾아 답변한다. (모든 로그인 사용자 이용 가능)
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { searchKnowledgeBase } = require('../lib/knowledgeSearch');
const { composeKnowledgeAnswer } = require('../lib/knowledgeAnswer');

const router = express.Router();
router.use(requireAuth);

router.get('/data.json', (req, res) => {
  res.json({ currentUser: req.session.user });
});

router.get('/', (req, res) => {
  res.render('knowledge_base/faq_chat', { title: 'FAQ 문의' });
});

router.post('/ask', asyncHandler(async (req, res) => {
  const question = (req.body.question || '').trim();
  if (!question) return res.status(400).json({ error: '질문을 입력해주세요.' });
  try {
    const matches = await searchKnowledgeBase(question, { limit: 3, threshold: 0.6 });
    // 찾은 항목을 질문에 맞춰 한 덩어리로 정리해서 함께 내려준다(lib/knowledgeAnswer.js).
    //
    // matches도 **그대로 함께** 보낸다. 정리에 실패하거나(모델 장애·지연) 준 항목만으로는
    // 답이 안 될 때 answer가 null로 오는데, 그때 화면은 예전처럼 원문을 보여줘야 한다.
    // 정리본만 보내면 모델이 죽는 순간 FAQ가 통째로 먹통이 된다.
    const composed = await composeKnowledgeAnswer(question, matches);
    res.json({ matches, answer: composed ? composed.answer : null, sources: composed ? composed.sources : [] });
  } catch (e) {
    res.status(500).json({ error: '검색 중 오류가 발생했습니다: ' + e.message });
  }
}));

module.exports = router;
