// "즉시"로 접수한 건이 오더에 그렇게 남고, 화면에도 그렇게 보이는지 본다.
//
// 왜 필요한가(실사용 지적 2026-09-14): 상담톡으로 "일시 : 07/27 즉시"라고 접수한 건이
// 오더 리스트에 **2026-09-14 13:50 예약**으로 보였다(OID2218). 즉시 요청도
// reserved_date/reserved_time에는 접수 시각이 채워진다 — 그 칸을 비워둘 수 없기 때문이다.
// 그래서 기준을 따로 남기지 않으면 저장된 값만 봐서는 즉시였는지 알 방법이 없다.
//
// 눈에 보이는 것보다 무거운 결과가 있다: 콜마너 오더접수 전문은 reservation_time이 실려
// 있으면 그 시각의 예약으로 잡는다(lib/callmaner.js). 즉시 배차돼야 할 건이 예약으로 걸린다.
//
// 접수 경로가 넷이라(웹 폼 / 카카오 상담톡 / 웹 프리미엄·일일기사 / 문의 전환) 한 곳만
// 고치면 나머지에서 그대로 샌다 — 실제로 웹 폼에만 붙어 있었다(같은 날 웹 건 OID2217은
// immediate로 남았는데 상담톡 건 OID2218은 비어 있었다).
//
// 파일만 읽는다 — DB도 모델도 안 부르므로 CI에서 돌 수 있다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

const orderCreate = read('lib/orderCreate.js');
const kakao = read('lib/kakaoIntakeService.js');
const webPremium = read('lib/webPremiumIntakeService.js');
const ordersRoute = read('routes/orders.js');
const inquiries = read('routes/inquiries.js');
const nextList = read('src/app/orders/OrderListTable.js');
const ejsList = read('views/orders/list.ejs');

console.log('[저장 경로]');
check('orderCreate가 기준을 받는다', /reservationBasis: RESERVATION_BASES\.has/.test(orderCreate));
// 컬럼이 없을 수 있다(마이그레이션 수동) — 저장 실패가 접수를 막으면 안 된다.
//
// **그 UPDATE 블록 안에서** 본다. 이 파일에는 다른 선택 컬럼의 42703 폴백이 여럿 있어서
// 파일 전체에서 낱말만 찾으면, 이 블록의 폴백을 지워도 그대로 통과한다(되돌림 시험에서 샜다).
const basisUpdateIdx = orderCreate.indexOf("UPDATE orders SET reservation_basis");
const basisBlock = basisUpdateIdx >= 0 ? orderCreate.slice(basisUpdateIdx, basisUpdateIdx + 420) : '';
check('예약 기준 저장 블록을 찾았다', basisBlock.length > 100);
check('컬럼이 없으면 조용히 넘어간다', /e\.code === '42703'/.test(basisBlock),
  '마이그레이션 전이면 42703이 나는데, 그게 접수를 막으면 안 된다');
// 저장이 실패해도 접수는 진행돼야 한다 — 던지면 오더가 통째로 안 들어간다.
check('저장 실패가 접수를 막지 않는다', /\.catch\(/.test(basisBlock));

// 접수 경로 넷 중 셋이 값을 넘겨야 한다. 문의 전환은 아래에서 따로 본다.
check('웹 폼이 넘긴다', /reservationBasis: splitPlan\.parts\.length === 1 \? requestedReservationBasis : null,/.test(ordersRoute));
check('카카오 상담톡이 넘긴다', /reservationBasis: reservation\.immediate && !split \? 'immediate' : null,/.test(kakao));
check('웹 프리미엄·일일기사가 넘긴다',
  /reservationBasis: reservation\.immediate && split\.parts\.length === 1 \? 'immediate' : null,/.test(webPremium));

// 문의 전환은 고객이 시각을 말한 적이 없어 "지금"을 기본값으로 넣을 뿐이다 — 즉시 요청이
// 아니므로 기준을 붙이면 안 된다. 붙었다면 누가 잘못 손댄 것이다.
check('문의 전환에는 붙이지 않는다', !/reservationBasis/.test(inquiries),
  '문의 전환의 예약일시는 고객이 말한 값이 아니라 defaultReservedDateTime()의 자리표시자다');

console.log('\n[나뉜 건에는 붙이지 않는다]');
// 구간 릴레이는 각 구간 출발 일시가 앞 구간이 끝나는 시각에 맞춰 따로 정해지므로 전부
// 예약이 맞다. 즉시로 표시하면 그 시각이 콜마너로 안 넘어가 뒷 구간까지 지금 배차 대상이 된다.
check('웹 폼: 나뉘었는지로 가른다', /splitPlan\.parts\.length === 1/.test(ordersRoute));
check('웹 프리미엄: 나뉘었는지로 가른다', /split\.parts\.length === 1/.test(webPremium));
// 카카오는 호출부가 나뉜 경우에만 split을 넘긴다 — 그 전제가 유지돼야 위 조건이 성립한다.
check('카카오: 나뉜 경우에만 split을 넘긴다',
  /split: splitGroupId \? \{ groupId: splitGroupId/.test(kakao));

console.log('\n[콜마너로 나갈 때 가른다]');
check('즉시면 예약시각을 안 싣는다', /order\.reservation_basis === 'immediate'/.test(read('lib/callmaner.js')));

console.log('\n[오더 리스트가 "즉시"로 보여준다]');
for (const [label, src, re] of [
  ['Next', nextList, /o\.reservation_basis === 'immediate' \? '즉시'/],
  ['EJS', ejsList, /o\.reservation_basis === 'immediate'/],
]) {
  check(`${label}: 즉시로 표시한다`, re.test(src));
  // 기준이 null인 오더(컬럼 생기기 전)는 예전 그대로 시각을 보여준다 — 모르는 것을
  // "즉시"로 단정하면 안 된다.
  check(`${label}: 그 외에는 시각을 그대로 보여준다`, /reserved_date.*reserved_time/s.test(src));
  // 칸에 "즉시"만 보이므로 실제 접수 시각은 툴팁에 남아야 한다.
  check(`${label}: 툴팁에 실제 시각을 남긴다`, /즉시 접수 \(/.test(src));
}

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
