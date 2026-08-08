// 카카오 능동 통보의 판정과 문구를 DB 없이 확인한다.
//
// 이 통보는 고객에게 먼저 말을 거는 기능이라, 틀리면 "안 온 기사를 기다리게" 만든다. 완료 기준이
// 오발신 0건인 이유다. 상태 전이 판정과 문구는 DB 없이도 확인할 수 있어서 여기서 못박는다.
// (실제 발신·중복방지는 마이그레이션을 적용한 뒤 scripts/check-kakao-order-notify-db.js로 본다.)
//
//   node scripts/check-kakao-order-notify.js
const { classifyTransition, buildMessage, renderTemplate, driverKey, DEFAULT_EVENT_SETTINGS } = require('../lib/kakaoOrderNotify');

let failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}`);
  if (!ok) console.log(`         기대: ${JSON.stringify(expected)}\n         실제: ${JSON.stringify(actual)}`);
}

console.log('[상태 전이 판정]');
check('접수 → 기사배정 = 배차완료', classifyTransition('접수', '기사배정'), 'dispatched');
check('대기 → 기사배정 = 배차완료', classifyTransition('대기', '기사배정'), 'dispatched');
check('기사배정 → 완료 = 운행완료', classifyTransition('기사배정', '완료'), 'completed');
check('접수 → 완료 = 운행완료(배차를 건너뛴 경우도)', classifyTransition('접수', '완료'), 'completed');
check('기사배정 → 접수 = 배차취소', classifyTransition('기사배정', '접수'), 'dispatch_cancelled');
check('기사배정 → 대기 = 배차취소', classifyTransition('기사배정', '대기'), 'dispatch_cancelled');
check('기사배정 → 예약 = 배차취소', classifyTransition('기사배정', '예약'), 'dispatch_cancelled');
check('기사배정 → 취소 = 오더취소', classifyTransition('기사배정', '취소'), 'cancelled');
check('접수 → 취소 = 오더취소', classifyTransition('접수', '취소'), 'cancelled');

// 배차취소와 오더취소가 갈리는 지점 — 오더가 끝난 것을 "다시 배차 중"이라고 안내하면
// 고객은 오지 않을 기사를 기다린다.
check('기사배정 → 취소는 배차취소가 아니다', classifyTransition('기사배정', '취소') !== 'dispatch_cancelled', true);

// 여기부터가 오발신을 막는 선이다.
check('기사배정 → 기사배정은 통보 없음', classifyTransition('기사배정', '기사배정'), null);
check('접수 → 대기는 통보 없음', classifyTransition('접수', '대기'), null);
check('완료 → 완료는 통보 없음', classifyTransition('완료', '완료'), null);
check('old_status가 없으면 통보 없음', classifyTransition(null, '기사배정'), null);

console.log('\n[기본 문구]');
const withDriver = { oid: 'OID1234', callmaner_driver_name: '홍길동', callmaner_driver_phone: '010-1111-2222' };
check(
  '배차완료 — 기사 정보 포함',
  buildMessage('dispatched', withDriver),
  '[OID1234] 배차가 완료되었습니다.\n기사: 홍길동 (010-1111-2222)'
);
check(
  '배차완료 — 기사 정보가 없으면 그 줄을 통째로 뺀다',
  buildMessage('dispatched', { oid: 'OID1234' }),
  '[OID1234] 배차가 완료되었습니다.'
);
check(
  '배차취소 — 다시 배차 중임을 알린다',
  buildMessage('dispatch_cancelled', withDriver),
  '[OID1234] 배차받은 기사님이 취소하였고, 다른 기사님께 배차 진행중입니다.'
);
check('운행완료', buildMessage('completed', withDriver), '[OID1234] 운행이 완료되었습니다. 이용해주셔서 감사합니다.');
check(
  '오더취소',
  buildMessage('cancelled', withDriver),
  '[OID1234] 오더가 취소되었습니다. 문의사항은 상담원에게 말씀해주세요.'
);
check('사건 네 가지 모두 기본 문구가 있다', Object.keys(DEFAULT_EVENT_SETTINGS).length, 4);

console.log('\n[지사가 고친 문구]');
const order = {
  oid: 'OID9', callmaner_driver_name: '김철수', callmaner_driver_phone: '010-9999-8888',
  origin_address: '서울 강서구', destination_address: '경기 성남시', reserved_date: '2026-08-20', reserved_time: '14:00',
};
check(
  '변수를 값으로 바꾼다',
  renderTemplate('{oid} {origin} → {destination} ({reserved_at})', order),
  'OID9 서울 강서구 → 경기 성남시 (2026-08-20 14:00)'
);
check(
  '값이 비면 그 자리를 지우고 빈 껍데기도 정리한다',
  renderTemplate('배차완료\n기사: {driver_name} ({driver_phone})', { oid: 'OID9' }),
  '배차완료'
);
check('모르는 변수는 그대로 둔다(오타를 눈에 띄게)', renderTemplate('{없는변수} {oid}', order), '{없는변수} OID9');
check(
  '지사가 넣은 문구를 그대로 쓴다',
  buildMessage('dispatched', order, { template: '{oid} 기사님이 배정되었어요. {driver_name}' }),
  'OID9 기사님이 배정되었어요. 김철수'
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
