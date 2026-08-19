// 프리미엄 대리·일일기사 되묻기가 빠진 항목을 **하나씩** 묻는지 확인한다.
//
// 왜 필요한가: 이 카테고리는 빠지는 항목이 많은 데다(이용 형태·연락처·차량·도착지·최종
// 목적지·경유지·대기시간·전달사항) 앞 항목의 답에 따라 뒤 항목이 늘어난다 — "왕복"을 고르면
// 최종 목적지가 새로 생긴다. 목록으로 뭉쳐 물으면 고객 화면에서는 목록이 줄었다 늘었다 하고,
// 방금 답한 값이 확인란에 안 나와서 답이 무시된 것처럼 보인다. 실사용 대화가 그렇게 겉돌았다:
//
//   AI  : 접수하려면 아래 항목이 더 필요합니다.
//         · 이용 형태(왕복/편도) · 출발지 연락처 · 차종/차량번호 · 도착지 주소
//   고객: 왕복  01033331444
//   AI  : 아래 내용으로 확인했습니다.
//         · 출발 창업로17 포레나오피스텔    ← 왕복도 연락처도 안 보인다
//         · 일시 2026-08-20 09:00
//         접수하려면 아래 항목이 더 필요합니다.
//         · 차종/차량번호 · 도착지 주소 · 최종 목적지(복귀 주소)   ← 항목이 되레 늘었다
//
// 순수 문구 조립이라 네트워크도 DB도 쓰지 않는다.
//
//   node scripts/check-premium-step-questions.js
const { buildNextMissingQuestion } = require('../lib/kakaoIntakeParser');
const { getDailyDriverFields } = require('../lib/intakeFields');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}${ok || !detail ? '' : `\n         ${detail}`}`);
}

// 실사용 대화의 1턴 상태 — 출발지와 일시만 잡힌 시점.
const afterFirstTurn = {
  origin: { address: '창업로17 포레나오피스텔', addressDetail: null, contact: null },
  destination: { address: null, addressDetail: null, contact: null },
  vehicles: [],
  when: { immediate: false, date: '2026-08-20', time: '09:00', raw: '2026-08-20 09:00' },
  tripType: null,
  destinationWait: { minutes: null },
  missing: ['trip_type', 'origin_contact', 'vehicle_number', 'destination_address', 'waypoint'],
};

// 2턴 상태 — "왕복 01033331444"를 답한 뒤. 왕복이라 최종 목적지가 새로 생긴다.
const afterSecondTurn = {
  ...afterFirstTurn,
  origin: { address: '창업로17 포레나오피스텔', addressDetail: null, contact: '010-3333-1444' },
  tripType: 'round_trip',
  finalDestinationAddress: null,
  missing: ['vehicle_number', 'destination_address', 'waypoint', 'final_destination_address'],
};

console.log('[한 번에 하나만 묻는다]');
{
  const q = buildNextMissingQuestion(afterFirstTurn.missing, afterFirstTurn, null, getDailyDriverFields(null));
  console.log(`\n${q.split('\n').map((l) => `      ${l}`).join('\n')}\n`);
  check('첫 항목(이용 형태)만 묻는다', /이용 형태를 선택해 주세요/.test(q), q);
  check('다른 항목은 같이 묻지 않는다', !/출발지 연락처|차량번호를 알려/.test(q), q);
  check('남은 개수를 알려준다', /남은 항목 4개/.test(q), q);
  check('지금까지 확인한 내용을 되읽어준다', q.includes('창업로17 포레나오피스텔') && q.includes('2026-08-20 09:00'), q);
}

console.log('\n[방금 답한 값이 확인란에 나온다 — 실사용에서 어긋났던 지점]');
{
  const q = buildNextMissingQuestion(afterSecondTurn.missing, afterSecondTurn, null, getDailyDriverFields('round_trip'));
  console.log(`\n${q.split('\n').map((l) => `      ${l}`).join('\n')}\n`);
  check('"왕복"이 확인란에 보인다', /· 이용 형태 왕복/.test(q), q);
  check('연락처가 확인란에 보인다', /· 출발지 연락처 010-3333-1444/.test(q), q);
  check('다음 항목(차량번호)만 묻는다', /차량번호를 알려주세요/.test(q), q);
  check('도착지는 아직 묻지 않는다', !/도착지 주소를 알려주세요/.test(q), q);
  check('차량번호 예시를 붙인다', /그랜저 12가 1234/.test(q), q);
}

console.log('\n[마지막 한 항목이면 남은 개수를 붙이지 않는다]');
{
  const one = { ...afterSecondTurn, missing: ['destination_address'] };
  const q = buildNextMissingQuestion(one.missing, one, null, getDailyDriverFields('round_trip'));
  check('"남은 항목" 표기가 없다', !/남은 항목/.test(q), q);
  check('도착지를 묻는다', /도착지 주소를 알려주세요/.test(q), q);
}

console.log('\n[번호판 형식이 어긋난 경우]');
{
  // 고객은 이미 적었다고 생각한다 — "없다"고 하면 대화가 겉돈다.
  const bad = { ...afterSecondTurn, malformedPlate: true, missing: ['vehicle_number', 'destination_address'] };
  const q = buildNextMissingQuestion(bad.missing, bad, null, getDailyDriverFields('round_trip'));
  check('형식을 확인해달라고 묻는다', /형식을 확인해주세요/.test(q), q);
}

console.log('\n[빠진 항목이 없으면 질문하지 않는다]');
check('null을 돌려준다', buildNextMissingQuestion([], afterSecondTurn, null, getDailyDriverFields('round_trip')) === null);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
