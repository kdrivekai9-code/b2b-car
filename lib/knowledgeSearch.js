// 지식관리(RAG) 검색 — Vertex AI(Gemini) 임베딩 + pgvector 코사인 유사도.
const db = require('../db');
const { embedText } = require('./vertexAi');

function toVectorLiteral(values) {
  return '[' + values.join(',') + ']';
}

// 지식 항목 저장/수정 시 호출 — question+answer를 합쳐 하나의 벡터로 임베딩한다.
async function embedKnowledgeEntry(question, answer) {
  const values = await embedText(`${question}\n${answer}`, 'RETRIEVAL_DOCUMENT');
  return toVectorLiteral(values);
}

// FAQ 챗봇에서 사용자의 질문을 받아 가장 유사한 지식 항목 상위 N개를 반환한다.
// similarity(1 - 코사인거리)가 threshold 미만이면 "관련 항목 없음"으로 간주해 걸러낸다.
async function searchKnowledgeBase(queryText, { limit = 3, threshold = 0.6 } = {}) {
  const values = await embedText(queryText, 'RETRIEVAL_QUERY');
  const vectorLiteral = toVectorLiteral(values);
  const rows = await db.all(
    `SELECT id, category, question, answer, 1 - (embedding <=> ?) AS similarity
     FROM knowledge_base
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> ?
     LIMIT ?`,
    [vectorLiteral, vectorLiteral, limit]
  );
  return rows.filter((r) => Number(r.similarity) >= threshold);
}

module.exports = { embedKnowledgeEntry, searchKnowledgeBase };
