// 접수 경로마다 같은 자동 판정이 도는지 검사한다.
//
// 왜 필요한가(2026-09-04 실측): 요청사항에서 부대비용을 찾는 판정이 웹 접수 폼(routes/orders.js)
// 에만 걸려 있었다. 그래서 **자유 문장이 가장 많이 들어오는 챗봇·상담톡 접수가 통째로 빠져
// 있었다** — "주유 3만원"이라고 써도 아무 후보도 안 생겼다.
//
// 접수 경로는 넷이다. 판정을 경로마다 두면 새 경로가 생길 때마다 빠지고, 빠져도 화면에는
// 아무 오류가 안 뜬다. 그래서 판정은 전부 lib/orderCreate.js 한 곳에 둔다 —
// 우편발송(등기) 판정이 이미 그 방식이고, 그쪽은 처음부터 네 경로 모두에서 돌고 있었다.
require('dotenv').config();

const fs = require('fs');
const path = require('path');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const create = read('lib/orderCreate.js');

// 이 넷이 오더를 만드는 전부다. 새 경로가 생기면 여기 한 줄을 더한다.
const INTAKE_PATHS = [
  ['웹 접수 폼', 'routes/orders.js'],
  ['카카오 상담톡 · 웹 챗봇', 'lib/kakaoIntakeService.js'],
  ['웹 프리미엄 · 일일기사', 'lib/webPremiumIntakeService.js'],
  ['문의 전환', 'routes/inquiries.js'],
];

console.log('[모든 접수 경로가 한 함수를 지난다]');
INTAKE_PATHS.forEach(([label, file]) => {
  check(`${label} — createOrder를 쓴다`, /createOrder\(\{/.test(read(file)));
  // memoCustomer를 안 넘기면 그 경로만 판정 대상이 아니게 된다.
  check(`${label} — 요청사항을 넘긴다`, /memoCustomer:/.test(read(file)));
});

console.log('\n[판정은 오더 생성 한 곳에서]');
check('부대비용 판정이 orderCreate에 있다', /memoExtraCosts'\)\.analyzeAndStore/.test(create));
check('우편발송 판정도 같은 곳에', /isPostalRequested\(postalSource\)/.test(create));
// 경로마다 두면 한쪽만 고쳐진다 — 실제로 그랬다.
// 접수 경로에는 없어야 한다 — 있으면 웹 폼 접수만 두 번 분석한다(orderCreate에서 한 번,
// 여기서 또 한 번). 다만 관리자가 누르는 "다시 분석" 버튼은 여기 있는 게 맞다.
const ordersSrc = read('routes/orders.js');
const analyzeHits = (ordersSrc.match(/analyzeAndStore/g) || []).length;
check('접수 경로에서는 부르지 않는다', analyzeHits === 1,
  `routes/orders.js에 ${analyzeHits}번 — 재분석 버튼 하나만 있어야 한다`);
// 문자 수로 재면 라우트가 길어질 때마다 깨진다. 라우트 범위를 잘라서 본다.
const reanalyzeStart = ordersSrc.indexOf("router.post('/:id/reanalyze-memo'");
const reanalyzeEnd = ordersSrc.indexOf("router.post('", reanalyzeStart + 10);
const reanalyzeBody = reanalyzeStart >= 0
  ? ordersSrc.slice(reanalyzeStart, reanalyzeEnd > 0 ? reanalyzeEnd : undefined)
  : '';
check('그 한 번이 재분석 라우트 안이다', /analyzeAndStore/.test(reanalyzeBody),
  '접수 경로에 있으면 웹 폼 접수만 두 번 분석된다');

console.log('\n[접수를 붙잡지 않는다]');
// 모델 호출이라 실측 1.2~5.3초다. 접수 응답이 그만큼 늦으면 고객은 접수가 안 된 줄 안다.
check('응답 뒤로 미룬다', /runAfterResponse\(\s*\n?\s*require\('\.\/memoExtraCosts'\)/.test(create)
  || /runAfterResponse\([\s\S]{0,80}analyzeAndStore/.test(create));
// Vercel은 응답 뒤 인스턴스를 얼린다 — 그냥 두면 조용히 유실된다.
const after = read('lib/afterResponse.js');
check('waitUntil로 살려둔다', /vercelWaitUntil\(guarded\)/.test(after));
check('실패를 삼킨다', /\.catch\(\(e\) => console\.error/.test(after),
  '응답은 이미 나갔고, 처리되지 않은 거부는 프로세스를 죽인다');

console.log('\n[중복 청구를 막는다]');
// 화면에서 이미 고른 항목이 후보로 또 올라오면 같은 돈이 두 줄이 된다.
check('이미 고른 항목을 넘긴다', /intakeChargeTypes/.test(read('routes/orders.js')));
check('그 목록을 분석이 쓴다', /existingChargeTypes: \(input\.intakeChargeTypes \|\| \[\]\)/.test(create));

(async () => {
  console.log('\n[실제 판정]');
  const memoExtra = require('../lib/memoExtraCosts');
  const { isPostalRequested } = require('../lib/postalReceipt');
  const text = '주유 3만원 넣어주시고 인수증은 등기우편으로 보내주세요';
  const rows = await memoExtra.detectFromMemo(text, null).catch(() => []);
  const fuel = rows.find((r) => r.code === 'fuel');
  check('"주유 3만원"을 잡는다', !!fuel, JSON.stringify(rows.map((r) => r.label)));
  // 고객이 정한 금액이라 그대로 쓴다 — 영수증이 다르면 상담원에게 넘어간다(lib/receiptOcr.js).
  check('금액 3만원을 그대로 읽는다', !!fuel && fuel.amount === 30000, fuel && String(fuel.amount));
  check('"인수증 등기우편"을 잡는다', isPostalRequested(text) === true);

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})();
