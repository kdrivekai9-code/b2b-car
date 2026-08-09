// 접수 분리 규칙을 확인한다 — 언제 나누고(대부분은 나누지 않고), 어떻게 나누는지.
//
// 규칙(사용자 확인, 2026-08-09): **기본은 한 건이다.** 경유지가 있다고, 왕복이라고 무조건
// 나누지 않는다 — 같은 날 이어서 도는 평범한 운행까지 쪼개면 접수·정산·배차가 두 배가 된다.
// 나누는 경우는 수행일이 갈릴 때뿐이다.
//
// 이 판정이 헐거우면 멀쩡한 한 건이 두 건으로 접수되고, 반대로 빡빡하면 다른 날 운행이 한 건에
// 뭉쳐 기사가 언제 가야 할지 알 수 없게 된다. DB 없이 확인할 수 있어서 여기서 못박는다.
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

console.log('[나누지 않는 경우 — 기본]');
check('경유지도 왕복도 아니면 그대로', splitReason(BASE), null);
// 여기가 이 규칙의 핵심이다. 경유지가 있다는 이유만으로 나누면 안 된다.
check('경유지가 있어도 날짜가 같으면 그대로', splitReason({ ...BASE, waypoints: [{ address: '대전 중구' }] }), null);
check(
  '경유지에 같은 날짜가 적혀도 그대로',
  splitReason({ ...BASE, waypoints: [{ address: '대전 중구', reservedDate: '2026-08-20' }] }),
  null
);
// 같은 날 안에서 시각만 다른 건 평범한 경유 운행이다.
check(
  '같은 날 시각만 달라도 그대로',
  splitReason({ ...BASE, waypoints: [{ address: '대전 중구', reservedDate: '2026-08-20', reservedTime: '18:00' }] }),
  null
);
check('왕복이어도 복귀일이 없으면 그대로', splitReason({ ...BASE, roundTrip: true }), null);
check(
  '왕복 복귀가 같은 날이면 그대로',
  splitReason({ ...BASE, roundTrip: true, returnReservedDate: '2026-08-20' }),
  null
);
check('주소 없는 경유지는 세지 않는다', splitReason({ ...BASE, waypoints: [{ address: '   ', reservedDate: '2026-08-25' }] }), null);

console.log('\n[나누지 않을 때 결과]');
{
  const { reason, parts, missingSchedule } = splitIntake({ ...BASE, waypoints: [{ address: '대전 중구', contact: '010-5555-6666' }] });
  check('한 건 그대로', parts.length, 1);
  check('이유 없음', reason, null);
  check('되물을 것도 없다', missingSchedule, []);
  // 경유지는 사라지면 안 된다 — 한 건으로 접수하되 경유지를 그대로 담는다.
  check('경유지가 그대로 남는다', parts[0].waypoints.length, 1);
  check('예약일시도 그대로', [parts[0].reservedDate, parts[0].reservedTime], ['2026-08-20', '14:00']);
}

console.log('\n[경유지 날짜가 다르면 나눈다]');
{
  const { reason, parts, missingSchedule } = splitIntake({
    ...BASE,
    waypoints: [{ address: '대전 중구 경유지', contact: '010-5555-6666', reservedDate: '2026-08-22' }],
  });
  check('이유는 경유지', reason, 'waypoint');
  check('2건으로 나뉜다', parts.length, 2);
  check('1건: 출발지 → 경유지', [parts[0].originAddress, parts[0].destinationAddress], ['서울 강서구 출발지', '대전 중구 경유지']);
  check('2건: 경유지 → 도착지', [parts[1].originAddress, parts[1].destinationAddress], ['대전 중구 경유지', '부산 해운대 도착지']);
  check('1건은 원래 날짜', parts[0].reservedDate, '2026-08-20');
  check('2건은 경유지에 적힌 날짜', parts[1].reservedDate, '2026-08-22');
  // 날짜만 갈렸을 뿐 시각은 아무도 말해주지 않았다. 앞 건과 같은 시각을 넣으면 틀린 시각이 접수된다.
  check('2건 시각은 비어 있다', parts[1].reservedTime, null);
  check('2건 시각을 되물어야 한다', missingSchedule, [2]);

  check('1건 도착 연락처는 경유지 연락처', parts[0].destinationContact, '010-5555-6666');
  check('2건 출발 연락처도 경유지 연락처', parts[1].originContact, '010-5555-6666');
  check('나뉜 건에는 경유지가 없다', parts[0].waypoints, []);
  check('메모가 따라간다', parts[1].memoCustomer, BASE.memoCustomer);
  check('묶음 순번', [parts[0].splitSeq, parts[1].splitSeq], [1, 2]);
  check('묶음 총건수', parts[0].splitTotal, 2);
}

