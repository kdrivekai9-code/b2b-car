// 적요1 100Byte 예산과 기사 챗봇 전달사항 검사.
//
// 왜 검사로 고정하나: 이 칸에 쓴 글이 그대로 기사에게 가는 줄 알지만, 콜마너 적요1이
// 100Byte라 그 뒤가 **말없이 잘린다**(실측: 기사 메모의 24.4%가 예산 초과). 쓰는 사람은 다
// 갔다고 믿고, 기사는 안 온 줄도 모른다. 화면이 세는 규칙과 실제로 자르는 규칙이 갈리면
// "여기서는 들어간다는데 실제로는 잘리는" 상태가 된다 — 지금보다 나쁘다.
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const memoBudget = require('../lib/memoBudget');
const intakeMemoSplit = require('../lib/intakeMemoSplit');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

console.log('[예산 계산이 실제 자르는 규칙과 같은가]');
// 요약을 만들 때 쓰는 쪽(intakeMemoSplit)과 화면에 보여줄 때 쓰는 쪽(memoBudget)이
// 같은 값을 내야 한다. 갈리면 화면과 실제가 어긋난다.
['12가3456', '123가4567', '', null].forEach((plate) => {
  check(`번호판 ${JSON.stringify(plate)} 예산이 같다`,
    memoBudget.budgetFor(plate) === intakeMemoSplit.briefBudgetBytes(plate),
    `${memoBudget.budgetFor(plate)} vs ${intakeMemoSplit.briefBudgetBytes(plate)}`);
});
check('적요1 상한이 100Byte', memoBudget.MEMO1_MAX_BYTES === 100);
// 번호판이 맨 앞에 붙는다 — 기사가 어느 차인지부터 알아야 해서 그 자리는 양보할 수 없다.
check('번호판이 길수록 예산이 준다',
  memoBudget.budgetFor('12가3456') > memoBudget.budgetFor('서울12가3456'));

console.log('\n[자르는 자리]');
const d = memoBudget.describe('가나다라마바사아자차카타파하'.repeat(10), '12가3456');
check('예산을 넘으면 잘린다', d.over === true);
check('남는 부분이 예산 이내', memoBudget.byteLength(d.kept) <= d.budget,
  `${memoBudget.byteLength(d.kept)} > ${d.budget}`);
// 바이트로 자르면 한글 한 글자가 반토막 나서 깨진 글자가 보인다.
check('글자 단위로 자른다', !/�/.test(d.kept) && d.kept.length > 0);
check('kept + dropped가 원문', d.kept + d.dropped === '가나다라마바사아자차카타파하'.repeat(10));
const fit = memoBudget.describe('짧은 메모', '12가3456');
check('짧으면 안 잘린다', fit.over === false && fit.dropped === '');
check('빈 값도 안전', memoBudget.describe('', null).over === false);

console.log('\n[화면 두 벌이 같은 규칙을 쓰는가]');
// Next 폼은 lib/memoBudget을 그대로 import한다. EJS는 브라우저 JS라 상수를 복제하는데,
// 그 값이 갈리면 화면마다 다른 숫자를 보여준다.
const sharedJs = read('public/js/order-form.js');
check('공유 JS 상한이 100', /MEMO1_MAX_BYTES = 100/.test(sharedJs));
check('공유 JS 구분자가 3', /SEPARATOR_BYTES = 3/.test(sharedJs));
check('공유 JS 가정 번호판이 11', /ASSUMED_PLATE_BYTES = 11/.test(sharedJs));
check('상수가 lib과 일치',
  memoBudget.SEPARATOR_BYTES === 3 && memoBudget.ASSUMED_PLATE_BYTES === 11);
const nextForm = read('src/app/orders/new/OrderForm.js');
check('Next 폼은 lib을 그대로 쓴다', /memoBudgetLib\.describe/.test(nextForm),
  '복제하면 갈린다');

console.log('\n[라벨과 안내]');
// "메모(기사전달사항)"이면 길이 제한이 있다는 걸 알 수 없다.
const forms = ['views/orders/form.ejs', 'views/orders/ai_intake.ejs', 'src/app/orders/new/OrderForm.js'];
forms.forEach((f) => {
  const src = read(f);
  check(`${f} — 콜마너 라벨`, /메모\(콜마너 기사전달사항\)/.test(src));
  check(`${f} — 100Byte 안내가 있다`, /100Byte/.test(src));
  check(`${f} — 기사 챗봇 전달사항 칸이 있다`, /memo_driver_chat/.test(src));
});

