// 예약 건에 기사가 배정됐을 때 상태가 '기사배정'으로 바뀌는지 확인한다.
//
// 실사용(OID1455): 콜마너에서 기사가 배정됐는데 우리 상태는 계속 '예약'이었다.
// 콜마너 단건조회가 그때 준 값:
//
//   status: "예약"           ← 기사가 배정돼도 상태명은 그대로 "예약"
//   baechaStatus: "3"
//   wkInfo: "T11111*채정식"   ← 기사는 배정돼 있다
//
// 우리 코드는 status 문자열만 보고 매핑했고, baecha_status는 이미 '배차'로 매핑된 뒤에만
// 들여다봤다. 그래서 예약 건은 배차를 영영 못 알아챘다. 결과로 세 가지가 함께 막혔다:
// 상태가 안 바뀌고, 상태 전이가 없으니 배차완료 통보도 안 나가고(실측 0건), 기사 연락처
// 조회도 "상태가 배차일 때"만 돌아서 번호가 null로 남았다(이름만 저장됨).
//
// baecha_status를 배차 판정에 쓰지 않는 이유: 정의서에 정의된 값이 0(배차상태아님)/1(기사도착)/
// 2(운행시작)뿐인데 실서버가 문서에 없는 3을 준다. 뜻을 모르는 값으로 운행 단계를 정하면
// "기사도착"과 헷갈릴 수 있어, 확실한 신호(wk_info)만 쓴다.
//
// 순수 판정이라 네트워크도 DB도 쓰지 않는다.
//
//   node scripts/check-callmaner-reserved-dispatch.js
const sync = require('../routes/callmanerSync');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

const r = sync.resolveLocalStatus;
const DRIVER = 'T11111*채정식';

console.log('[예약 건에 기사가 붙은 경우 — 실사용 OID1455 그대로]');
check('기사배정으로 본다', r({ status: '예약', wkInfo: DRIVER, baechaStatus: '3' }), '기사배정');
check('기사가 없으면 예약 그대로', r({ status: '예약', wkInfo: '', baechaStatus: '' }), '예약');

console.log('\n[다른 배차 이전 상태도 같다]');
check('접수 + 기사 → 기사배정', r({ status: '접수', wkInfo: DRIVER }), '기사배정');
check('대기 + 기사 → 기사배정', r({ status: '대기', wkInfo: DRIVER }), '기사배정');
check('접수 + 기사 없음 → 접수', r({ status: '접수', wkInfo: '' }), '접수');

console.log('\n[종료된 건은 되돌리지 않는다]');
// 완료/취소를 기사배정으로 되돌리면 통보까지 다시 나간다.
check('완료는 그대로', r({ status: '완료', wkInfo: DRIVER }), '완료');
check('취소는 그대로', r({ status: '취소', wkInfo: DRIVER }), '취소');
check('문의는 그대로', r({ status: '문의', wkInfo: DRIVER }), '문의');

console.log('\n[운행시작 판정은 예전 그대로]');
// 콜마너는 운행 중에도 status='배차'를 주고, 출발 여부는 baecha_status=2로만 구분된다.
check('배차 + 운행시작(2)', r({ status: '배차', wkInfo: DRIVER, baechaStatus: '2' }), '운행시작');
check('배차 + 기사도착(1)', r({ status: '배차', wkInfo: DRIVER, baechaStatus: '1' }), '기사배정');
check('배차 + 값 없음', r({ status: '배차', wkInfo: DRIVER }), '기사배정');
// 예약에서 올라온 건도 같은 규칙을 탄다 — 문서에 없는 3은 운행시작으로 보지 않는다.
check('예약 + 기사 + 3은 운행시작이 아니다', r({ status: '예약', wkInfo: DRIVER, baechaStatus: '3' }), '기사배정');
check('예약 + 기사 + 2면 운행시작', r({ status: '예약', wkInfo: DRIVER, baechaStatus: '2' }), '운행시작');

console.log('\n[알 수 없는 상태는 매핑하지 않는다]');
check('빈 상태', r({ status: '', wkInfo: DRIVER }), undefined);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