console.log('\n[경유지 시각까지 적혀 있으면 되묻지 않는다]');
{
  const { parts, missingSchedule } = splitIntake({
    ...BASE,
    waypoints: [{ address: '대전 중구', reservedDate: '2026-08-22', reservedTime: '10:00' }],
  });
  check('그 일시로 접수된다', [parts[1].reservedDate, parts[1].reservedTime], ['2026-08-22', '10:00']);
  check('되물을 것이 없다', missingSchedule, []);
}

console.log('\n[경유지 둘 — 날짜가 갈리는 지점에서만 끊는다]');
{
  // 경유1은 같은 날, 경유2만 다른 날 → 경유1은 경유지로 남고 경유2에서 끊긴다.
  const { parts } = splitIntake({
    ...BASE,
    waypoints: [
      { address: '대전 중구' },
      { address: '대구 수성구', reservedDate: '2026-08-23' },
    ],
  });
  check('2건이다(3건이 아니다)', parts.length, 2);
  check('1건: 출발 → 대구(대전 경유)', [parts[0].originAddress, parts[0].destinationAddress], ['서울 강서구 출발지', '대구 수성구']);
  check('대전은 경유지로 남는다', parts[0].waypoints.map((w) => w.address), ['대전 중구']);
  check('2건: 대구 → 도착지', [parts[1].originAddress, parts[1].destinationAddress], ['대구 수성구', '부산 해운대 도착지']);
  check('2건 날짜', parts[1].reservedDate, '2026-08-23');
}

console.log('\n[경유지 둘이 각각 다른 날이면 3건]');
{
  const { parts } = splitIntake({
    ...BASE,
    waypoints: [
      { address: '대전 중구', reservedDate: '2026-08-21' },
      { address: '대구 수성구', reservedDate: '2026-08-23' },
    ],
  });
  check('3건으로 나뉜다', parts.length, 3);
  check('구간이 이어진다', parts.map((p) => `${p.originAddress}→${p.destinationAddress}`), [
    '서울 강서구 출발지→대전 중구',
    '대전 중구→대구 수성구',
    '대구 수성구→부산 해운대 도착지',
  ]);
  check('날짜가 각각 들어간다', parts.map((p) => p.reservedDate), ['2026-08-20', '2026-08-21', '2026-08-23']);
}

console.log('\n[왕복 복귀일이 다르면 나눈다]');
{
  const { reason, parts, missingSchedule } = splitIntake({
    ...BASE, roundTrip: true, returnReservedDate: '2026-08-21',
  });
  check('이유는 왕복', reason, 'round_trip');
  check('2건으로 나뉜다', parts.length, 2);
  check('가는 편', [parts[0].originAddress, parts[0].destinationAddress], ['서울 강서구 출발지', '부산 해운대 도착지']);
  // 여기가 뒤바뀌면 기사가 반대로 간다.
  check('오는 편은 뒤집힌다', [parts[1].originAddress, parts[1].destinationAddress], ['부산 해운대 도착지', '서울 강서구 출발지']);
  check('연락처도 함께 뒤집힌다', [parts[1].originContact, parts[1].destinationContact], ['010-3333-4444', '010-1111-2222']);
  check('복귀 날짜가 들어간다', parts[1].reservedDate, '2026-08-21');
  check('복귀 시각을 되물어야 한다', missingSchedule, [2]);
  check('나뉜 건은 다시 왕복이 아니다', parts[1].roundTrip, false);
}

console.log('\n[왕복 + 경유지]');
{
  // 왕복 분리는 복귀편을 떼어내는 것이지 경유를 쪼개는 게 아니다.
  const { parts } = splitIntake({
    ...BASE,
    roundTrip: true,
    returnReservedDate: '2026-08-21',
    returnReservedTime: '09:00',
    waypoints: [{ address: '대전 중구' }],
  });
  check('2건', parts.length, 2);
  check('가는 편에 경유지가 남는다', parts[0].waypoints.map((w) => w.address), ['대전 중구']);
  check('오는 편에는 경유지가 없다', parts[1].waypoints, []);
  check('복귀 일시가 그대로', [parts[1].reservedDate, parts[1].reservedTime], ['2026-08-21', '09:00']);
}

console.log('\n[연락처가 비어 있을 때]');
{
  const { parts } = splitIntake({ ...BASE, waypoints: [{ address: '대전 중구', reservedDate: '2026-08-22' }] });
  // 연락처가 비면 서버가 등록을 막는다. 경유지 연락처를 안 받는 경우가 흔해서 물려받는다.
  check('출발지 연락처를 물려받는다', parts[1].originContact, '010-1111-2222');
  check('빈 값으로 두지 않는다', parts[0].destinationContact !== '', true);
}

console.log('\n[표시 문구]');
check('경유지 분리', describeSplit('waypoint', 1, 2), '경유지 분리 1/2건');
check('왕복 분리', describeSplit('round_trip', 2, 2), '왕복 분리 2/2건');

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exitCode = failed ? 1 : 0;
