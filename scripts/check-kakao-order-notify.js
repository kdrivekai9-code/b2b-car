// 카카오 능동 통보의 판정과 문구를 DB 없이 확인한다.
//
// 이 통보는 고객에게 먼저 말을 거는 기능이라, 틀리면 "안 온 기사를 기다리게" 만든다. 완료 기준이
// 오발신 0건인 이유다. 상태 전이 판정과 문구는 DB 없이도 확인할 수 있어서 여기서 못박는다.
// (실제 발신·중복방지는 마이그레이션을 적용한 뒤 scripts/check-kakao-order-notify-db.js로 본다.)
//
//   node scripts/check-kakao-order-notify.js
const {
  classifyTransition, buildMessage, renderTemplate, driverKey, mergeAddress,
  DEFAULT_EVENT_SETTINGS, TEMPLATE_VARIABLES, NEVER_DEFER_EVENTS,
} = require('../lib/kakaoOrderNotify');

// buildMessage는 { text, attachPhotos }를 돌려준다(사진은 텍스트가 아니라 별도 발송이라
// 스위치로 다룬다) — 문구만 보는 검사에서는 text만 꺼내 쓴다.
const msg = (...args) => buildMessage(...args).text;

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
check('기사배정 → 운행시작 = 운행시작', classifyTransition('기사배정', '운행시작'), 'started');
check('접수 → 운행시작 = 운행시작(배차를 놓친 경우도)', classifyTransition('접수', '운행시작'), 'started');
check('운행시작 → 완료 = 운행완료', classifyTransition('운행시작', '완료'), 'completed');
check('운행시작 → 취소 = 오더취소', classifyTransition('운행시작', '취소'), 'cancelled');
check('운행시작 → 접수 = 배차취소(운행 중 기사가 빠짐)', classifyTransition('운행시작', '접수'), 'dispatch_cancelled');

// 배차취소와 오더취소가 갈리는 지점 — 오더가 끝난 것을 "다시 배차 중"이라고 안내하면
// 고객은 오지 않을 기사를 기다린다.
check('기사배정 → 취소는 배차취소가 아니다', classifyTransition('기사배정', '취소') !== 'dispatch_cancelled', true);

// 여기부터가 오발신을 막는 선이다.
check('기사배정 → 기사배정은 통보 없음', classifyTransition('기사배정', '기사배정'), null);
check('접수 → 대기는 통보 없음', classifyTransition('접수', '대기'), null);
check('완료 → 완료는 통보 없음', classifyTransition('완료', '완료'), null);
check('old_status가 없으면 통보 없음', classifyTransition(null, '기사배정'), null);
// 콜마너는 운행 중에도 status='배차'를 계속 주므로 운행시작 → 기사배정 왕복이 실제로 생긴다.
// 이걸 배차로 보면 "배차되었습니다"가 매분 다시 나간다.
check('운행시작 → 기사배정은 통보 없음(콜마너 흔들림)', classifyTransition('운행시작', '기사배정'), null);

