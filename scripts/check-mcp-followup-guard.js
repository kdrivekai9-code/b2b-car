// 배차 도우미와 대화 중일 때, 이번 발화를 도우미로 돌릴지 새 접수로 볼지.
//
// 두 사고를 동시에 막아야 하는 자리다 — 한쪽으로 기울면 다른 쪽이 터진다.
//
//  · 2026-08-12: MCP 조회("오늘이후 예약건은?") 뒤 "탁송예약해줘"를 보냈는데 도우미로 새서,
//    탁송에 필요한 출발지 연락처를 안 물어보고 계정 소유자 번호로 접수를 시도했다.
//    → 새 접수는 접수 파서로 가야 한다.
//
//  · 2026-08-25: 도우미가 예약 변경 중에 "오전 12시는 자정을 의미합니다. 오늘 자정으로
//    변경하시겠습니까?"라고 되물었는데, 고객이 "정오 12시"라고 답하자 그 한마디가
//    dispatch_order로 분류돼 접수 파서로 갔다. 봇이 출발지·도착지·차량번호를 처음부터 다시
//    물었고 변경하려던 오더는 그대로 남았다.
//    → 도우미가 던진 질문의 답은 도우미로 가야 한다.
//
// 예전 기준은 "의도 라벨이 접수 계열인가"뿐이라 두 번째를 막지 못했다. 지금은 실질을 요구한다:
// 접수를 시키는 말이 있거나, 주소·차량번호처럼 새 오더에만 나오는 값이 잡혔을 때만 새 접수로 본다.
require('dotenv').config();
const { hasIntakeSubstance } = require('../routes/kakaoConsult');

let failures = 0;
function check(text, classified, expected, why) {
  const got = hasIntakeSubstance(classified, text);
  const ok = got === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${String(got).padEnd(5)} "${text}"  — ${why}`);
}

console.log('[도우미 대화의 연장 — 접수로 끌고 가면 안 된다]');
// 도우미가 되물은 질문에 대한 답들. 시각·번호만 달랑 오는 것이 보통이다.
check('정오 12시', {}, false, '되물음에 대한 시각 답변(이번 사고)');
check('오전 12시', {}, false, '같은 종류');
check('오늘 오후 3시로', {}, false, '조사만 붙은 시각 답변');
check('2번', {}, false, '목록에서 고른 번호');
check('네', {}, false, '짧은 확인');
check('2번 오더 예약시간을 오늘로 변경해줘', {}, false, '변경 요청은 도우미 몫이다');
check('그 오더 취소해줘', {}, false, '취소 요청도 도우미 몫이다');

console.log('[새 접수 — 접수 파서로 가야 한다]');
// 도우미(create_order)는 대리운전 전용이라 탁송 필드 개념이 없다. 새 접수가 새면 안 된다.
check('탁송예약해줘', {}, true, '접수를 시키는 말');
check('대리운전 호출해줘', {}, true, '호출도 접수를 시키는 말');
check('내일 탁송 접수 부탁드립니다', {}, true, '접수를 시키는 말');
check('내일 3시에 강남역에서 판교역으로', { originAddress: '강남역', destinationAddress: '판교역' },
  true, '주소가 잡혔다 — 새 오더에만 나온다');
check('12가3456 그랜저', { originVehicleNumber: '12가3456' }, true, '차량번호가 잡혔다');

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
