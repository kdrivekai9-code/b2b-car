// 상담원 응대 중 답변 초안이 실제로 만들어지는지 확인한다.
//
// 왜 필요한가: 초안이 있어야 "상담원이 30초 무응답이면 자동 발송"(routes/chat.js
// AUTO_SEND_DELAY_SECONDS)이 동작한다. 그런데 초안 생성이 2026-08-08 이후 16일간 0건이었고,
// 아무도 몰랐다 — 실패를 console.error로만 남기는 자리라 화면에는 아무 표시가 없다.
//
// 원인은 한 글자짜리 실수였다. loadPendingIntake는 동기 함수인데(lib/intakeSlotState.js)
// `await loadPendingIntake(session).catch(() => null)`로 불러서, 반환값이 null이든 객체든
// "catch가 없다"로 매번 예외가 났다. 바깥 try가 그걸 삼켰다.
//
// 같은 실수가 카카오(routes/kakaoConsult.js)와 웹(routes/chat.js) 양쪽에 있었다.
require('dotenv').config();
const db = require('../db');
const { loadPendingIntake } = require('../lib/intakeSlotState');
const consult = require('../routes/kakaoConsult');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

(async () => {
  const s = await db.get(
    `INSERT INTO chat_sessions (user_id, status, channel) VALUES (NULL, 'agent_active', 'kakao') RETURNING *`
  );
  const session = s;

  try {
    console.log('[loadPendingIntake는 동기 함수다]');
    // 이걸 Promise로 착각하는 순간 초안 생성 전체가 조용히 죽는다 — 그 전제를 못박는다.
    const returned = loadPendingIntake(session);
    check('Promise가 아니다', returned instanceof Promise, false);
    check('대기 상태가 없으면 null', returned, null);

    console.log('[상담원 응대 중 고객 질문에 초안이 만들어진다]');
    await consult.createAgentSuggestion(session, '방금 탁송예약했는데 접수확인좀');
    const rows = await db.all(
      `SELECT kind, status FROM chat_suggestions WHERE session_id = ? ORDER BY id DESC`,
      [session.id]
    );
    check('초안이 1건 만들어진다', rows.length, 1);
    check('승인 대기 상태다', rows[0] && rows[0].status, 'pending');
    // 자동 발송(autoSendPendingSuggestions)이 pending만 집어간다 — 이 값이 아니면 30초 규칙이 안 돈다.

    console.log('[새 질문이 오면 이전 초안은 닫는다]');
    // 낡은 초안이 pending으로 남으면 고객의 새 질문에 옛 답이 자동 발송된다.
    await consult.createAgentSuggestion(session, '탁송 요금은 어떻게 정해지나요?');
    const after = await db.all(
      `SELECT status FROM chat_suggestions WHERE session_id = ? ORDER BY id`,
      [session.id]
    );
    check('초안이 2건', after.length, 2);
    check('이전 것은 닫힌다', after[0] && after[0].status, 'dismissed');
    check('마지막 것만 대기', after[1] && after[1].status, 'pending');
  } finally {
    await db.run('DELETE FROM chat_suggestions WHERE session_id = ?', [session.id]).catch(() => {});
    await db.run('DELETE FROM chat_messages WHERE session_id = ?', [session.id]).catch(() => {});
    await db.run('DELETE FROM chat_sessions WHERE id = ?', [session.id]).catch(() => {});
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
