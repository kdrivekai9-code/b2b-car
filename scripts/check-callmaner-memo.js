// 콜마너 적요1(memo)에 차종·차량번호가 맨 앞으로 실리는지 확인한다.
//
// 왜 필요한가: 콜마너 오더접수/오더수정 요청에는 차량 칸이 아예 없다(정의서 v1.7 전수 확인 —
// 차량 관련은 driver_option의 `탁송(yn)` 플래그뿐). 그래서 차종·번호를 기사에게 전달할 길은
// 적요밖에 없는데, 정의서가 적요1을 "최대100Byte제한, 후불접수시 짤릴 수 있음"이라고 못박는다.
// 뒤에 붙이면 잘려나가는 쪽이 차량 정보가 되고, 그러면 기사가 현장에서 어느 차인지 모른다.
//
// **어디서 붙는지가 2026-09-07에 바뀌었다**(사용자 지시). 예전에는 콜마너로 보내는 순간에만
// memoWithVehicle이 끼웠다 — 그래서 관리자 화면의 기사전달사항에는 그 값이 없고, 무엇이
// 전달됐는지 확인할 방법이 없었다(콜마너에만 남는 문자열). 지금은 **저장할 때** 붙고
// (lib/intakeMemoSplit.js withVehiclePrefix, lib/orderCreate.js), 전송은 저장값을 그대로
// 보낸다. 그래서 이 검사도 "전송 시점에 조립하는가"가 아니라 "저장값이 그대로 나가는가"를 본다.
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

const { vehiclePrefix, withVehiclePrefix } = require('../lib/intakeMemoSplit');

// 저장되는 기사 전달사항을 만든다 — 실제 저장 경로와 같은 함수를 쓴다.
const stored = (type, plate, body) => withVehiclePrefix(body, vehiclePrefix(type, plate));

console.log('[저장값 — 차종·차량번호가 맨 앞]');
check('차종과 번호가 맨 앞에 온다', stored('토레스', '335모6328', '경비실에 키 전달'), '토레스 335모6328 / 경비실에 키 전달');
// 차종이 없는 오더도 있다. 번호만이라도 앞에 와야 한다.
check('차종이 없으면 번호만', stored(null, '335모6328', '경비실에 키 전달'), '335모6328 / 경비실에 키 전달');
check('요청사항이 없으면 차량 표시만', stored('토레스', '335모6328', ''), '토레스 335모6328');
check('차량을 모르면 요청사항만', stored(null, null, '경비실에 키 전달'), '경비실에 키 전달');
// 수정 저장을 반복할 때마다 쌓이면 적요1이 그것만으로 찬다.
check('이미 앞에 있으면 안 겹쳐 붙인다', stored('토레스', '335모6328', '토레스 335모6328 / 키 전달'), '토레스 335모6328 / 키 전달');
check('앞뒤 공백은 정리한다', stored(' 토레스 ', '  335모6328  ', '  키 전달  '), '토레스 335모6328 / 키 전달');

console.log('\n[전송 — 저장값을 그대로 보낸다]');
const sendOf = (order) => callmaner.memoWithVehicle(order);
// 조립하지 않는다. 조립하면 콜마너에만 있는 문자열이 생겨 화면에서 확인할 수 없다.
check('요약이 있으면 요약을 그대로',
  sendOf({ vehicle_number: '335모6328', vehicle_type: '토레스', memo_driver_brief: '토레스 335모6328 / 키 전달', memo_customer: '전체 원문' }),
  '토레스 335모6328 / 키 전달');
check('요약이 없으면 기사 전달사항을 그대로',
  sendOf({ vehicle_number: '335모6328', vehicle_type: '토레스', memo_customer: '토레스 335모6328 / 키 전달' }),
  '토레스 335모6328 / 키 전달');
// 요청사항이 아예 없는 오더 — 이 칸이 비면 기사는 무슨 차인지 모른다.
check('둘 다 없으면 차량 표시만',
  sendOf({ vehicle_number: '335모6328', vehicle_type: '토레스' }), '토레스 335모6328');
check('차량도 없으면 빈 문자열', sendOf({}), '');

console.log('\n[100byte 잘림 — 차량 표시가 살아남는가]');
{
  // 정의서: 적요1은 varchar 100 이고 후불접수시 더 짤릴 수 있다.
  const long = '가'.repeat(200);
  const sent = callmaner.truncateBytes(stored('토레스', '335모6328', long), 100);
  check('잘린 뒤에도 차량 표시가 남는다', sent.startsWith('토레스 335모6328'), true);
  check('100byte를 넘기지 않는다', Buffer.byteLength(sent, 'utf8') <= 100, true);
  // 뒤에 붙였다면 100byte가 전부 요청사항으로 채워져 차량 정보가 아예 안 갔다.
  check('뒤에 붙이면 사라진다', callmaner.truncateBytes(long, 100).includes('335모6328'), false);
}

console.log('\n[실제 payload에 실리는가]');
(async () => {
  const order = {
    origin_lat: 37.487254, origin_lon: 127.103169,
    origin_sido: '경기', origin_sigugun: '성남시분당구', origin_dong: '야탑동',
    origin_address: '경기 성남시 분당구 야탑동 1', origin_address_detail: '정문',
    fare_amount: 50000,
    // 저장 시점에 이미 붙어 있는 모양을 그대로 준다(위 [저장값] 참고).
    memo_customer: '토레스 335모6328 / 경비실에 키 전달',
    vehicle_number: '335모6328',
    vehicle_type: '토레스',
    order_type: 'dispatch',
  };
  const rq = await callmaner.buildOrderPayload(order, '현금', []);
  check('rq.memo 맨 앞이 차량 표시', rq.memo, '토레스 335모6328 / 경비실에 키 전달');
  // 저장값과 전송값이 같아야 화면에서 전달 여부를 확인할 수 있다 — 이 변경의 목적이다.
  check('저장값과 전송값이 같다', rq.memo, order.memo_customer);

  // 차량번호가 없는 오더(대리운전 등). 이제는 전송이 아니라 **저장**에서 갈린다 —
  // 접두어가 안 붙은 값이 저장되고, 전송은 그것을 그대로 보낸다. 전송 쪽에서 다시
  // 판단하지 않는 것이 이 변경의 요점이라, 저장값을 그대로 넣어 확인한다.
  const noVehicle = await callmaner.buildOrderPayload(
    { ...order, vehicle_number: null, vehicle_type: null, memo_customer: stored(null, null, '경비실에 키 전달') },
    '현금', []
  );
  check('차량을 모르면 접두어 없이 그대로', noVehicle.memo, '경비실에 키 전달');

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