console.log('\n[고객 화면은 한 칸이다]');
// 100Byte니 적요1이니 하는 것은 우리 사정이지 고객이 알아야 할 일이 아니다. 칸을 나눠 놓으면
// 어디에 무엇을 써야 할지 고민하게 되고, 그 고민의 답을 우리가 더 잘 안다.
const orderForm = read('src/app/orders/new/OrderForm.js');
check('고객이면 한 칸으로 그린다', /isClient \? \(/.test(orderForm) && /<label>요청사항<\/label>/.test(orderForm));
check('고객 칸에는 100Byte 안내가 없다',
  !/요청사항<\/label>[\s\S]{0,400}100Byte/.test(orderForm),
  '고객에게 우리 내부 제약을 설명할 이유가 없다');
// 화면에 없는 칸이 값을 실어 보내면 서버가 나눠 넣은 결과를 덮어쓴다.
check('고객은 업체전달사항을 안 보낸다', /if \(!isClient\) params\.set\('memo_billing'/.test(orderForm));
check('고객은 챗봇 전달사항을 안 보낸다', /if \(!isClient\) params\.set\('memo_driver_chat'/.test(orderForm));

console.log('\n[서버가 나눈다]');
const routesSrc = read('routes/orders.js');
check('접수에서 나눈다', /u\.role === 'client'[\s\S]{0,120}splitClientMemo/.test(routesSrc));
check('수정에서도 다시 나눈다', /asClient[\s\S]{0,200}splitClientMemo\(req\.params\.id/.test(routesSrc));
// 카카오 접수가 이미 쓰는 분류를 그대로 쓴다 — 채널마다 다시 만들 이유가 없다.
check('검증된 분류를 재사용한다', /splitIntakeMemo/.test(routesSrc));
// 분류가 실패하면 원문이 그대로 남아야 한다. 섣불리 비우면 기사가 아무것도 못 받는다.
check('분류 실패 시 아무것도 안 바꾼다',
  /if \(!split \|\| !String\(split\.driver \|\| ''\)\.trim\(\)\) return;/.test(routesSrc));
// 고객이 수정할 때 안 보낸 칸이 null로 덮이면 관리자가 적어둔 내용이 통째로 사라진다.
check('고객 수정이 관리자 칸을 덮지 않는다',
  /role === 'client' \? order\.memo_billing/.test(routesSrc)
  && /role === 'client' \? order\.memo_driver_chat/.test(routesSrc));

console.log('\n[고객 상세에는 안 보인다]');
const detail = read('views/orders/detail.ejs');
check('업체요청사항·챗봇 전달사항을 관리자에게만',
  /currentUser\.role !== 'client'[\s\S]{0,300}기사 챗봇 전달사항/.test(detail));

console.log('\n[저장과 전달]');
const routes = read('routes/orders.js');
check('접수에서 저장한다', /UPDATE orders SET memo_driver_chat = \?/.test(routes));
check('수정에서 저장한다', /memo_customer = \?, memo_billing = \?, memo_driver_chat = \?/.test(routes));
const driver = read('routes/driverChat.js');
check('기사 화면에 내려준다', /driverMemo: current\.memo_driver_chat/.test(driver));
// 없는 칸 하나 때문에 기사 화면이 통째로 죽으면 안 된다 — 기사는 다른 길이 없다.
check('마이그레이션 전에도 화면이 산다', /e\.code === '42703'/.test(driver));

console.log('\n[기사 화면 상단]');
const view = read('views/driver/chat.ejs');
check('발주 지사를 보여준다', /branchName/.test(view) && /id="branch"/.test(view));
check('전화 버튼이 tel: 로 건다', /'tel:' \+ String\(d\.current\.branchPhone\)/.test(view));
// 눌러도 아무 일 없는 버튼이 있는 것이 없는 것보다 나쁘다.
check('번호가 없으면 버튼을 감춘다', /call\.hidden = true/.test(view));
// 하이픈이 섞이면 일부 기기에서 제대로 안 걸린다.
check('번호에서 기호를 뺀다', /replace\(\/\[\^0-9\+\]\/g, ''\)/.test(view));
// 기사가 콜마너 화면에서 찾는 번호는 콜마너 것이다.
check('접수번호를 함께 보여준다', /confSlip \? ' \/ ' \+ d\.current\.confSlip/.test(view));
check('탭에도 함께', /o\.confSlip \? ' \/ '/.test(view));
check('담당자 안내를 그린다', /담당자 안내/.test(view));

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
