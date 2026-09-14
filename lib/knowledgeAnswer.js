// 지식베이스에서 찾은 항목들을 **질문에 맞춰 한 덩어리로 정리한다.**
//
// 왜 필요한가(사용자 지적 2026-09-14): FAQ 문의 화면은 검색 결과를 그대로 뿌렸다 —
// `[카테고리] 원문`이 최대 3개, 각각 따로. 질문이 "후불 되나요?"인데 결제 관련 항목 셋이
// 통째로 나오니, 고객이 그 중 어느 줄이 자기 질문의 답인지 직접 골라 읽어야 했다.
//
// **모델은 문장을 다듬을 뿐, 사실을 만들지 않는다.** 이 구분이 이 모듈의 전부다:
//
//   · 검색 결과가 없으면 모델을 **아예 부르지 않는다**. 빈손으로 물으면 그럴듯한 거짓말이
//     나온다 — 고객에게 나가는 안내라 지어낸 문장은 원문을 그대로 보여주는 것보다 나쁘다.
//   · 준 항목만으로 답이 안 되면 모델이 grounded:false로 말하게 하고, 그때는 정리본을
//     버린다. "모르겠으면 지어내지 말라"는 지시만으로는 부족해서 신호를 따로 받는다.
//   · 실패·지연·형식 이상은 전부 null이다. 호출부는 null이면 예전처럼 원문을 보여준다 —
//     모델이 죽어도 FAQ는 계속 동작해야 한다.
//
// 정리본과 함께 어느 항목을 썼는지도 돌려준다. 고객이 근거를 볼 수 있어야 하고, 잘못된
// 안내가 나갔을 때 어느 지식 항목을 고쳐야 하는지 우리가 찾을 수 있어야 한다.
//
// DB에 닿지 않는다. 모델 호출은 generate로 주입받으므로 검사에서 네트워크 없이 돌릴 수 있다.
const { generateJson } = require('./vertexAi');

// 모델을 기다리는 한도. FAQ는 사람이 화면 앞에서 기다리는 자리라, 늦어지면 정리를 포기하고
// 원문을 보여주는 편이 낫다(vertexAi의 자체 한도 25초는 이 화면엔 너무 길다).
const COMPOSE_TIMEOUT_MS = 7000;
// 정리본이 이보다 길면 원문을 그대로 보여준다 — 요약해달라고 했는데 더 길어졌다는 뜻이다.
const MAX_ANSWER_LENGTH = 1200;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    grounded: { type: 'boolean' },
  },
  required: ['answer', 'grounded'],
};

const SYSTEM_INSTRUCTION = [
  '너는 탁송 B2B 플랫폼의 고객 안내 담당이다.',
  '아래에 주어진 "지식 항목"만을 근거로 고객의 질문에 답한다.',
  '',
  '규칙:',
  '- 지식 항목에 없는 내용은 절대 만들어 쓰지 않는다. 추측·일반 상식·경험칙 모두 금지다.',
  '- 질문과 관련 없는 항목은 무시한다. 준 항목을 전부 쓸 필요는 없다.',
  '- 주어진 항목만으로 질문에 답할 수 없으면 grounded를 false로 두고, answer는 빈 문자열로 둔다.',
  '- 답할 수 있으면 grounded를 true로 두고, answer에 정중한 한국어 존댓말로 쓴다.',
  '- 항목 여러 개에 걸친 답이면 한 덩어리로 합쳐 쓴다. 항목 번호나 카테고리 이름은 쓰지 않는다.',
  '- 금액·시간·기간·조건 같은 숫자는 지식 항목에 적힌 그대로 옮긴다. 반올림하거나 바꾸지 않는다.',
  '- 3~5문장 안으로 짧게 쓴다. 인사말과 "문의 주셔서 감사합니다" 같은 상투구는 넣지 않는다.',
].join('\n');

function buildUserText(question, matches) {
  const entries = matches.map((m, i) => [
    `[지식 항목 ${i + 1}] 카테고리: ${String(m.category || '미분류')}`,
    `질문: ${String(m.question || '').trim()}`,
    `답변: ${String(m.answer || '').trim()}`,
  ].join('\n')).join('\n\n');
  return `고객 질문: ${question}\n\n${entries}`;
}

async function composeKnowledgeAnswer(question, matches, options = {}) {
  const q = String(question || '').trim();
  const list = Array.isArray(matches) ? matches.filter((m) => m && String(m.answer || '').trim()) : [];
  // 근거가 없으면 모델을 부르지 않는다 — 이 모듈에서 가장 중요한 한 줄이다.
  if (!q || !list.length) return null;

  const generate = options.generate || generateJson;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : COMPOSE_TIMEOUT_MS;

  let result;
  try {
    result = await Promise.race([
      generate(SYSTEM_INSTRUCTION, buildUserText(q, list), RESPONSE_SCHEMA, { op: 'faq_answer' }),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch (e) {
    console.error('FAQ 답변 정리 실패(원문으로 보여준다):', e.message);
    return null;
  }

  if (!result || typeof result !== 'object') return null;
  if (result.grounded !== true) return null;

  const answer = String(result.answer || '').trim();
  if (!answer || answer.length > MAX_ANSWER_LENGTH) return null;

  // 근거를 함께 돌려준다 — 중복 카테고리는 한 번만.
  const sources = [];
  for (const m of list) {
    const c = String(m.category || '').trim();
    if (c && !sources.includes(c)) sources.push(c);
  }
  return { answer, sources };
}

module.exports = { composeKnowledgeAnswer, SYSTEM_INSTRUCTION, COMPOSE_TIMEOUT_MS };
