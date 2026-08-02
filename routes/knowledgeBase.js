// 지식관리(RAG) 관리자 CRUD — FAQ 항목 등록/수정/삭제, 저장 시 Vertex AI 임베딩을 함께 생성한다.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { embedKnowledgeEntry } = require('../lib/knowledgeSearch');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get('/data.json', asyncHandler(async (req, res) => {
  const [entries, categories] = await Promise.all([
    db.all('SELECT id, category, question, answer, created_at FROM knowledge_base ORDER BY category, id'),
    db.all('SELECT * FROM knowledge_categories ORDER BY name'),
  ]);
  res.json({ currentUser: req.session.user, entries, categories });
}));

router.get('/', asyncHandler(async (req, res) => {
  const entries = await db.all('SELECT * FROM knowledge_base ORDER BY category, id');
  res.render('knowledge_base/list', { title: '지식관리', entries });
}));

// 카테고리 관리 — 아래 '/:id', '/:id/edit' 라우트보다 반드시 먼저 등록해야
// '/categories'가 :id 파라미터로 잘못 매칭되지 않는다.
router.get('/categories', asyncHandler(async (req, res) => {
  const categories = await db.all(`
    SELECT c.*, (SELECT COUNT(*) FROM knowledge_base k WHERE k.category = c.name) AS entry_count
    FROM knowledge_categories c ORDER BY c.name
  `);
  res.render('knowledge_base/categories', { title: '카테고리 관리', categories, error: null });
}));

router.post('/categories', asyncHandler(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) {
    const categories = await db.all(`
      SELECT c.*, (SELECT COUNT(*) FROM knowledge_base k WHERE k.category = c.name) AS entry_count
      FROM knowledge_categories c ORDER BY c.name
    `);
    return res.status(400).render('knowledge_base/categories', {
      title: '카테고리 관리', categories, error: '카테고리명을 입력해주세요.',
    });
  }
  await db.run('INSERT INTO knowledge_categories (name) VALUES (?) ON CONFLICT (name) DO NOTHING', [name]);
  res.redirect('/knowledge-base/categories');
}));

router.post('/categories/:id/delete', asyncHandler(async (req, res) => {
  await db.run('DELETE FROM knowledge_categories WHERE id = ?', [req.params.id]);
  res.redirect('/knowledge-base/categories');
}));

router.get('/new', asyncHandler(async (req, res) => {
  const categories = await db.all('SELECT * FROM knowledge_categories ORDER BY name');
  const entry = req.query.category ? { category: req.query.category } : {};
  res.render('knowledge_base/form', { title: '지식 항목 등록', entry, categories, mode: 'create', error: null });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { category, question, answer } = req.body;
  try {
    const embedding = await embedKnowledgeEntry(question, answer);
    await db.run(
      'INSERT INTO knowledge_base (category, question, answer, embedding, created_by) VALUES (?, ?, ?, ?, ?)',
      [category || '기타', question, answer, embedding, req.session.user.id]
    );
    res.redirect('/knowledge-base');
  } catch (e) {
    const categories = await db.all('SELECT * FROM knowledge_categories ORDER BY name');
    res.status(400).render('knowledge_base/form', {
      title: '지식 항목 등록', entry: req.body, categories, mode: 'create',
      error: '임베딩 생성 중 오류가 발생했습니다: ' + e.message,
    });
  }
}));

router.get('/:id/edit', asyncHandler(async (req, res) => {
  const [entry, categories] = await Promise.all([
    db.get('SELECT * FROM knowledge_base WHERE id = ?', [req.params.id]),
    db.all('SELECT * FROM knowledge_categories ORDER BY name'),
  ]);
  if (!entry) return res.status(404).send('항목을 찾을 수 없습니다.');
  res.render('knowledge_base/form', { title: '지식 항목 수정', entry, categories, mode: 'edit', error: null });
}));

router.post('/:id', asyncHandler(async (req, res) => {
  const { category, question, answer } = req.body;
  try {
    const embedding = await embedKnowledgeEntry(question, answer);
    await db.run(
      `UPDATE knowledge_base SET category=?, question=?, answer=?, embedding=?,
       updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?`,
      [category || '기타', question, answer, embedding, req.params.id]
    );
    res.redirect('/knowledge-base');
  } catch (e) {
    const categories = await db.all('SELECT * FROM knowledge_categories ORDER BY name');
    res.status(400).render('knowledge_base/form', {
      title: '지식 항목 수정', entry: { ...req.body, id: req.params.id }, categories, mode: 'edit',
      error: '임베딩 생성 중 오류가 발생했습니다: ' + e.message,
    });
  }
}));

router.post('/:id/delete', asyncHandler(async (req, res) => {
  await db.run('DELETE FROM knowledge_base WHERE id = ?', [req.params.id]);
  res.redirect('/knowledge-base');
}));

module.exports = router;
