// 카카오 능동 통보의 판정과 문구를 DB 없이 확인한다.
//
// 이 통보는 고객에게 먼저 말을 거는 기능이라, 틀리면 "안 온 기사를 기다리게" 만든다. 완료 기준이
// 오발신 0건인 이유다. 상태 전이 판정과 문구는 DB 없이도 확인할 수 있어서 여기서 못박는다.
// (실제 발신·중복방지는 마이그레이션을 적용한 뒤 scripts/check-kakao-order-notify-db.js로 본다.)
//
//   node scripts/check-kakao-order-notify.js
const { classifyTransition, buildMessage, driverKey } = require('../lib/kakaoOrderNotify');

let failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}`);
  if (!ok) console.log(`         기대: ${JSON.stringify(expected)}\n         실제: ${JSON.stringify(actual)}`);
}

console.log('[상태 전이 판정]');
check('접수 → 기사배정 = 배차 통보', classifyTransition('접수', '기사배정'), 'dispatched');
check('대기 → 기사배정 = 배차 통보', classifyTransition('대기', '기사배정'), 'dispatched');
check('기사배정 → 접수 = 배차 취소', classifyTransition('기사배정', '접수'), 'dispatch_cancelled');
check('기사배정 → 대기 = 배차 취소', classifyTransition('기사배정', '대기'), 'dispatch_cancelled');
check('기사배정 → 예약 = 배차 취소', classifyTransition('기사배정', '예약'), 'dispatch_cancelled');

// 여기부터가 오발신을 막는 선이다.
check('기사배정 → 완료는 통보 없음', classifyTransition('기사배정', '완료'), null);
check('기사배정 → 취소는 통보 없음(오더가 끝난 것)', classifyTransition('기사배정', '취소'), null);
check('기사배정 → 기사배정은 통보 없음', classifyTransition('기사배정', '기사배정'), null);
check('접수 → 대기는 통보 없음', classifyTransition('접수', '대기'), null);
check('old_status가 없으면 통보 없음', classifyTransition(null, '기사배정'), null);

console.log('\n[문구]');
const withDriver = { oid: 'OID1234', callmaner_driver_name: '홍길동', callmaner_driver_phone: '010-1111-2222' };
check(
  '배차 완료 — 기사 정보 포함',
  buildMessage('dispatched', withDriver),
  '[OID1234] 배차가 완료되었습니다.\n기사: 홍길동 (010-1111-2222)'
);
check(
  '배차 완료 — 기사 정보가 없으면 그 줄을 빼고 보낸다',
  buildMessage('dispatched', { oid: 'OID1234' }),
  '[OID1234] 배차가 완료되었습니다.'
);
check(
  '배차 취소 — 다시 배차 중임을 알린다',
  buildMessage('dispatch_cancelled', withDriver),
  '[OID1234] 배차받은 기사님이 취소하였고, 다른 기사님께 배차 진행중입니다.'
);

console.log('\n[중복 판정 키]');
// 취소 후 다른 기사에게 다시 배차되면 새 통보여야 한다 — 키가 같으면 두 번째 배차가 묻힌다.
check('사번이 있으면 사번', driverKey({ callmaner_driver_sabun: 'A1', callmaner_driver_phone: '010' }), 'A1');
check('사번이 없으면 연락처', driverKey({ callmaner_driver_phone: '010-1111-2222' }), '010-1111-2222');
check('둘 다 없으면 이름', driverKey({ callmaner_driver_name: '홍길동' }), '홍길동');
check('기사 정보가 아예 없으면 빈 문자열', driverKey({}), '');
check(
  '기사가 다르면 키도 다르다',
  driverKey({ callmaner_driver_sabun: 'A1' }) !== driverKey({ callmaner_driver_sabun: 'A2' }),
  true
);

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exitCode = failed ? 1 : 0;
