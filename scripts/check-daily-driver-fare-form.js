// 오더 등록 화면에서 **일일기사는 일일기사 요금표로** 계산되는지 본다.
//
// 무엇을 막나 — 실측(2026-09-09)한 것들이다.
//
//   1. 오더구분을 '일일기사'로 골라도 요금은 **탁송 거리 구간표로** 계산됐다.
//      /orders/fare-preview가 그 상품을 몰랐기 때문이다. 일일기사 요금표(시간 기준)가
//      따로 있는데도 그랬다.
//   2. **이용 시간을 받는 칸이 아예 없었다.** 시간이 없으면 이 상품은 금액이 안 나온다.
//      reservation_hours_bracket이 있긴 한데 세 구간뿐이고(within_4h/within_8h/over_8h)
//      프리미엄→일일기사 자동 승격 판정에만 쓴다 — over_8h를 10시간으로 환산해 청구하면
//      12시간을 쓴 고객도 10시간으로 청구된다.
//   3. EJS 챗봇 접수창에는 **order_type 칸 자체가 없어서** 일일기사 대화를 마치고 등록해도
//      서버가 기본값(dispatch)으로 받았다 — 배지에는 "(일일기사 접수)"가 떠 있는데도 그랬다.
//   4. /orders/premium-fare-preview는 법인(group_id)을 안 넘겨 **법인 전용 일일기사 요금표를
//      통째로 무시**했다.
//
// 지키는 것: 상품마다 자기 표를 볼 것, 시간이 없으면 금액을 만들지 말 것, 두 화면(EJS·Next)이
// 같은 값을 보낼 것, 그리고 **왜 그 금액인지** 화면이 밝힐 것.
//
// 파일만 읽는다 — CI에서 돌 수 있다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const code = (p) => read(p).split('\n').filter((l) => !/^\s*(\/\/|--)/.test(l)).join('\n');

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

const orders = code('routes/orders.js');
const create = code('lib/orderCreate.js');
const nextForm = code('src/app/orders/new/OrderForm.js');
const sidePanel = code('src/app/orders/[id]/OrderSidePanel.js');
const ejsJs = code('public/js/order-form.js');
const ejsChat = code('public/js/ai-intake.js');
const formEjs = read('views/orders/form.ejs');
const intakeEjs = read('views/orders/ai_intake.ejs');

