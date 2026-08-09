// 접수 분리 규칙을 확인한다 — 언제 나누고, 어떻게 나누고, 무엇을 물어야 하는지.
//
// 실제 운영 규칙(사용자 확인, 2026-08-09): 경유지가 있거나 · 왕복콜이거나 · 구간마다 수행일이
// 다르면 오더를 구간별로 나눠 접수한다. 지금까지는 상담원이 손으로 나눴다.
//
// 이 규칙이 틀리면 고객 요청과 다른 오더가 만들어진다 — 구간이 뒤바뀌거나, 두 건이 같은 시각에
// 겹쳐 접수되거나, 연락처가 비어 등록 자체가 막힌다. DB 없이 확인할 수 있어서 여기서 못박는다.
//
//   node scripts/check-order-split.js
const { splitIntake, splitReason, describeSplit } = require('../lib/orderSplit');

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}`);
  if (!ok) console.log(`         기대: ${JSON.stringify(expected)}\n         실제: ${JSON.stringify(actual)}`);
}

const BASE = {
  originAddress: '서울 강서구 출발지',
  originContact: '010-1111-2222',
  destinationAddress: '부산 해운대 도착지',
  destinationContact: '010-3333-4444',
  reservedDate: '2026-08-20',
  reservedTime: '14:00',
  vehicleNumber: '12가3456',
  vehicleType: '토레스',
  memoCustomer: '조심히 운행 부탁드립니다',
  waypoints: [],
};

console.log('[나눠야 하는지 판정]');
check('경유지도 왕복도 아니면 나누지 않는다', splitReason(BASE), null);
check('경유지가 있으면 나눈다', splitReason({ ...BASE, waypoints: [{ address: '대전 중구' }] }), 'waypoint');
check('왕복이면 나눈다', splitReason({ ...BASE, roundTrip: true }), 'round_trip');
// 주소가 빈 경유지 행은 폼에서 흔히 생긴다 — 그걸로 나누면 빈 구간이 만들어진다.
check('주소 없는 경유지는 세지 않는다', splitReason({ ...BASE, waypoints: [{ address: '   ' }] }), null);

console.log('\n[나눌 필요가 없을 때]');
{
  const { reason, parts, missingSchedule } = splitIntake(BASE);
  check('한 건 그대로', parts.length, 1);
  check('이유 없음', reason, null);
  check('되물을 것도 없다', missingSchedule, []);
  // 호출부가 분기 없이 항상 같은 방식으로 쓰도록 원본도 목록에 담아 돌려준다.
  check('출발지는 그대로', parts[0].originAddress, BASE.originAddress);
  check('예약일시도 그대로', [parts[0].reservedDate, parts[0].reservedTime], ['2026-08-20', '14:00']);
}

console.log('\n[경유지 하나 → 2건]');
{
  const { reason, parts, missingSchedule } = splitIntake({
    ...BASE,
    waypoints: [{ address: '대전 중구 경유지', contact: '010-5555-6666' }],
  });
  check('이유는 경유지', reason, 'waypoint');
  check('2건으로 나뉜다', parts.length, 2);

  check('1건: 출발지 → 경유지', [parts[0].originAddress, parts[0].destinationAddress], ['서울 강서구 출발지', '대전 중구 경유지']);
  check('2건: 경유지 → 도착지', [parts[1].originAddress, parts[1].destinationAddress], ['대전 중구 경유지', '부산 해운대 도착지']);

  check('1건은 원래 예약일시', [parts[0].reservedDate, parts[0].reservedTime], ['2026-08-20', '14:00']);
  // 경유지에서 다시 출발하는 시각은 아무도 말해주지 않았다. 같은 시각을 넣으면 두 건이 겹친다.
  check('2건 일시는 비어 있다', [parts[1].reservedDate, parts[1].reservedTime], [null, null]);
  check('2건을 되물어야 한다', missingSchedule, [2]);

  check('1건 도착 연락처는 경유지 연락처', parts[0].destinationContact, '010-5555-6666');
  check('2건 출발 연락처도 경유지 연락처', parts[1].originContact, '010-5555-6666');
  check('경유지는 비워진다', parts[0].waypoints, []);
  // 메모·차종 같은 나머지는 두 건 모두에 그대로 따라간다.
  check('메모가 따라간다', parts[1].memoCustomer, BASE.memoCustomer);
  check('차종이 따라간다', parts[1].vehicleType, '토레스');
  check('묶음 순번', [parts[0].splitSeq, parts[1].splitSeq], [1, 2]);
  check('묶음 총건수', parts[0].splitTotal, 2);
}

console.log('\n[경유지 둘 → 3건]');
{
  const { parts } = splitIntake({
    ...BASE,
    waypoints: [{ address: '대전 중구' }, { address: '대구 수성구' }],
  });
  check('3건으로 나뉜다', parts.length, 3);
  check('구간이 이어진다', parts.map((p) => `${p.originAddress}→${p.destinationAddress}`), [
    '서울 강서구 출발지→대전 중구',
    '대전 중구→대구 수성구',
    '대구 수성구→부산 해운대 도착지',
  ]);
}

console.log('\n[경유지 연락처가 없을 때]');
{
  const { parts } = splitIntake({ ...BASE, waypoints: [{ address: '대전 중구' }] });
  // 연락처가 비면 서버가 등록을 막는다. 경유지 연락처를 안 받는 경우가 흔해서 물려받는다.
  check('출발지 연락처를 물려받는다', parts[1].originContact, '010-1111-2222');
  check('빈 값으로 두지 않는다', parts[0].destinationContact !== '', true);
}

console.log('\n[왕복 → 2건]');
{
  const { reason, parts, missingSchedule } = splitIntake({ ...BASE, roundTrip: true });
  check('이유는 왕복', reason, 'round_trip');
  check('2건으로 나뉜다', parts.length, 2);
  check('가는 편', [parts[0].originAddress, parts[0].destinationAddress], ['서울 강서구 출발지', '부산 해운대 도착지']);
  // 오는 편은 출발지와 도착지가 뒤집힌다 — 여기가 뒤바뀌면 기사가 반대로 간다.
  check('오는 편은 뒤집힌다', [parts[1].originAddress, parts[1].destinationAddress], ['부산 해운대 도착지', '서울 강서구 출발지']);
  check('연락처도 함께 뒤집힌다', [parts[1].originContact, parts[1].destinationContact], ['010-3333-4444', '010-1111-2222']);
  check('복귀 일시를 되물어야 한다', missingSchedule, [2]);
  check('나뉜 건은 다시 왕복이 아니다', parts[1].roundTrip, false);
}

console.log('\n[복귀 일시를 이미 아는 왕복]');
{
  const { missingSchedule, parts } = splitIntake({
    ...BASE, roundTrip: true, returnReservedDate: '2026-08-21', returnReservedTime: '09:00',
  });
  check('되물을 것이 없다', missingSchedule, []);
  check('복귀 일시가 들어간다', [parts[1].reservedDate, parts[1].reservedTime], ['2026-08-21', '09:00']);
}

console.log('\n[구간마다 수행일이 다를 때]');
{
  // 경유지에 일시가 적혀 오면 그대로 쓴다 — 이게 "수행일이 다른 경우"를 담는 자리다.
  const { parts, missingSchedule } = splitIntake({
    ...BASE,
    waypoints: [{ address: '대전 중구', reservedDate: '2026-08-22', reservedTime: '10:00' }],
  });
  check('2건은 그 날짜로 접수된다', [parts[1].reservedDate, parts[1].reservedTime], ['2026-08-22', '10:00']);
  check('되물을 것이 없다', missingSchedule, []);
  check('1건은 원래 날짜 그대로', parts[0].reservedDate, '2026-08-20');
}

console.log('\n[표시 문구]');
check('경유지 분리', describeSplit('waypoint', 1, 2), '경유지 분리 1/2건');
check('왕복 분리', describeSplit('round_trip', 2, 2), '왕복 분리 2/2건');

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exitCode = failed ? 1 : 0;
