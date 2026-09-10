// 콜마너가 발급하는 고객용 위치조회 링크를 우리가 흘려보내지 않는지.
//
// 왜 필요한가: 콜마너는 고객에게 이런 주소로 위치를 보여준다고 한다(사용자 확인 2026-09-10).
//   https://www.cd1.kr/cust-web/reception/?supplierId=S-12345&callToken=<44자 토큰>
// supplierId는 우리 providerId(B100-12345-AP12345)에서 만들 수 있지만 callToken은 불투명해
// 유추할 수 없다 — 콜마너가 오더별로 줘야 한다.
//
// 받을 자리는 응답에 이미 둘 있었다: OrderReceipt 응답의 `web_url`과 OrderHistory 각 행의
// `receipt_url`. 그런데 `web_url`은 **읽고서 아무도 쓰지 않아 버려지고 있었고**(lib/callmaner.js가
// webUrl로 돌려주는데 호출부가 무시), `receipt_url`은 아예 파싱하지 않았다.
//
// `web_url`은 **실제로 온다**(2026-09-10 시험 접수로 확인):
//   [콜마너 접수] 응답 필드: reg_cslip, reg_date, web_url
//   https://www.cd1.kr/cust-web/callDetail?supplierId=S-12345&callToken=…&callSource=U
// 즉 링크는 처음부터 오고 있었고 우리가 저장하지 않아 버렸다. 그 시절에 등록된 오더는
// 링크가 없어서, 수정(OrderModify) 응답에서도 받도록 해뒀다 — 그게 소급의 유일한 기회다.
// `receipt_url`(OrderHistory)은 아직 31건 전부 빈 문자열이다(문의서 6번).
require('dotenv').config();
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, ok, got) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : (got ? ` — ${got}` : '')}`);
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

console.log('[두 통로를 모두 읽는다]');
const cm = read('lib/callmaner.js');
check('접수 응답의 web_url을 읽는다', /webUrl: rs\.web_url/.test(cm));
check('이력의 receipt_url을 읽는다', /receiptUrl: String\(o\.receipt_url/.test(cm));

console.log('\n[읽었으면 저장한다 — 이게 빠져 있었다]');
const reg = read('lib/callmanerRegister.js');
check('접수 직후 저장한다', /saveCallmanerWebUrl\(orderId, result\.webUrl\)/.test(reg));
check('저장 함수를 내보낸다', /saveCallmanerWebUrl \}/.test(reg) || /saveCallmanerWebUrl,/.test(reg));
// 칸이 없는 DB(마이그레이션 전)에서 접수가 실패하면 안 된다 — 링크는 부가정보다.
check('42703을 삼킨다', /e\.code !== '42703'/.test(reg));
// 처음 오는 날 눈에 띄어야 한다.
check('처음 받으면 로그를 남긴다', /고객용 위치조회 링크 수신/.test(reg));

const sync = read('routes/callmanerSync.js');
check('이력에서 온 링크도 저장한다', /info\.receiptUrl && info\.receiptUrl !== order\.callmaner_web_url/.test(sync));

console.log('\n[수정 응답에서도 받는다 — 기존 오더의 유일한 기회]');
const cm2 = read('lib/callmaner.js');
check('수정 응답의 web_url을 돌려준다', /OrderModify[\s\S]{0,600}webUrl: rs\.web_url/.test(cm2));
check('수정 응답 필드를 로그로 남긴다', /\[콜마너 수정\] 응답 필드/.test(cm2));
check('접수 응답 필드도 로그로 남긴다', /\[콜마너 접수\] 응답 필드/.test(cm2));
check('수정 라우트가 저장한다', /modified && modified\.webUrl[\s\S]{0,200}saveCallmanerWebUrl\(order\.id/.test(read('routes/orders.js')));

console.log('\n[칸과 화면]');
const mig = 'supabase/migrations/20260910010000_add_callmaner_web_url.sql';
check('마이그레이션이 있다', fs.existsSync(path.join(__dirname, '..', mig)));
check('IF NOT EXISTS로 더한다', /ADD COLUMN IF NOT EXISTS callmaner_web_url/.test(read(mig)));
// 저장만 하고 안 보여주면 없는 것과 같다. EJS·Next 두 벌 모두.
for (const [label, file] of [
  ['오더상세 EJS', 'views/orders/detail.ejs'],
  ['오더상세 Next', 'src/app/orders/[id]/DriverLocationMap.js'],
]) {
  check(`링크가 있으면 연다(${label})`, /콜마너 위치조회 열기/.test(read(file)));
}
check('Next 화면에 값을 넘긴다', /webUrl=\{data\.order\.callmaner_web_url/.test(read('src/app/orders/[id]/page.js')));

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