console.log('\n[기본 문구]');
const full = {
  oid: 'OID1234', order_type: 'dispatch',
  callmaner_driver_name: '홍길동', callmaner_driver_phone: '050-7111-2222',
  origin_address: '서울 강서구 양천로53길 30', origin_address_detail: '3층',
  destination_address: '경기 성남시 분당구 판교역로 160', destination_address_detail: 'B동 로비',
  reserved_date: '2026-08-20', reserved_time: '14:00',
};
check(
  '배차완료 — 사용자 지정 형식 그대로',
  msg('dispatched', full),
  '요청하신 탁송건이 기사님 배차되었습니다.\n접수번호: OID1234\n일시: 2026-08-20 14:00\n'
  + '서울 강서구 양천로53길 30 3층 → 경기 성남시 분당구 판교역로 160 B동 로비\n'
  + '기사명: 홍길동\n기사전화번호: 050-7111-2222'
);
check(
  '운행시작',
  msg('started', full),
  '요청하신 탁송건이 운행시작 되었습니다.\n접수번호: OID1234\n일시: 2026-08-20 14:00\n'
  + '서울 강서구 양천로53길 30 3층 → 경기 성남시 분당구 판교역로 160 B동 로비'
);
check(
  '운행완료',
  msg('completed', full),
  '요청하신 탁송건이 운행완료 되었습니다.\n접수번호: OID1234\n일시: 2026-08-20 14:00\n'
  + '서울 강서구 양천로53길 30 3층 → 경기 성남시 분당구 판교역로 160 B동 로비'
);
check('오더종류 — 프리미엄대리', msg('started', { ...full, order_type: 'premium' }).split('\n')[0], '요청하신 프리미엄대리건이 운행시작 되었습니다.');
check('오더종류 — 일일기사', msg('started', { ...full, order_type: 'daily_driver' }).split('\n')[0], '요청하신 일일기사건이 운행시작 되었습니다.');
check('오더종류를 모르면 그 자리만 빈다', msg('started', { ...full, order_type: null }).split('\n')[0], '요청하신 건이 운행시작 되었습니다.');
check(
  '배차완료 — 기사 정보가 없으면 그 두 줄을 통째로 뺀다',
  msg('dispatched', { ...full, callmaner_driver_name: null, callmaner_driver_phone: null }),
  '요청하신 탁송건이 기사님 배차되었습니다.\n접수번호: OID1234\n일시: 2026-08-20 14:00\n'
  + '서울 강서구 양천로53길 30 3층 → 경기 성남시 분당구 판교역로 160 B동 로비'
);
// 주소가 비었을 때 화살표만 남은 줄이 고객에게 나가면 안 된다.
check(
  '주소가 둘 다 없으면 화살표 줄이 통째로 사라진다',
  msg('started', { ...full, origin_address: null, origin_address_detail: null, destination_address: null, destination_address_detail: null }),
  '요청하신 탁송건이 운행시작 되었습니다.\n접수번호: OID1234\n일시: 2026-08-20 14:00'
);
check(
  '도착지만 없으면 매달린 화살표를 뗀다',
  msg('started', { ...full, destination_address: null, destination_address_detail: null }).split('\n')[3],
  '서울 강서구 양천로53길 30 3층'
);
check(
  '출발지만 없으면 앞의 화살표를 뗀다',
  msg('started', { ...full, origin_address: null, origin_address_detail: null }).split('\n')[3],
  '경기 성남시 분당구 판교역로 160 B동 로비'
);
check(
  '배차취소 — 다시 배차 중임을 알린다',
  msg('dispatch_cancelled', full),
  '[OID1234] 배차받은 기사님이 취소하였고, 다른 기사님께 배차 진행중입니다.'
);
check(
  '오더취소',
  msg('cancelled', full),
  '[OID1234] 오더가 취소되었습니다. 문의사항은 상담원에게 말씀해주세요.'
);
// 사건이 늘면 설정 화면(지사·법인)에도 자동으로 따라 나와야 한다 — 화면이 별도 목록을 들고
// 있으면 새 사건이 설정에서 빠진 채로 남는다. 개수를 못박아 그 연결이 끊기면 여기서 걸린다.
check('사건 여섯 가지 모두 기본 문구가 있다', Object.keys(DEFAULT_EVENT_SETTINGS).length, 6);
check('영수증 업로드 사건이 있다', !!DEFAULT_EVENT_SETTINGS.receipt_uploaded, true);
// 인수증 사진이 곧 통보의 내용이라 사진 첨부를 기본으로 켠다(다른 사건은 지사가 켜는 선택).
check('영수증 통보는 사진을 함께 보낸다', DEFAULT_EVENT_SETTINGS.receipt_uploaded.attachPhotos, true);
// 지연은 관리자가 화면에서 정하는 값이고 여기 값은 "아무것도 설정 안 했을 때의 출발점"이다.
// 한때 이 값을 2분으로 올리고 마이그레이션으로 저장된 행까지 바꿔, 관리자가 설정한 적 없는
// 값이 조용히 바뀐 적이 있다. 기본값을 함부로 움직이지 않도록 못박아 둔다.
check('배차 통보 기본 지연은 1분', DEFAULT_EVENT_SETTINGS.dispatched.delayMinutes, 1);
check('운행시작·운행완료는 즉시', [DEFAULT_EVENT_SETTINGS.started.delayMinutes, DEFAULT_EVENT_SETTINGS.completed.delayMinutes], [0, 0]);
// 콜마너는 기사가 배차를 취소하면 잠깐 '취소'를 준 뒤 '접수'로 되돌린다(OID1237 실측:
// 18:41:29 취소 → 18:42:30 접수). 그 순간을 잡아 통보하면 멀쩡한 오더를 취소됐다고 알린다.
check('오더취소 통보는 기본으로 꺼져 있다', DEFAULT_EVENT_SETTINGS.cancelled.enabled, false);
check('나머지 사건은 켜져 있다', ['dispatched', 'started', 'completed', 'dispatch_cancelled'].map((k) => DEFAULT_EVENT_SETTINGS[k].enabled), [true, true, true, true]);

