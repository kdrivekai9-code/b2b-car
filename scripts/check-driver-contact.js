// 기사 이름·연락처가 주문 조회 결과에 실리는지 확인한다.
//
// "기사님 연락처 좀 알려주세요"는 상담원 발화의 2.8%였고, 그때마다 상담원이 콜마너를 열어
// 확인해줬다. 조회 결과에 함께 실어주면 그 왕복이 사라진다 — 다만 배차 전에는 값이 없는 게
// 정상이라, 빈 값을 실어 보내면 모델이 "연락처가 없습니다"라고 단정한다. 그 구분을 못박는다.
//
// summarizeOrders는 DOM도 네트워크도 쓰지 않는 순수 변환이라 그대로 부를 수 있다.
//
//   node scripts/check-driver-contact.js
// summarizeOrders는 모듈 밖으로 내보내지 않아서(내부 헬퍼) 파일을 읽어 그 함수만 떼어낸다.
// 내보내기를 늘리는 것보다 이쪽이 낫다 — 검증하려고 공개 표면을 넓히면 그게 계약이 된다.
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcpDispatchAgent.js'), 'utf8');

function extract(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name}을 찾지 못했습니다.`);
  const end = SRC.indexOf('\n}', start) + 2;
  return SRC.slice(start, end);
}

// summarizeOrders가 참조하는 바깥 의존은 여기서 주입한다 — 함수 본문만 떼어내 돌리므로
// 같은 파일의 require/다른 함수는 스코프에 없다. joinAddress는 실제 모듈 것을 그대로 쓴다
// (여기서 흉내내면 주소 합치는 규칙이 갈라진다).
const { joinAddress } = require('../lib/intakeSummary');

const sandbox = {
  ORDER_STATE_LABELS: {},
  access: { maskPhone: (v) => String(v || '') },
  formatDateTime: (v) => (v ? String(v) : null),
  evaluateDispatchDelay: () => ({ 지연: false, 사유: '테스트' }),
  // summarizeOrders가 쓰는 헬퍼 — 우리 오더가 매칭되면 기사 배정 여부를 우리 DB 값으로 본다
  // (콜마너 MCP 프록시가 뒤처지는 것이 실측돼서 그렇게 바뀌었다). 실제 모듈 것을 그대로 떼어 쓴다.
  hasOurDriver: new Function(`${extract('hasOurDriver')}; return hasOurDriver;`)(),
};

// eslint-disable-next-line no-new-func
const summarizeOrders = new Function(
  'ORDER_STATE_LABELS', 'access', 'formatDateTime', 'evaluateDispatchDelay', 'joinAddress', 'hasOurDriver',
  `${extract('summarizeOrders')}; return summarizeOrders;`
)(sandbox.ORDER_STATE_LABELS, sandbox.access, sandbox.formatDateTime, sandbox.evaluateDispatchDelay, joinAddress, sandbox.hasOurDriver);

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}`);
  if (!ok) console.log(`         기대: ${JSON.stringify(expected)}\n         실제: ${JSON.stringify(actual)}`);
}

const order = { rcptNo: '179098847', st: 'assigned', driver: { matched: true } };

console.log('[배차된 주문]');
{
  const map = new Map([['179098847', {
    oid: 'OID1132', callmaner_driver_name: '홍길동', callmaner_driver_phone: '010-1111-2222',
  }]]);
  const [row] = summarizeOrders([order], map);
  check('기사명이 실린다', row.기사명, '홍길동');
  check('기사 연락처가 실린다', row.기사연락처, '010-1111-2222');
}

console.log('\n[아직 배차 전]');
{
  const map = new Map([['179098847', { oid: 'OID1132' }]]);
  const [row] = summarizeOrders([{ ...order, driver: { matched: false } }], map);
  // 빈 값을 넣지 않고 필드 자체를 뺀다 — "연락처: null"을 보면 모델이 "없다"고 단정하는데,
  // 실제로는 아직 배차가 안 된 것뿐이라 뜻이 다르다.
  check('기사 필드가 아예 없다', ' 기사명' in row || '기사명' in row, false);
  check('기사배정은 false로 남는다', row.기사배정, false);
}

console.log('\n[이름만 있고 연락처가 아직 없을 때]');
{
  const map = new Map([['179098847', { oid: 'OID1132', callmaner_driver_name: '홍길동' }]]);
  const [row] = summarizeOrders([order], map);
  check('이름은 실린다', row.기사명, '홍길동');
  check('연락처는 null로 구분된다', row.기사연락처, null);
}

console.log('\n[주소는 우리 값을 우선한다]');
{
  // 콜마너 응답 주소는 잘려서 온다("판교역로 160" → "판교역로 16"). 그대로 쓰면 고객에게 틀린
  // 주소를 읽어주고, 그 값으로 재접수를 시도하면 좌표를 못 찾아 실패한다.
  const map = new Map([['179098847', {
    oid: 'OID1132',
    origin_address: '경기 성남시 분당구 판교역로 160',
    destination_address: '서울 동작구 남부순환로 2089',
  }]]);
  const [row] = summarizeOrders([{
    ...order,
    departure: { address: '경기 성남시 분당구 판교역로 16' },
    arrival: { address: '서울 동작구 남부순환로 2089 지' },
  }], map);
  check('출발지는 우리 원본', row.출발지, '경기 성남시 분당구 판교역로 160');
  check('도착지도 우리 원본', row.도착지, '서울 동작구 남부순환로 2089');
}

{
  // 우리 오더가 없으면(콜마너에만 있는 건) 콜마너 값이라도 보여준다 — 없는 것보다 낫다.
  const [row] = summarizeOrders([{ ...order, departure: { address: '경기 성남시 분당구 판교역로 16' } }], new Map());
  check('매칭이 없으면 콜마너 값', row.출발지, '경기 성남시 분당구 판교역로 16');
}

console.log('\n[우리 오더로 매칭되지 않은 콜마너 건]');
{
  const [row] = summarizeOrders([order], new Map());
  check('기사 필드가 없다', '기사명' in row, false);
}

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exitCode = failed ? 1 : 0;