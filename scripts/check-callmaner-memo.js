// 콜마너 적요1(memo)에 차량번호가 맨 앞으로 실리는지 확인한다.
//
// 왜 필요한가: 콜마너 오더접수/오더수정 요청에는 차량번호 칸이 아예 없다(정의서 v1.7 전수
// 확인 — 차량 관련은 driver_option의 `탁송(yn)` 플래그뿐). 그래서 번호를 기사에게 전달할
// 길은 적요밖에 없는데, 정의서가 적요1을 "최대100Byte제한, 후불접수시 짤릴 수 있음"이라고
// 못박는다. 뒤에 붙이면 잘려나가는 쪽이 차량번호가 되고, 그러면 기사가 현장에서 어느 차인지
// 알 수 없다. 그래서 맨 앞이어야 하고, 그게 실제로 그런지를 여기서 본다.
//
// 네트워크도 DB도 쓰지 않는다 — 순수 조합 규칙이라 그대로 부를 수 있다.
//
//   node scripts/check-callmaner-memo.js
const callmaner = require('../lib/callmaner');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}${ok ? '' : `\n         기대: ${JSON.stringify(expected)}\n         실제: ${JSON.stringify(actual)}`}`);
}

const memo = (vehicle, customerMemo) =>
  callmaner.memoWithVehicle({ vehicle_number: vehicle, memo_customer: customerMemo });

console.log('[적요1 조합]');
check('차량번호가 맨 앞에 온다', memo('335모6328', '경비실에 키 전달'), '335모6328 / 경비실에 키 전달');
check('요청사항이 없으면 번호만', memo('335모6328', ''), '335모6328');
check('번호가 없으면 요청사항만', memo(null, '경비실에 키 전달'), '경비실에 키 전달');
check('둘 다 없으면 빈 문자열', memo(null, null), '');
// 고객이 요청사항 첫머리에 직접 적는 경우가 있다 — 두 번 적어봐야 100byte만 축낸다.
check('이미 맨 앞에 있으면 그대로 둔다', memo('335모6328', '335모6328 경비실에 키 전달'), '335모6328 경비실에 키 전달');
// 중간에 있으면 앞에 한 번 더 붙인다 — 잘려서 사라지는 것보다 중복이 낫다.
check('중간에 있으면 앞에 붙인다', memo('335모6328', '차량 335모6328 확인 요망'), '335모6328 / 차량 335모6328 확인 요망');
check('앞뒤 공백은 정리한다', memo('  335모6328  ', '  키 전달  '), '335모6328 / 키 전달');

console.log('\n[100byte 잘림 — 차량번호가 살아남는가]');
{
  // 정의서: 적요1은 varchar 100 이고 후불접수시 더 짤릴 수 있다.
  const long = '가'.repeat(200);
  const composed = callmaner.memoWithVehicle({ vehicle_number: '335모6328', memo_customer: long });
  const sent = callmaner.truncateBytes(composed, 100);
  check('잘린 뒤에도 번호가 남는다', sent.startsWith('335모6328'), true);
  check('100byte를 넘기지 않는다', Buffer.byteLength(sent, 'utf8') <= 100, true);
  // 예전처럼 요청사항만 보냈다면 100byte가 전부 요청사항으로 채워져 번호가 아예 안 갔다.
  const oldWay = callmaner.truncateBytes(long, 100);
  check('예전 방식에는 번호가 없었다', oldWay.includes('335모6328'), false);
}

console.log('\n[실제 payload에 실리는가]');
(async () => {
  const order = {
    origin_lat: 37.487254, origin_lon: 127.103169,
    origin_sido: '경기', origin_sigugun: '성남시분당구', origin_dong: '야탑동',
    origin_address: '경기 성남시 분당구 야탑동 1', origin_address_detail: '정문',
    fare_amount: 50000,
    memo_customer: '경비실에 키 전달',
    vehicle_number: '335모6328',
    order_type: 'dispatch',
  };
  const rq = await callmaner.buildOrderPayload(order, '현금', []);
  check('rq.memo 맨 앞이 차량번호', rq.memo, '335모6328 / 경비실에 키 전달');

  // 차량번호가 없는 오더(대리운전 등)는 예전과 똑같아야 한다 — 회귀 확인.
  const noVehicle = await callmaner.buildOrderPayload({ ...order, vehicle_number: null }, '현금', []);
  check('차량번호가 없으면 예전 그대로', noVehicle.memo, '경비실에 키 전달');

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
