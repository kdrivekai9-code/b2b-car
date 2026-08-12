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

async function searchOnce(queryText, limit, threshold) {
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

// 문맥 보강 재검색에 쓸 직전 사용자 발화. 이번 발화(currentText)는 호출 시점에 이미
// chat_messages에 저장돼 있는 경우가 많아 최신 행으로 잡히므로 제외하고, 그 앞의 사용자
// 발화를 찾는다("가입방법은?" 앞에 "책임보험 가입도 되나요?"가 있었다는 걸 알아내는 지점).
async function loadPreviousUserQuestion(sessionId, currentText) {
  if (!sessionId) return null;
  try {
    const rows = await db.all(
      `SELECT message FROM chat_messages WHERE session_id = ? AND sender = 'user' ORDER BY id DESC LIMIT 2`,
      [sessionId]
    );
    const prev = rows.find((r) => r.message !== currentText);
    return prev ? prev.message : null;
  } catch (e) {
    return null;
  }
}

// FAQ 챗봇에서 사용자의 질문을 받아 가장 유사한 지식 항목 상위 N개를 반환한다.
// similarity(1 - 코사인거리)가 threshold 미만이면 "관련 항목 없음"으로 간주해 걸러낸다.
//
// sessionId를 넘기면 문맥 보강 재검색이 켜진다(사용자 확정 방식) — 실사용 사고: "책임보험
// 가입도 되나요?" 다음에 "가입방법은?"이라고 물으면, 그 자체만으로는 무슨 가입인지 알 수
// 없어 어떤 지식 항목과도 유사도가 안 맞고 "찾지 못했습니다"로 끝났다. 매 요청마다 문맥을
// 붙이면 비용도 늘고, 완전히 새로운 독립 질문에 옛 맥락이 섞여 엉뚱한 항목이 매칭될 위험도
// 있어서, 1차 검색이 정말 실패했을 때만(threshold 미달) 직전 사용자 질문을 이어붙여 재검색한다.
// 1차 검색과 직전 질문 조회는 병렬로 시작해 지연을 최소화한다.
//
// 재검색은 원 임계값보다 엄격하게(+0.05) 본다 — 실사용 사고: "책임보험 가입 보험료" 다음에
// "보험료는 얼마에요?"를 물으면 두 문장을 합쳤을 때 키워드만 겹치는 엉뚱한 항목(가격이 아니라
// 취소 시 환불 여부를 다루는 항목)이 원 임계값을 살짝 넘겨버려, "모른다"고 정직하게 답해야 할
// 상황에서 오답을 자신있게 내놓는 문제가 있었다.
const CONTEXT_RETRY_THRESHOLD_BUMP = 0.05;

async function searchKnowledgeBase(queryText, { limit = 3, threshold = 0.6, sessionId = null } = {}) {
  const [primary, previousQuestion] = await Promise.all([
    searchOnce(queryText, limit, threshold),
    loadPreviousUserQuestion(sessionId, queryText),
  ]);
  if (primary.length || !previousQuestion) return primary;
  return searchOnce(`${previousQuestion}\n${queryText}`, limit, threshold + CONTEXT_RETRY_THRESHOLD_BUMP);
}

module.exports = { embedKnowledgeEntry, searchKnowledgeBase };