console.log('\n[상세주소 합치기]');
// 웹 오더등록은 origin_address에 상세를 이미 합쳐 저장한다(combineAddress) — 그대로 또 붙이면
// "… 30 3층 3층"이 된다.
check('이미 합쳐진 주소는 그대로', mergeAddress('서울 강서구 양천로53길 30 3층', '3층'), '서울 강서구 양천로53길 30 3층');
check('따로 저장된 주소는 합친다', mergeAddress('서울 강서구 양천로53길 30', '3층'), '서울 강서구 양천로53길 30 3층');
check('상세가 없으면 주소만', mergeAddress('서울 강서구', null), '서울 강서구');
check('주소가 없으면 상세만', mergeAddress(null, '3층'), '3층');
check('둘 다 없으면 빈 문자열', mergeAddress(null, null), '');

console.log('\n[주행거리]');
const withOdo = { ...full, odometer_start: 12345, odometer_end: 12470, distance_total: 125 };
check(
  '단위(km)와 천단위 쉼표가 값에 붙는다',
  renderTemplate('출발 {odometer_start} / 도착 {odometer_end} / 총 {distance_total}', withOdo),
  '출발 12,345km / 도착 12,470km / 총 125km'
);
check(
  '값이 없으면 그 줄이 통째로 사라진다',
  renderTemplate('접수번호: {oid}\n최종 운행 거리: {distance_total}', full),
  '접수번호: OID1234'
);
check(
  'context가 오더 컬럼보다 우선한다(방금 인식한 값)',
  renderTemplate('총 {distance_total}', withOdo, { distanceTotal: 200 }),
  '총 200km'
);
check('음수는 값 없음으로 본다', renderTemplate('최종 운행 거리: {distance_total}', { ...full, distance_total: -5 }), '');
check('숫자가 아니어도 값 없음으로 본다', renderTemplate('최종 운행 거리: {distance_total}', { ...full, distance_total: 'abc' }), '');
// 빈 줄을 지우는 규칙은 "라벨: {변수}" 꼴을 본다. 콜론 없이 쓰면 값이 비었을 때 앞의 글자가
// 남는다("총 {distance_total}" → "총") — 설정 화면 안내도 콜론 꼴을 권한다.
check('콜론이 없으면 라벨이 남는다(알려진 한계)', renderTemplate('총 {distance_total}', { ...full, distance_total: null }), '총');

console.log('\n[사진 첨부 스위치]');
check('기본은 꺼짐', buildMessage('started', full).attachPhotos, false);
check('지사 설정으로 켠다', buildMessage('started', full, { ...DEFAULT_EVENT_SETTINGS.started, attachPhotos: true }).attachPhotos, true);
check(
  '문구에 {photos}를 적어도 켠 것으로 본다',
  buildMessage('started', full, { template: '사진입니다 {photos}', attachPhotos: false }).attachPhotos,
  true
);
check(
  '{photos}는 문구에서 지운다(고객에게 그대로 나가면 안 된다)',
  buildMessage('started', full, { template: '사진 {photos}', attachPhotos: false }).text,
  '사진'
);

