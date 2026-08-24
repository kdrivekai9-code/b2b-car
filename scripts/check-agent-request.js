// 고객이 상담원을 찾으면 되묻지 않고 바로 넘기는지 확인한다.
//
// 실사용 사고(2026-08-24):
//   고객: 상담원호출
//   AI  : 요청하신 내용을 확인하고 있습니다. 잠시만 기다려주세요.   ← 배차 도우미(MCP)로 샜다
//   AI  : 상담원에게 연결해드릴까요?                              ← 되물었다
//   고객: 네
//   (아무 일도 일어나지 않음 — 인계도, 상담원 호출 알림도 없음)
//
// 원인 두 가지:
//  1. "상담원호출"을 잡는 키워드가 없어 LLM 분류의 unsupported로 떨어졌고, 그 분기에서 배차
//     도우미가 먼저 가로챘다. 카카오 "상담원 연결" 버튼(/receive/reference)은 동의 절차 없이
//     곧바로 인계하는데, 같은 뜻을 타이핑한 고객만 되묻기에 갇혔다.
//  2. 도우미가 되물은 질문에는 확인 대기 상태가 저장되지 않는다 — 그래서 고객의 "네"를
//     스몰토크 필터가 정보량 0으로 보고 삼켰다.
//
// 오탐이 더 위험한 쪽도 함께 본다. 로그에서 압도적으로 흔한 "기사님 전화번호 부탁드립니다"는
// 봇이 답할 수 있는 조회다 — 이게 상담원 호출로 잡히면 자동화가 통째로 후퇴한다.
//
// 순수 판정이라 네트워크도 DB도 쓰지 않는다.
//
//   node scripts/check-agent-request.js
const { isAgentRequest } = require('../lib/escalationJudge');

let failures = 0;
function check(text, want) {
  const got = isAgentRequest(text);
  const ok = got === want;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${(got ? '상담원 연결' : '봇이 처리').padEnd(10)} ← "${text}"`);
  if (!ok) console.log(`         기대: ${want ? '상담원 연결' : '봇이 처리'}`);
}

console.log('[상담원을 찾는 말 — 되묻지 말고 바로 넘긴다]');
check('상담원호출', true);          // 실사고 문장
check('상담원 호출', true);
check('상담원연결', true);
check('상담원 연결해주세요', true);
check('상담원 바꿔주세요', true);
check('상담사와 통화하고 싶어요', true);
check('상담원이랑 얘기할래요', true);
check('사람이랑 얘기하고 싶어요', true);
check('상담원', true);
check('상담원?', true);
check('상담 직원 연결 부탁드립니다', true);

console.log('\n[봇이 답할 수 있는 것 — 사람을 부르면 안 된다]');
// 아래는 전부 상담 로그에 실제로 나온 문장이다. 기사 연락처는 조회로 답한다(get_my_orders).
check('기사님 전화번호 부탁드립니다', false);
check('배정된 기사님 성함이랑 전화번호좀 부탁드립니다', false);
check('고객님과 통화부탁드리겠습니다', false);
check('기사님과 통화부탁드립니다', false);
check('지금 담당자 통화가 안되는데 입구옆에 주차장에 주차부탁드립니다', false);
check('담당자 확인했습니다', false);
check('오늘 탁송예약건 조회좀', false);
check('사진 부탁드립니다', false);
// 상담원을 언급했지만 요청이 아닌 경우.
check('상담원이 아까 알려주신 대로 했는데 안되네요', false);
check('네', false);
check('감사합니다', false);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
