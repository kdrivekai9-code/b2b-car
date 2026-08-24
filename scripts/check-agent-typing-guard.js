// 상담원이 답을 "쓰고 있는" 동안 AI 초안이 자동 발송되지 않는지 확인한다.
//
// 왜 필요한가: 작성 중에 봇이 먼저 나가면 같은 질문에 답이 두 번 가고, 카카오는 발송 취소가
// 안 된다. 이 안전장치는 마이그레이션 20260808020000에 설계돼 있었지만 여태 한 번도 작동하지
// 않았다 — Next.js 상담 화면은 `/chat/sessions/:id/typing`을 부르고 있었는데 **서버에 그
// 엔드포인트가 없어서** 404를 조용히 삼켰고(클라이언트가 .catch로 무시), agent_typing_at은
// 늘 NULL이었다(실측: 값이 있는 세션 1건, 그마저 종료된 세션). EJS 화면은 아예 부르지 않았다.
//
// 유효기간도 함께 본다. 신호에 만료가 없으면 상담원이 몇 글자 쓰다 그만둔 순간 그 초안이
// 영구히 묶여 고객이 답을 못 받는다.
//
// DB를 쓴다 — 자동 발송 대상 판정이 SQL 조건이라 흉내 내면 확인하는 의미가 없다. 실제 발송은
// 하지 않는다(대상 조회까지만 본다). 만든 행은 지운다.
//
//   node scripts/check-agent-typing-guard.js
require('dotenv').config();
const db = require('../db');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

// routes/chat.js loadAutoSendTargets의 조건을 그대로 옮긴 것 — 이 세션이 자동 발송 대상인지만 본다.
// (라우터를 띄우지 않고 조건만 확인한다. 조건이 바뀌면 이 쿼리도 같이 고쳐야 한다.)
const AUTO_SEND_DELAY_SECONDS = 30;
const AGENT_TYPING_STALE_SECONDS = 60;
const TARGET_SQL = `
  SELECT g.id
    FROM chat_suggestions g
    JOIN chat_sessions s ON s.id = g.session_id
   WHERE g.status = 'pending'
     AND s.status = 'agent_active'
     AND g.session_id = ?
     AND g.created_at <= to_char((now() at time zone 'Asia/Seoul') - interval '${AUTO_SEND_DELAY_SECONDS} seconds', 'YYYY-MM-DD HH24:MI:SS')
     AND (s.agent_typing_at IS NULL
          OR s.agent_typing_at < g.created_at
          OR s.agent_typing_at < to_char(
               (now() at time zone 'Asia/Seoul') - interval '${AGENT_TYPING_STALE_SECONDS} seconds',
               'YYYY-MM-DD HH24:MI:SS'))`;

const MARK = 'e2e-typing-guard-check';

(async () => {
  const created = { sessionId: null };
  try {
    const s = await db.get(
      `INSERT INTO chat_sessions (user_id, status, channel, requested_feature)
       VALUES (NULL, 'agent_active', 'kakao', ?) RETURNING id`,
      [MARK]
    );
    created.sessionId = Number(s.id);

    // 60초 전에 만들어진 초안 — 대기(30초)는 이미 지났다.
    await db.run(
      `INSERT INTO chat_suggestions (session_id, kind, suggested_text, created_at)
       VALUES (?, 'intake', '검사용 초안',
               to_char((now() at time zone 'Asia/Seoul') - interval '60 seconds', 'YYYY-MM-DD HH24:MI:SS'))`,
      [created.sessionId]
    );

    const isTarget = async () => {
      const rows = await db.all(TARGET_SQL, [created.sessionId]);
      return rows.length > 0;
    };

    const setTyping = (expr) => db.run(
      `UPDATE chat_sessions SET agent_typing_at = ${expr} WHERE id = ?`, [created.sessionId]
    );

    console.log('[타이핑 신호가 없을 때]');
    check('자동 발송 대상이다', await isTarget(), true);

    console.log('\n[상담원이 지금 쓰고 있을 때]');
    await setTyping(`to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')`);
    check('자동 발송을 건너뛴다', await isTarget(), false);

    console.log('\n[신호가 초안보다 이전일 때 — 그 뒤로 손을 뗐다]');
    // 초안이 만들어지기 전의 타이핑은 이 초안과 무관하다.
    await setTyping(`to_char((now() at time zone 'Asia/Seoul') - interval '120 seconds', 'YYYY-MM-DD HH24:MI:SS')`);
    check('자동 발송 대상이다', await isTarget(), true);

    console.log('\n[쓰다 말고 오래 방치했을 때]');
    // 신호는 초안보다 뒤지만 유효기간(60초)이 지났다 — 작성을 포기한 것으로 본다.
    // 유효기간이 없으면 이 초안이 영구히 묶여 고객이 답을 못 받는다.
    await setTyping(`to_char((now() at time zone 'Asia/Seoul') - interval '59 seconds', 'YYYY-MM-DD HH24:MI:SS')`);
    check('59초 전이면 아직 건너뛴다', await isTarget(), false);
    await setTyping(`to_char((now() at time zone 'Asia/Seoul') - interval '90 seconds', 'YYYY-MM-DD HH24:MI:SS')`);
    check('90초 전이면 그냥 보낸다', await isTarget(), true);

    console.log('\n[봇 모드 세션]');
    // 봇 모드는 초안을 거치지 않고 직접 답한다 — 자동 발송 대상 자체가 아니다.
    await db.run(`UPDATE chat_sessions SET status = 'bot', agent_typing_at = NULL WHERE id = ?`, [created.sessionId]);
    check('대상이 아니다', await isTarget(), false);
  } catch (e) {
    failures += 1;
    console.error('\n검사 도중 오류:', e && e.stack ? e.stack : e);
  } finally {
    if (created.sessionId) {
      await db.run('DELETE FROM chat_suggestions WHERE session_id = ?', [created.sessionId]).catch(() => {});
      await db.run('DELETE FROM chat_messages WHERE session_id = ?', [created.sessionId]).catch(() => {});
      await db.run('DELETE FROM chat_sessions WHERE id = ? AND requested_feature = ?', [created.sessionId, MARK]).catch(() => {});
      const left = await db.all('SELECT id FROM chat_sessions WHERE requested_feature = ?', [MARK]).catch(() => []);
      if (left.length) {
        failures += 1;
        console.error(`정리 실패 — 세션 ${left.map((r) => r.id).join(',')}가 남았습니다.`);
      }
    }
    console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
    process.exit(failures ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