console.log('\n[변수 목록]');
// 설정 화면 칩과 렌더러가 같은 목록을 써야 한다 — 화면에만 있는 변수는 치환되지 않는다.
check('변수 목록이 비어 있지 않다', TEMPLATE_VARIABLES.length > 0, true);
check(
  '모든 토큰이 실제로 치환된다',
  TEMPLATE_VARIABLES.filter((v) => renderTemplate(v.token, withOdo) === v.token).map((v) => v.token),
  []
);
check(
  '토큰은 모두 ASCII다(한글은 \\w에 안 걸려 치환되지 않는다)',
  TEMPLATE_VARIABLES.filter((v) => !/^\{\w+\}$/.test(v.token)).map((v) => v.token),
  []
);

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
  msg('dispatched', order, { template: '{oid} 기사님이 배정되었어요. {driver_name}' }),
  'OID9 기사님이 배정되었어요. 김철수'
);

console.log('\n[끼어들기 판정]');
// 판정은 "시간"이 아니라 "대화 순서"로 한다(사용자 확정).
//   진행 중 표시 + 마지막 메시지가 봇 → 답을 기다리는 중이다(미룬다)
//   마지막 메시지가 고객            → 봇이 이미 답했거나 처리 중이다(안 미룬다)
// 예전에는 "마지막 고객 발화로부터 10분"이라는 시간 창을 썼는데, 고객이 한마디 하고 창을
// 닫아도 10분간 상태 통보가 막혔다.
const { isSessionBusy, hasPendingMarker } = require('../lib/sessionBusy');
const collecting = { draft_json: '{"phase":"collecting","pendingField":"origin_address"}' };
const mcpWaiting = { mcp_pending_json: '{"mcpTool":"call.create"}' };

check('표시 없음 — 봇이 마지막이어도 안 바쁨', isSessionBusy({}, { lastMessageSender: 'bot' }), false);
check('웹 접수 대기 + 봇이 마지막 → 바쁨', isSessionBusy(collecting, { lastMessageSender: 'bot' }), true);
check('웹 접수 대기 + 고객이 마지막 → 안 바쁨', isSessionBusy(collecting, { lastMessageSender: 'user' }), false);
check('카카오 확인 대기 + 봇이 마지막 → 바쁨', isSessionBusy(mcpWaiting, { lastMessageSender: 'bot' }), true);
// 9시간 전 확인 대기가 남아 있어도, 마지막 말이 고객이면 답을 기다리는 상태가 아니다(OID1237).
check('카카오 확인 대기 + 고객이 마지막 → 안 바쁨', isSessionBusy(mcpWaiting, { lastMessageSender: 'user' }), false);
check('상담원이 마지막 → 안 바쁨', isSessionBusy(collecting, { lastMessageSender: 'agent' }), false);
check('시스템 통보가 마지막 → 안 바쁨', isSessionBusy(collecting, { lastMessageSender: 'system' }), false);
check('아직 아무 말도 없으면 안 바쁨', isSessionBusy(collecting, { lastMessageSender: null }), false);
// 마지막 발신자를 안 넘기는 곳(법인 공유 피드)은 예전처럼 표시만 보고 판단한다.
check('발신자를 안 넘기면 표시만 본다', isSessionBusy(collecting), true);
check('깨진 JSON은 표시 없음으로 본다', isSessionBusy({ draft_json: '{쓰레기' }, { lastMessageSender: 'bot' }), false);
check('세션이 없으면 안 바쁨', isSessionBusy(null, { lastMessageSender: 'bot' }), false);
check('hasPendingMarker — 표시 유무만 본다', [hasPendingMarker(collecting), hasPendingMarker({})], [true, false]);

// 늦으면 안내로서 가치가 사라지는 사건은 대화 중이어도 미루지 않는다(사용자 확정).
check(
  '배차·운행시작은 미루지 않는 사건',
  ['dispatched', 'started'].map((k) => NEVER_DEFER_EVENTS.has(k)),
  [true, true]
);
check(
  '나머지는 미룰 수 있다',
  ['completed', 'dispatch_cancelled', 'cancelled'].map((k) => NEVER_DEFER_EVENTS.has(k)),
  [false, false, false]
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
