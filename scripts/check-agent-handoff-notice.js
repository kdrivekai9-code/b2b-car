// 상담원 인계 안내가 반복되지 않는지, 그리고 처음 인계 사유가 지켜지는지 확인한다.
//
// 배경(사용자 확정 규칙): 고객이 상담원 연결을 요청해도 상담원이 실제로 대화에 들어오기
// 전까지는 봇이 계속 응대한다(needs_agent 동안 봇 유지 — 사람이 오기 전 공백을 봇이 메운다).
// 그 사이 봇이 다시 인계 판단을 하면 같은 안내가 반복된다. 특히 사고·클레임은 봇이 답하지
// 않는 유형이라, 고객이 기다리며 이어서 말할 때마다 "상담원을 연결해드릴게요"만 두세 번 나갔다.
//
// 그래서 두 가지를 지켜야 한다:
//  1. 이미 needs_agent면 안내를 내지 않고 푸시도 다시 보내지 않는다.
//  2. 그때 처음 인계 사유("사고·클레임 문의")를 뒤이은 평범한 질문의 사유로 덮어쓰지 않는다 —
//     덮어쓰면 상담원이 목록에서 왜 불려온 건지 알 수 없게 된다.
//
// DB를 쓴다(상태·사유가 이 기능의 전부다). 안내 발송(botSay)은 실제 카카오 발신을 타므로
// 부르지 않고, 판정과 DB 갱신만 본다. 만든 세션은 지운다.
//
//   node scripts/check-agent-handoff-notice.js
require('dotenv').config();
const db = require('../db');
const kakao = require('../routes/kakaoConsult');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

const MARK = 'e2e-handoff-notice-check';

(async () => {
  const created = { sessionId: null };
  try {
    console.log('[안내를 낼지 판정]');
    check('봇 응대 중이면 안내한다', kakao.isAlreadyWaitingForAgent({ status: 'bot' }), false);
    // 상담원이 실제로 들어온 세션은 애초에 봇 경로를 타지 않는다(호출부에서 걸러진다).
    check('상담원 응대 중이면 판정 대상 아님', kakao.isAlreadyWaitingForAgent({ status: 'agent_active' }), false);
    check('이미 대기 중이면 안내하지 않는다', kakao.isAlreadyWaitingForAgent({ status: 'needs_agent' }), true);
    check('세션이 없으면 안내한다', kakao.isAlreadyWaitingForAgent(null), false);

    const s = await db.get(
      `INSERT INTO chat_sessions (user_id, status, channel, requested_feature)
       VALUES (NULL, 'bot', 'kakao', ?) RETURNING id`,
      [MARK]
    );
    created.sessionId = Number(s.id);
    const load = () => db.get('SELECT status, requested_feature FROM chat_sessions WHERE id = ?', [created.sessionId]);

    console.log('\n[첫 인계 — 사고·클레임]');
    await kakao.markNeedsAgent({ id: created.sessionId, status: 'bot' }, '차에 기스가 났어요', '사고·클레임 문의');
    let row = await load();
    check('상담 대기로 바뀐다', row.status, 'needs_agent');
    check('사유가 기록된다', row.requested_feature, '사고·클레임 문의');

    console.log('\n[기다리는 동안 고객이 또 말했을 때]');
    // 봇이 다시 인계 판단을 해도 상태와 사유를 건드리지 않아야 한다.
    await kakao.markNeedsAgent(
      { id: created.sessionId, status: 'needs_agent' }, '언제쯤 연락 주시나요?', '문의', { silent: true }
    );
    row = await load();
    check('상태는 그대로', row.status, 'needs_agent');
    // 이 줄이 깨지면 상담원 목록에 "문의"만 남아 왜 불려왔는지 알 수 없게 된다.
    check('처음 인계 사유가 유지된다', row.requested_feature, '사고·클레임 문의');

    console.log('\n[상담원이 들어온 뒤 다시 인계될 때]');
    // silent가 아니면 사유를 갱신한다 — 새로 인계된 것이므로 최신 사유가 맞다.
    await db.run(`UPDATE chat_sessions SET status = 'bot' WHERE id = ?`, [created.sessionId]);
    await kakao.markNeedsAgent({ id: created.sessionId, status: 'bot' }, '정산 문의드립니다', '정산·비용');
    row = await load();
    check('사유가 갱신된다', row.requested_feature, '정산·비용');
    check('다시 상담 대기', row.status, 'needs_agent');
  } catch (e) {
    failures += 1;
    console.error('\n검사 도중 오류:', e && e.stack ? e.stack : e);
  } finally {
    if (created.sessionId) {
      await db.run('DELETE FROM chat_messages WHERE session_id = ?', [created.sessionId]).catch(() => {});
      await db.run('DELETE FROM chat_sessions WHERE id = ? AND requested_feature IS NOT NULL AND id = ?',
        [created.sessionId, created.sessionId]).catch(() => {});
      const left = await db.all('SELECT id FROM chat_sessions WHERE id = ?', [created.sessionId]).catch(() => []);
      if (left.length) {
        failures += 1;
        console.error(`정리 실패 — 세션 ${created.sessionId}가 남았습니다.`);
      }
    }
    console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
    process.exit(failures ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
