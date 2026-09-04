// 상담원 도우미가 채널마다 다르게 동작하지 않는지 검사한다.
//
// 왜 필요한가(2026-09-02 실측): 웹 위젯 세션 1210에서 "오늘 접수한 오더 수정해줘",
// "오늘 예약건은 총몇개야?" 세 발화에 초안이 한 건도 안 만들어졌다. 원인은 배차 도우미 분기가
// 카카오 경로(routes/kakaoConsult.js)에만 있고 웹 경로(routes/chat.js)에는 없던 것 —
// 카카오는 2026-08-24에 그 분기를 받았는데 웹은 못 받았다.
//
// 이 종류의 어긋남은 조용하다. 초안이 없으면 30초 자동 발송도 안 돌아 봇이 통째로 침묵하는데,
// 화면에는 아무 오류도 안 뜬다. 그래서 "두 경로가 같은 규칙을 쓰는가"를 검사로 고정한다.
require('dotenv').config();

const fs = require('fs');
const path = require('path');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const web = read('routes/chat.js');
const kakao = read('routes/kakaoConsult.js');

console.log('[두 경로가 다 있는가]');
check('웹 초안 생성기', web.includes('function createSuggestionAsync'));
check('카카오 초안 생성기', kakao.includes('async function createAgentSuggestion'));

console.log('\n[배차 도우미 분기]');
// 이번 사고의 본체. 없으면 주문 조회·수정·취소 질문에 초안이 아예 안 만들어진다.
[['웹', web], ['카카오', kakao]].forEach(([name, src]) => {
  check(`${name} — buildDispatchSuggestion을 정의한다`, /async function buildDispatchSuggestion/.test(src));
  check(`${name} — 초안 경로에서 부른다`, /if \(!suggestion \|\| suggestion\.kind === 'faq'\)/.test(src),
    'FAQ보다 먼저 봐야 한다 — FAQ는 실제 주문 상태를 모른다');
  // draftMode를 빼면 채택되지도 않은 초안이 확인 대기 상태를 저장해, 고객의 다음 "네"를 삼킨다.
  check(`${name} — draftMode로 돈다`, /draftMode: true/.test(src));
  // 변경 계열은 문구만 보내면 약속만 나가고 아무것도 실행되지 않는다.
  check(`${name} — 변경 계열을 dispatch_action으로 가른다`,
    /result\.mutating \? 'dispatch_action' : 'dispatch'/.test(src));
});

console.log('\n[되묻기 이어붙이기]');
// 봇이 차량번호만 물어본 상태에서 상담원이 끼어들면, 그 뒤 고객의 "48조9416"은 그것만으로는
// 접수로 안 읽힌다. 앞 원문에 이어붙여야 초안이 만들어진다.
[['웹', web], ['카카오', kakao]].forEach(([name, src]) => {
  check(`${name} — loadPendingIntake로 앞 원문을 잇는다`, /loadPendingIntake\(session\)/.test(src));
  // loadPendingIntake는 동기 함수다. .catch를 붙이면 매번 예외가 나고 바깥 try가 삼켜서
  // 초안이 0건이 된다 — 실제로 16일간 아무도 몰랐다.
  check(`${name} — loadPendingIntake에 .catch를 붙이지 않았다`,
    !/loadPendingIntake\(session\)\s*\.catch/.test(src), '동기 함수다 — .catch를 붙이면 매번 예외');
});

console.log('\n[자동 발송 인계]');
// 접수·변경 초안은 문구를 대신 보내면 약속만 나간다. 봇에게 넘겨 정식 경로가 실행해야 한다.
check('접수와 배차변경은 봇에게 넘긴다',
  /row\.kind === 'intake' \|\| row\.kind === 'dispatch_action'/.test(web));

console.log('\n[초안 종류]');
const agentAssist = require('../lib/agentAssist');
check('buildSuggestion이 있다', typeof agentAssist.buildSuggestion === 'function');
// 이 목록이 곧 "도우미가 답할 수 있는 용건"이다. 줄어들면 조용히 침묵 구간이 생긴다.
['buildFareSuggestion', 'buildHoursSuggestion', 'buildFreeTextIntakeSuggestion'].forEach((fn) => {
  check(`${fn}`, typeof agentAssist[fn] === 'function');
});
// 봇 직접 응대보다 높게 잡는다 — 상담원이 이미 보고 있는 화면이라 애매한 제안은 소음이다.
check('FAQ 임계가 0.7 이상', agentAssist.FAQ_THRESHOLD >= 0.7, String(agentAssist.FAQ_THRESHOLD));

console.log('\n[되는 기능을 "준비 중"이라고 하지 않는다]');
// 이 문구는 MCP 배차 도우미가 생기기 전 것이다. 지금은 주문 조회·변경·취소가 실제로 동작하고,
// 상담원으로 넘어가는 이유는 대개 기능이 없어서가 아니다 — 실측 2026-09-04: 고객 전화번호가
// 콜마너에 없어 주문을 특정 못 한 것(customer_not_registered)이 그대로 이 문구를 탔다.
// 되는 기능을 "준비 중"이라고 하면 거짓이고, 고객은 아예 안 되는 줄 알고 다시 묻지 않는다.
const chatSrc = read('routes/chat.js');
check('"기능은 아직 준비 중입니다"를 쓰지 않는다', !/기능은 아직 준비 중입니다\. `/.test(chatSrc));
check('상담원이 이어받는다고 말한다', /상담원이 확인해드릴게요/.test(chatSrc));
// 어느 기능이었는지는 DB에 남아 우리가 본다 — 고객에게 설명할 일이 아니다.
check('요청한 기능은 세션에 기록한다', /requested_feature = \?/.test(chatSrc));

const mcpSrc = read('lib/mcpDispatchAgent.js');
// 고칠 수 있는 문제인데 아무 데도 안 남으면 관리자는 왜 그런지 알 방법이 없다.
// 계정 전화번호를 콜마너에 등록하거나 고치면 그날부터 조회가 된다.
// 로그 호출이 reason 문자열보다 앞에 있으므로 순서를 뒤집어 본다.
check('등록 안 된 연락처를 기록한다',
  /logIntegrationErrorAsync\([\s\S]{0,200}operation: 'customer_not_registered'/.test(mcpSrc));
check('번호는 가려서 남긴다', /phone: access\.maskPhone/.test(mcpSrc));

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
