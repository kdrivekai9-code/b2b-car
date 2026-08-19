// FAQ 문맥 보강 재검색이 "직전 질문의 답"을 반복하지 않는지 확인한다.
//
// 실사용 사고(2026-08-19):
//   고객: "지금탁송접수 하면 가장빠른시간은?"  → 봇: "24시간 운영합니다..."(#39 주말·연휴 접수)
//   고객: "결재는 후불되 되나?"                → 봇: "24시간 운영합니다..."  ← 같은 답이 또 나갔다
//
// 왜 그랬나(실측):
//   "결재는 후불되 되나?" 단독 검색 → 최고 0.664로 임계값(0.7) 미달 = 정상적으로 "못 찾음"
//   직전 질문을 이어붙인 재검색      → #39가 0.767로 통과 = 오답 반환
// 두 문장을 붙이면 의미가 직전 질문 쪽으로 기운다. 새 질문에 맞는 지식이 아예 없을 때 특히 그렇다.
// 재검색 임계값을 +0.05 올려둔 상태였는데도 뚫렸다 — 숫자만으로는 못 막는다.
//
// 이 검사는 실제 임베딩을 부른다(질문 몇 개라 비용이 작다). 지식베이스 내용이 바뀌면 점수도
// 바뀌므로, 특정 점수가 아니라 "답이 나가는가/안 나가는가"만 본다.
require('dotenv').config();
const db = require('../db');
const { searchKnowledgeBase } = require('../lib/knowledgeSearch');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

// 직전 질문이 있는 세션을 만들어 실제 경로 그대로 태운다.
async function ask(previousQuestion, currentQuestion) {
  const s = await db.get(
    `INSERT INTO chat_sessions (user_id, status, channel) VALUES (NULL, 'bot', 'web') RETURNING id`
  );
  const sessionId = Number(s.id);
  try {
    await db.run(`INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'user', ?)`, [sessionId, previousQuestion]);
    await db.run(`INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'user', ?)`, [sessionId, currentQuestion]);
    const rows = await searchKnowledgeBase(currentQuestion, { limit: 1, threshold: 0.7, sessionId });
    return rows.length ? Number(rows[0].id) : null;
  } finally {
    await db.run('DELETE FROM chat_messages WHERE session_id = ?', [sessionId]).catch(() => {});
    await db.run('DELETE FROM chat_sessions WHERE id = ?', [sessionId]).catch(() => {});
  }
}

(async () => {
  try {
    console.log('[직전 질문의 답을 반복하지 않는다]');
    // 이번 사고 그대로. 결제 관련 지식이 없으므로 "못 찾음"이 정답이다 — 상담원으로 넘어간다.
    const incident = await ask('지금탁송접수 하면 가장빠른시간은?', '결재는 후불되 되나?');
    check('결제 질문에 접수시간 답이 나가지 않는다', incident, null);

    // 같은 성격: 직전 질문이 이미 답을 받은 항목을 새 질문에 또 내놓지 않는다.
    // (예전에는 "가입방법은?"에 직전 답(#29)을 그대로 반복했다. 반복은 답이 아니다 —
    //  고객 입장에서 같은 말을 두 번 듣는 것이라, 상담원으로 넘기는 편이 낫다.)
    const repeat = await ask('책임보험 가입도 되나요?', '가입방법은?');
    check('가입방법 질문에 직전 답을 반복하지 않는다', repeat, null);

    console.log('[문맥이 실제로 도움이 되는 경우는 그대로 답한다]');
    // 새 질문이 직전과 다른 항목을 가리키면 재검색이 제 일을 한다 — 이 경로를 막으면 안 된다.
    const helped = await ask('탁송 요금은 어떻게 정해지나요?', '추가 비용도 있나요?');
    check('추가비용 질문에 추가비용 항목이 나온다', helped, 32);

    console.log('[직전 질문이 없으면 평소대로 동작한다]');
    const alone = await searchKnowledgeBase('탁송 요금은 어떻게 정해지나요?', { limit: 1, threshold: 0.7, sessionId: null });
    check('단독 질문은 그대로 답한다', alone.length > 0, true);
  } finally {
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('검사 실패:', e);
  process.exit(1);
});
