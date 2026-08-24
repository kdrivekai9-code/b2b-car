// 되묻기 만료 안내가 "조각 답변"에만 나가고, 완결된 새 요청은 삼키지 않는지 확인한다.
//
// 만료 안내는 원래 이런 사고를 막으려고 넣었다: 도착지를 물어본 지 78분 뒤 고객이 "판교역"만
// 보냈는데, 맥락이 사라진 상태라 대리운전 요청으로 오분류돼 "신규 접수는 상담원 연결을…"이
// 나갔다. 조각은 끊겼다고 알려 처음부터 받는 편이 낫다.
//
// 그런데 그 판단이 메시지 내용을 보지 않고 있었다. 실사용 사고:
//
//   고객: 내일오후3시에 사당역탐앤탐스에서 강남역5번출구로 탁송예약
//   AI  : 이전에 진행하시던 접수 내용이 시간이 많이 지나 초기화되었습니다. …
//
// 출발·도착·일시가 다 들어 있는 새 접수인데 만료 안내가 나가면서 그 턴이 통째로 삼켜졌다
// (요청은 아무 처리도 되지 않았다). 완결된 요청과 조각을 갈라야 한다.
//
// 판정은 한쪽으로 기울여 뒀다 — 완결을 조각으로 잘못 보면 요청이 삼켜지지만, 조각을 완결로
// 잘못 보면 만료 안내 없이 예전 동작(재분류)으로 돌아가는 것뿐이다.
//
// 순수 판정 함수라 네트워크도 DB도 쓰지 않는다.
//
//   node scripts/check-intake-expiry-notice.js
const { looksSelfContained } = require('../lib/intakeSlotState');

let failures = 0;
function check(text, want) {
  const got = looksSelfContained(text);
  const ok = got === want;
  if (!ok) failures += 1;
  const label = got ? '새 요청으로 처리' : '만료 안내';
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label.padEnd(12)} ← "${text}"`);
  if (!ok) console.log(`         기대: ${want ? '새 요청으로 처리' : '만료 안내'}`);
}

console.log('[완결된 새 요청 — 삼키면 안 된다]');
// 실사용에서 삼켜진 그 문장.
check('내일오후3시에 사당역탐앤탐스에서 강남역5번출구로 탁송예약', true);
check('사당역에서 강남역까지 탁송 부탁드립니다', true);
check('강남 → 판교 그랜저 12가3456 내일 2시', true);
check('내일 오전 9시 창업로17 포레나오피스텔 출발 일일기사예약', true);
check('오늘 즉시 대리운전 접수해주세요', true);
check('군포에서 서서울로 보내주세요', true);

console.log('\n[조각 답변 — 만료 안내가 맞다]');
// 앞 질문에 대한 답으로만 뜻이 통하는 것들. 맥락 없이 재분류되면 엉뚱한 안내가 나간다.
check('판교역', false);
check('그랜저 12가3456', false);
check('010-1234-5678', false);
check('없어', false);
check('네', false);
check('1', false);
check('지금요', false);
check('강남역 5번출구', false);

console.log('\n[빈 값]');
check('', false);
check('   ', false);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
