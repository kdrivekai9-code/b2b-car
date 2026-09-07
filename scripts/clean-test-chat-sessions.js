// 자동화가 만든 상담 세션만 지운다.
//
// 왜 이 스크립트가 생겼나: 워크플로에 `DELETE FROM chat_sessions`가 있었다. 조건이 없다.
// 운영 DB에 붙어 있으므로 그 한 줄이 **모든 대화를 지운다** — 실고객 카카오 상담톡과
// 사람이 손으로 해본 테스트까지 전부. 실행 시점에 세션 338건, 메시지 3,950건이 있었다.
//
// 이미 한 번 일어난 것으로 보인다. 남아 있는 가장 오래된 세션 날짜가 이 워크플로의 마지막
// 실행일(2026-08-03)과 같다.
//
// 단계 이름은 'Clear test chat sessions'였다 — 의도는 **시험** 세션이었다. 조건이 그 의도를
// 담지 못한 것뿐이다. 그래서 의도대로 좁힌다: QA 전용 계정이 만든 세션만.
//
// 이게 지금 맞는 조건인 이유: 자동화는 QA 계정만 쓴다(scripts/check-login-all.js의
// assertSafeAccounts가 그걸 강제한다). 그러니 테스트가 만드는 세션은 전부 QA 계정 소유다.
// 소유자가 없는 세션(카카오 상담톡)은 실고객이므로 절대 건드리지 않는다.
require('dotenv').config();
const db = require('../db');

const QA_PREFIX = 'qa\\_%'; // LIKE에서 _는 한 글자 와일드카드라 이스케이프한다
// 기본은 미리보기다. 운영 DB에서 지우는 스크립트가 인자 없이 지우면, 무엇을 지우는지 보려고
// 한 번 돌린 사람이 이미 지운 상태가 된다.
const APPLY = process.argv.includes('--apply');

(async () => {
  const owners = await db.all(
    "SELECT id, login_id FROM users WHERE login_id LIKE ? ESCAPE '\\'", [QA_PREFIX]
  );
  if (!owners.length) {
    console.log('QA 계정이 없습니다 — 지울 것이 없습니다.');
    process.exit(0);
  }

  const ids = owners.map((o) => o.id);
  const placeholders = ids.map(() => '?').join(', ');

  const before = await db.get(
    `SELECT COUNT(*)::int AS n FROM chat_sessions WHERE user_id IN (${placeholders})`, ids
  );
  const others = await db.get(
    `SELECT COUNT(*)::int AS n FROM chat_sessions
      WHERE user_id IS NULL OR user_id NOT IN (${placeholders})`, ids
  );

  console.log(`QA 계정(${owners.map((o) => o.login_id).join(', ')}) 세션 ${before.n}건`);
  console.log(`남길 세션 ${others.n}건 — 실고객 상담톡과 사람이 만든 테스트는 건드리지 않습니다.`);

  if (!APPLY) {
    console.log('\n미리보기입니다. 지우려면: node scripts/clean-test-chat-sessions.js --apply');
    process.exit(0);
  }

  await db.run(
    `DELETE FROM chat_messages WHERE session_id IN
       (SELECT id FROM chat_sessions WHERE user_id IN (${placeholders}))`, ids
  ).catch((e) => { console.log(`  메시지 삭제 건너뜀: ${e.code || e.message}`); });
  await db.run(`DELETE FROM chat_sessions WHERE user_id IN (${placeholders})`, ids);

  console.log(`\n${before.n}건 삭제`);
  process.exit(0);
})().catch((e) => {
  console.error('시험 세션 정리 실패:', e.message);
  // 테스트의 전제조건이지 검사가 아니다. 여기서 워크플로를 세우면 정작 봐야 할 테스트가 안 돈다.
  process.exit(0);
});