console.log('[요금표를 오더구분으로 고른다]');
const preview = orders.slice(orders.indexOf("router.get('/fare-preview'"), orders.indexOf("router.get('/vehicle-type-suggest'"));
// 조건절을 통째로 본다. 낱말만 찾으면 `if (false && req.query.order_type === ...)`처럼
// 무력화해도 통과한다(음성 시험에서 실제로 그랬다).
check('일일기사를 가려낸다',
  /^\s*if \(req\.query\.order_type === 'daily_driver'\) \{$/m.test(preview),
  '조건에 다른 항이 끼면 분기가 조용히 죽는다');
check('시간 기준 표로 계산한다', /calculatePremiumFare\(branchId, hours/.test(preview));
// 법인 → 지사 순서를 지키려면 법인을 넘겨야 한다.
check('법인을 넘긴다', /calculatePremiumFare\(branchId, hours, \{ groupId \}\)/.test(preview));
// **거리 검사보다 앞에 있어야 한다.** 뒤에 두면 경로가 없을 때 계산이 아예 안 된다.
const dailyIdx = preview.indexOf("req.query.order_type === 'daily_driver'");
check('거리 검사보다 먼저 가른다',
  dailyIdx >= 0 && dailyIdx < preview.indexOf('parseFloat(req.query.distance_km)'),
  '일일기사는 거리가 없어도 금액이 나온다');
// 시간이 없으면 금액을 만들지 않는다 — 기본값을 정하면 정한 적 없는 시간으로 청구된다.
check('시간이 없으면 계산을 포기한다', /reason: 'daily_driver_hours_missing'/.test(preview));
check('하루를 넘는 시간을 막는다', /hours > 24/.test(preview));
check('요금표가 없으면 사유를 밝힌다', /reason: 'daily_driver_unset'/.test(preview));
// 화면이 "왜 이 금액인지" 밝히려면 근거가 필요하다.
for (const f of ['baseHours', 'baseHourFare', 'extraPerHour', 'extraHours']) {
  check(`응답에 ${f}가 있다`, new RegExp(`${f}[,:]`).test(preview));
}
// 탁송 표로 흘러내리면 안 된다.
check('일일기사 분기가 return으로 끝난다',
  /order_type === 'daily_driver'\)[\s\S]{0,2200}?return res\.json\(\{\s*enabled: true,\s*orderType: 'daily_driver'/.test(preview),
  'return이 빠지면 아래 탁송 계산이 그대로 이어진다');

console.log('\n[옛 미리보기 경로의 법인 누락]');
const oldPreview = orders.slice(orders.indexOf("router.get('/premium-fare-preview'"), orders.indexOf("router.get('/fare-preview'"));
check('법인을 넘긴다', /\{ groupId \}/.test(oldPreview), '법인 전용 일일기사 요금표가 무시됐다');

console.log('\n[이용 시간을 받고 저장한다]');
check('접수가 시간을 받는다', /daily_driver_hours,/.test(orders));
// 오더구분이 일일기사가 아니면 시간이 남으면 안 된다 — 정산에서 무엇으로 청구했는지 헷갈린다.
check('일일기사가 아니면 시간을 버린다',
  /dailyDriverHours: finalOrderType === 'daily_driver' \? daily_driver_hours : null/.test(orders));
check('저장 값을 정규화한다', /function normalizeDailyDriverHours\(/.test(create));
check('하루를 넘는 값을 막는다', /n > 24/.test(create));
// 마이그레이션 전에도 접수가 막히면 안 된다.
check('컬럼이 없으면 조용히 넘어간다',
  /UPDATE orders SET daily_driver_hours[\s\S]{0,300}42703/.test(create));
check('수정 화면에서도 저장된다', /UPDATE orders SET daily_driver_hours = \? WHERE id = \?/.test(orders));
// 수정 UPDATE 본문에 끼우면 마이그레이션 전 DB에서 오더 수정이 통째로 막힌다.
check('수정 본 UPDATE에 끼우지 않았다',
  !/UPDATE orders SET branch_id[\s\S]{0,1600}daily_driver_hours = \?/.test(orders));
// 마이그레이션이 있어야 저장할 곳이 생긴다.
const migrations = fs.readdirSync(path.join(ROOT, 'supabase/migrations'));
const mig = migrations.find((f) => /daily_driver_hours/.test(f));
check('마이그레이션이 있다', !!mig);
if (mig) {
  const sql = read(`supabase/migrations/${mig}`);
  check('컬럼을 더한다', /add column if not exists daily_driver_hours/.test(sql));
  // 정수로 두면 5시간 30분을 못 받는다(챗봇 요금 문의는 이미 소수를 다룬다).
  check('소수 시간을 받는다', /daily_driver_hours numeric/.test(sql));
  check('기존 컬럼을 건드리지 않는다', !/reservation_hours_bracket[\s\S]{0,40}(drop|alter|rename)/i.test(sql));
}

console.log('\n[두 화면이 시간을 보낸다]');
check('Next 폼에 이용 시간 칸이 있다', /name: 'daily_driver_hours'|daily_driver_hours/.test(nextForm)
  && /이용 시간 \(시간\)/.test(nextForm));
check('Next 수정 화면에도 있다', /daily_driver_hours/.test(sidePanel) && /이용 시간 \(시간\)/.test(sidePanel));
check('EJS 오더등록 폼에 있다', /id="daily_driver_hours"/.test(formEjs));
check('EJS 챗봇 접수창에도 있다', /id="daily_driver_hours"/.test(intakeEjs));
// 요금 조회에 실어 보내야 계산이 된다.
check('Next가 hours를 넘긴다', /params\.set\('hours'/.test(nextForm));
check('EJS가 hours를 넘긴다', /params\.set\('hours'/.test(ejsJs));
// 오더구분을 바꾸면 보는 표가 바뀐다 — 다시 계산하지 않으면 앞 상품 금액이 남는다.
check('Next: 오더구분·시간이 바뀌면 다시 계산한다',
  /state\.order_type, state\.daily_driver_hours/.test(nextForm));
check('EJS: 오더구분이 바뀌면 다시 계산한다',
  /orderTypeSelectEl\.addEventListener\('change'[\s\S]{0,400}updateFarePreview/.test(ejsJs));
check('EJS: 시간이 바뀌면 다시 계산한다',
  /dailyHoursInput\.addEventListener\('input'[\s\S]{0,120}updateFarePreview/.test(ejsJs));
// 일일기사는 경로가 없어도 계산해야 한다.
check('Next: 거리를 기다리지 않는다', /!isDailyDriver && routeInfo\.km == null/.test(nextForm));
check('EJS: 거리를 기다리지 않는다', /totalKm == null && !isDailyDriver/.test(ejsJs));
// 오더구분이 일일기사가 아니면 빈 값으로 보낸다.
check('Next: 다른 상품이면 시간을 비운다',
  /state\.order_type === 'daily_driver' \? String\(state\.daily_driver_hours \|\| ''\)\.trim\(\) : ''/.test(nextForm));

console.log('\n[챗봇 접수창이 오더구분을 보낸다]');
// 이 칸이 없어서 일일기사 대화가 전부 탁송으로 등록됐다.
check('order_type 칸이 있다', /name="order_type"/.test(intakeEjs));
check('이용 형태 칸이 있다', /name="trip_type"/.test(intakeEjs));
check('대화가 정한 값을 폼에 맞춘다', /getElementById\('order_type'\)/.test(ejsChat));
// 등록 직전 한 곳에서 확정한다 — 대화 도중 바뀌는 지점마다 끼워 넣으면 새 분기에서 빠진다.
check('등록 직전에 확정한다',
  /function submitOrderForm\(\)[\s\S]{0,900}orderTypeSelect\.value = orderCategory/.test(ejsChat));
check('일일기사가 아니면 이용 형태를 비운다',
  /tripTypeSelect\.value = \(orderCategory === 'daily_driver' && tripType\) \? tripType : ''/.test(ejsChat));

console.log('\n[왜 그 금액인지 밝힌다]');
// 기준 시간보다 짧게 써도 기준요금이 그대로다 — 설명이 없으면 과청구로 보인다.
for (const [label, src] of [['Next', nextForm], ['EJS', ejsJs]]) {
  check(`${label}: 일일기사 근거를 보여준다`, /기준 시간 미만도 기준요금/.test(src));
  check(`${label}: 초과 시간을 보여준다`, /초과 /.test(src) && /extraHours/.test(src));
  check(`${label}: 시간이 없으면 무엇이 필요한지 말한다`, /이용 시간을 입력하면 자동 계산/.test(src));
  check(`${label}: 요금표 미등록을 따로 말한다`, /daily_driver_unset/.test(src));
}
// 챗봇 요금 문의와 같은 표를 봐야 답이 갈리지 않는다.
check('챗봇 요금 문의도 같은 함수를 쓴다', /calculatePremiumFare\(/.test(code('lib/agentAssist.js')));

console.log('\n[상세에서 근거를 볼 수 있다]');
check('오더 상세가 이용 시간을 보여준다', /daily_driver_hours != null/.test(read('views/orders/detail.ejs')));

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
