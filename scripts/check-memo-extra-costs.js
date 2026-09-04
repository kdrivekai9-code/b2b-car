// 요청사항에서 부대비용을 찾아내는 규칙 검사.
//
// 왜 검사로 고정하나: 법인 고객에게는 접수 화면의 부대비용 입력이 보이지 않아, 요청사항 본문이
// 유일한 통로다. 그 본문을 읽는 규칙이 어긋나면 두 가지가 조용히 새어 나간다 —
// 기사에게 지시가 안 닿고(차가 빈 채로 도착한다), 실비를 썼어도 청구할 줄이 없다.
// 둘 다 화면에 오류로 드러나지 않는다.
//
// LLM 자체는 여기서 부르지 않는다(느리고 흔들린다). 모델이 뭐라 답하든 **그 뒤의 판정**이
// 규칙대로인지를 본다 — 요금설정에 따른 정산구분, 이미 선택된 항목 제외, 중복 제거.
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const memoExtra = require('../lib/memoExtraCosts');
const fareSurcharge = require('../lib/fareSurcharge');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

// 모델을 흉내 내는 가짜 — 무엇을 돌려주든 그 뒤 판정만 본다.
const fake = (items) => async () => ({ items });

(async () => {
  console.log('[찾을 항목]');
  // 도선료·통행료는 뺀다. 기사가 쓰는 돈이 아니라 경로에서 자동으로 정해지는 값이라,
  // 요청사항에서 읽어봐야 이미 계산된 값과 부딪히기만 한다.
  check('주유·충전·세차·주차만 본다',
    JSON.stringify(memoExtra.DETECTABLE_CODES) === JSON.stringify(['fuel', 'charge', 'wash', 'parking']),
    memoExtra.DETECTABLE_CODES.join(','));
  check('도선료는 대상이 아니다', !memoExtra.DETECTABLE_CODES.includes('ferry'));
  check('통행료도 대상이 아니다', !memoExtra.DETECTABLE_CODES.includes('toll_normal'));
  // 요금설정이 아는 항목이어야 붙일 자리가 있다.
  const known = new Set(fareSurcharge.EXTRA_COST_ITEMS.map((it) => it.code));
  check('전부 요금설정에 있는 항목', memoExtra.DETECTABLE_CODES.every((c) => known.has(c)));

  console.log('\n[요금설정이 정산구분을 정한다]');
  let r = await memoExtra.detectFromMemo('주유 가득', { fuel_mode: 'monthly' }, { generate: fake([{ code: 'fuel', evidence: '주유 가득' }]) });
  check('제외(월정산) → 청구 대상', r.length === 1 && r[0].billable && r[0].settleMode === 'monthly');
  r = await memoExtra.detectFromMemo('주유 가득', { fuel_mode: 'individual' }, { generate: fake([{ code: 'fuel', evidence: '주유 가득' }]) });
  check('제외(개별정산) → 청구 대상', r.length === 1 && r[0].billable && r[0].settleMode === 'individual');
  // 포함 항목도 후보로는 남는다 — 청구는 안 하지만 기사에게는 알려야 한다.
  // 지시가 안 닿으면 차가 빈 채로 간다. 청구 여부와 전달 여부는 별개다.
  r = await memoExtra.detectFromMemo('주유 가득', { fuel_mode: 'included' }, { generate: fake([{ code: 'fuel', evidence: '주유 가득' }]) });
  check('포함 → 후보로는 남는다', r.length === 1, '기사 전달용');
  check('포함 → 청구 대상은 아니다', r.length === 1 && r[0].billable === false);

  console.log('\n[중복 방지]');
  // 같은 돈이 두 줄이면 두 번 청구된다.
  r = await memoExtra.detectFromMemo('주유 가득', null, {
    generate: fake([{ code: 'fuel', evidence: '주유' }]),
    existingChargeTypes: ['주유비'],
  });
  check('이미 선택된 항목은 후보가 아니다', r.length === 0);
  r = await memoExtra.detectFromMemo('주유', null, {
    generate: fake([{ code: 'fuel', evidence: 'a' }, { code: 'fuel', evidence: 'b' }]),
  });
  check('같은 항목이 두 번 나오면 한 번만', r.length === 1);

  console.log('\n[모델이 이상한 값을 줘도 버틴다]');
  r = await memoExtra.detectFromMemo('x', null, { generate: fake([{ code: 'ferry', evidence: 'a' }]) });
  check('대상 밖 코드는 버린다', r.length === 0);
  r = await memoExtra.detectFromMemo('x', null, { generate: fake([{ code: 'fuel', evidence: 'a', amount: -500 }]) });
  check('음수 금액은 0으로', r.length === 1 && r[0].amount === 0);
  r = await memoExtra.detectFromMemo('x', null, { generate: async () => { throw new Error('타임아웃'); } });
  check('모델이 죽어도 던지지 않는다', Array.isArray(r) && r.length === 0, '접수를 막으면 안 된다');
  r = await memoExtra.detectFromMemo('', null, { generate: fake([{ code: 'fuel', evidence: 'a' }]) });
  check('요청사항이 비면 모델을 부르지 않는다', r.length === 0);

  console.log('\n[안내 문구]');
  const billable = { label: '주유비', amount: 50000, billable: true, settleMode: 'monthly' };
  check('청구 건은 영수증을 요구한다', memoExtra.describe(billable).includes('영수증'));
  check('금액을 천단위로', memoExtra.describe(billable).includes('50,000원'));
  check('포함 건은 영수증을 요구하지 않는다',
    !memoExtra.describe({ label: '주유비', billable: false }).includes('영수증'));

  console.log('\n[판단이 끝난 후보는 화면에서 사라진다]');
  // 안 그러면 다음 사람이 같은 판단을 또 한다. 기록은 남기고 배너에서만 빠진다.
  const order = { memo_extra_json: JSON.stringify([
    { code: 'fuel', decision: 'accepted' }, { code: 'wash' },
  ]) };
  check('저장된 것은 전부 읽힌다', memoExtra.loadFromOrder(order).length === 2);
  check('판단 안 한 것만 배너에', memoExtra.pendingFromOrder(order).length === 1);
  check('깨진 JSON도 화면을 죽이지 않는다',
    memoExtra.loadFromOrder({ memo_extra_json: '{{{' }).length === 0);

  console.log('\n[접수 때 금액을 정할 수 있는 항목]');
  // 사용자 확정 2026-09-02: 주유비만 금액을 정한다. "3만원어치 주유"는 고객이 정한
  // 확정금액이지만, 충전·세차·주차는 얼마가 될지 기사가 쓰고 영수증을 올려야 정해진다.
  // 칸이 열려 있으면 누군가 어림값을 넣고, 그 어림값이 영수증 없이 그대로 청구된다.
  const extraCharges = require('../lib/extraCharges');
  const itemOf = (t) => extraCharges.intakeItem(t);
  check('주유비는 금액을 정할 수 있다', !!itemOf('주유비').fixedAmount);
  check('충전비는 못 정한다', !itemOf('충전비').fixedAmount);
  check('세차비는 못 정한다', !itemOf('세차비').fixedAmount);
  check('주차요금은 못 정한다', !itemOf('주차요금').fixedAmount);
  // 충전은 가득만이다 — 부분 충전을 금액으로 지정하지 않는다.
  check('충전비 선택지는 가득 하나',
    itemOf('충전비').options.length === 1 && itemOf('충전비').options[0].value === 'full',
    itemOf('충전비').options.map((o) => o.value).join('/'));
  check('주유비는 가득·금액지정 둘',
    itemOf('주유비').options.map((o) => o.value).join('/') === 'full/amount');

  // 서버가 화면을 우회한 금액을 눌러야 실효가 있다.
  const sent = (type, option, amount) => extraCharges.parseIntakeRows({
    intake_extra_type: [type], intake_extra_option: [option],
    intake_extra_amount: [String(amount)], intake_extra_mode: [''], intake_extra_id: [''],
  }, null, '2026-09-02').rows[0];
  check('주유 금액지정 → 금액이 남는다', sent('주유비', 'amount', 30000).amount === 30000);
  check('주유 가득 → 금액을 버린다', sent('주유비', 'full', 50000).amount === 0,
    '가득은 접수 때 금액을 모른다');
  check('충전 → 금액을 버린다', sent('충전비', 'full', 40000).amount === 0);
  check('세차 → 금액을 버린다', sent('세차비', 'hand_wash', 20000).amount === 0);
  check('주차 → 금액을 버린다', sent('주차요금', '', 3000).amount === 0);

  console.log('\n[요청사항 분석도 같은 규칙]');
  let a = await memoExtra.detectFromMemo('3만원 주유', null, {
    generate: fake([{ code: 'fuel', evidence: '3만원 주유', amount: 30000 }]),
  });
  check('주유 금액은 살린다', a.length === 1 && a[0].amount === 30000);
  a = await memoExtra.detectFromMemo('주차비 3천원', null, {
    generate: fake([{ code: 'parking', evidence: '주차비 3천원', amount: 3000 }]),
  });
  check('주차 금액은 버린다', a.length === 1 && a[0].amount === 0, '영수증으로 정해진다');
  a = await memoExtra.detectFromMemo('세차 2만원', null, {
    generate: fake([{ code: 'wash', evidence: '세차 2만원', amount: 20000 }]),
  });
  check('세차 금액도 버린다', a.length === 1 && a[0].amount === 0);

  console.log('\n[고객에게 열어준 범위]');
  // 사용자 확정 2026-09-02: 고객에게도 부대비용을 열되 실비 넷의 항목·옵션만이다.
  // 예전에는 통째로 감췄는데, 그 안에 금액(청구액)과 지시가 섞여 있었다 — "주유 가득"은
  // 지시이고 접수 때는 금액을 모른다. 넣을 칸이 없으면 요청사항 본문으로 새고, 아무도 안 읽는다.
  check('고객 항목은 넷', extraCharges.CLIENT_INTAKE_TYPES.length === 4,
    extraCharges.CLIENT_INTAKE_TYPES.join(','));
  // orders 컬럼에 저장되는 셋은 성격이 다르다 — 도선료는 경로탐색이 채우고,
  // 대기·취소요금은 실비가 아니라 운행요금이며 금액을 직접 넣는 항목이다.
  ['도선료', '대기요금', '취소요금'].forEach((t) => {
    check(`${t}는 고객에게 안 보인다`, !extraCharges.isClientAllowedType(t));
  });
  const forClient = extraCharges.intakeOptionsFor(null, { forClient: true });
  check('고객 화면 설정에 forClient가 실린다', forClient.forClient === true, '정산구분 칸을 감추는 신호');
  check('고객 화면 항목도 넷', forClient.items.length === 4);
  check('관리자 화면은 일곱 그대로', extraCharges.intakeOptionsFor(null).items.length === 7);

  console.log('\n[고객이 우회해 보내도 무시한다]');
  const asClient = (body) => extraCharges.parseIntakeRows(body, null, '2026-09-02', { asClient: true });
  const one = (type, mode, amount) => asClient({
    intake_extra_type: [type], intake_extra_option: [type === '주유비' ? 'amount' : ''],
    intake_extra_amount: [String(amount)], intake_extra_mode: [mode], intake_extra_id: [''],
  });
  // 청구 방식은 계약이고 요금설정이 정한다 — 고객이 '포함'을 보내면 청구가 사라진다.
  check('고객의 정산구분은 무시된다', one('주유비', 'included', 30000).rows[0].settleMode === 'monthly');
  check('그래도 청구 대상으로 남는다', one('주유비', 'included', 30000).rows[0].billable === true);
  check('허용 밖 항목은 버린다', one('대기요금', '', 99000).rows.length === 0);
  check('도선료도 버린다', one('도선료', '', 50000).rows.length === 0);
  check('도선료가 orders 컬럼으로도 안 간다',
    Object.keys(one('도선료', '', 50000).orderFees).length === 0,
    '고객이 도선료 금액을 바꾸면 안 된다');
  // 관리자는 그대로여야 한다 — 권한을 좁히다 관리자 기능을 막으면 운영이 멈춘다.
  const asAdmin = extraCharges.parseIntakeRows({
    intake_extra_type: ['주유비', '대기요금'], intake_extra_option: ['amount', ''],
    intake_extra_amount: ['30000', '99000'], intake_extra_mode: ['included', ''], intake_extra_id: ['', ''],
  }, null, '2026-09-02');
  check('관리자의 정산구분은 살아 있다', asAdmin.rows[0].settleMode === 'included');
  check('관리자는 대기요금을 넣을 수 있다', asAdmin.orderFees.wait && asAdmin.orderFees.wait.amount === 99000);

  console.log('\n[기존 오더에 소급할 길]');
  // 부대비용 후보와 등기우편 판정은 접수 시점에만 돈다. 그래서 그 기능이 생기기 전에 만들어진
  // 오더는 요청사항에 "주유 3만원", "등기로 보내주세요"가 그대로 적혀 있어도 아무 일도 일어나지
  // 않는다(실측 OID1455: 2026-08-24 접수, 두 기능은 8/25·9/2 추가). 요청사항을 나중에 고친
  // 경우도 마찬가지다. 다시 돌릴 길이 없으면 그 오더는 영영 빈 채로 남는다.
  const routesSrc2 = read('routes/orders.js');
  check('다시 분석하는 라우트가 있다', /router\.post\('\/:id\/reanalyze-memo'/.test(routesSrc2));
  check('고객은 못 쓴다', /reanalyze-memo[\s\S]{0,200}role === 'client'[\s\S]{0,40}403/.test(routesSrc2));
  // 등기 판정도 함께 돌려야 한다 — 둘 다 접수 시점에만 돌던 것이라 같은 처지다.
  check('등기우편 판정도 함께 돌린다', /reanalyze-memo[\s\S]{0,900}isPostalRequested/.test(routesSrc2));
  // 그 링크가 이미 적요1로 기사에게 나갔을 수 있다. 바꾸면 기사가 든 링크가 죽는다.
  check('이미 있는 인수증 토큰은 안 바꾼다', /!order\.receipt_upload_token && postalReceipt\.isPostalRequested/.test(routesSrc2));
  // 관리자가 버튼을 누르고 결과를 보려는 자리다 — 응답 뒤로 미루면 새로고침해야 보인다.
  // 관리자가 버튼을 누르고 결과를 보려는 자리라 응답 뒤로 미루면 안 된다(접수 경로와 반대).
  check('결과를 기다렸다 돌려준다',
    /reanalyze-memo[\s\S]{0,1600}const candidates = await memoExtraCosts\.analyzeAndStore/.test(routesSrc2));
  // 버튼은 요청 메모 칸 옆에 둔다. 분석 대상이 그 글이라 읽고 있는 자리에 있어야 하고,
  // 페이지 맨 아래 카드에 두었더니 아무도 못 봤다(실측 2026-09-04).
  check('EJS — 요청 메모 옆에 버튼', /memo-reanalyze-btn/.test(read('views/orders/detail.ejs')));
  check('Next — 요청 메모 옆에 버튼',
    /<MemoReanalyzeButton orderId=/.test(read('src/app/orders/new/OrderForm.js')));
  // 고객에게는 안 보인다 — 청구 항목을 정하는 일이다.
  check('EJS — 고객에게는 안 보인다',
    /role !== 'client'[\s\S]{0,200}memo-reanalyze-btn/.test(read('views/orders/detail.ejs')));
  check('Next — 고객에게는 안 보인다',
    /mode === 'edit' && !isClient[\s\S]{0,80}MemoReanalyzeButton/.test(read('src/app/orders/new/OrderForm.js')));

  // 눌러서 결과를 보고 그 자리에서 채택까지 하는 한 흐름이다. 페이지를 새로 그리면 관리자가
  // 어디를 봐야 하는지 다시 찾아야 하고, 수정 중이던 다른 칸이 날아간다.
  ['public/js/memo-reanalyze.js', 'src/app/orders/new/MemoReanalyzeButton.js'].forEach((f) => {
    const src3 = read(f);
    check(`${f} — 팝업으로 띄운다`, /map-modal-overlay/.test(src3));
    check(`${f} — 근거 원문을 보여준다`, /evidence/.test(src3));
    check(`${f} — 팝업에서 바로 채택한다`, /memo-extra/.test(src3));
    // 부대비용 줄이 생겼으니 아래 정산 카드도 다시 읽어야 한다.
    check(`${f} — 채택 후 새로 읽는다`, /location\.reload\(\)/.test(src3));
  });
  // 서버가 JSON으로 돌려줘야 팝업이 화면을 새로 그리지 않고 결과만 받는다.
  check('재분석이 JSON도 돌려준다', /wantsJson[\s\S]{0,600}candidates: candidates\.map/.test(routesSrc2));
  check('채택도 JSON을 돌려준다', /X-Requested-With'\) === 'fetch'\) return res\.json\(\{ ok: true, added/.test(routesSrc2));

  console.log('\n[고객에게 되돌려 보여주는 것]');
  // 아무 반응이 없으면 고객은 우리가 알아들었는지 몰라 전화한다 — 이 채널이 없애려는 바로
  // 그 통화다. 그렇다고 부대비용 항목에 섞으면 확정된 것으로 읽히고, 관리자가 기각했을 때
  // 봤던 것이 사라진다. 그 사이가 맞다: 읽기전용 안내로 "확인 중"임을 못 박는다.
  const custOrder = { memo_extra_json: JSON.stringify([
    { code: 'fuel', label: '주유비', amount: 30000, evidence: '주유 3만원', settleMode: 'monthly', billable: true },
    { code: 'wash', label: '세차비', amount: 0, evidence: '손세차', settleMode: 'individual', billable: true, decision: 'rejected' },
  ]) };
  const cust = memoExtra.customerViewFromOrder(custOrder);
  check('판단 안 한 것만 보여준다', cust.length === 1, `${cust.length}건`);
  // 고객이 직접 쓴 숫자라 이미 아는 값이고, 오히려 그게 맞는지 확인받아야 할 대상이다.
  check('금액은 보여준다', cust[0] && cust[0].amount === 30000);
  // 그게 있어야 "내가 쓴 게 이렇게 읽혔구나"를 알고 틀렸으면 그 자리에서 잡는다.
  check('근거 원문을 함께 준다', cust[0] && cust[0].evidence === '주유 3만원');
  // 계약 사항이라 고객이 정할 것이 아니고, 확정도 안 된 후보에 청구 방식을 붙이면 이미
  // 청구가 시작된 것처럼 읽힌다.
  check('정산구분은 빼고 준다', cust[0] && cust[0].settleMode === undefined && cust[0].billable === undefined);

  const routesForCust = read('routes/orders.js');
  check('고객에게만 내려준다',
    (routesForCust.match(/memoExtraForCustomer: (u|req\.session\.user)\.role === 'client' \? memoExtra/g) || []).length === 2);
  check('관리자용 후보는 고객에게 안 준다',
    (routesForCust.match(/memoExtraCandidates: (u|req\.session\.user)\.role === 'client' \? \[\]/g) || []).length === 2);

  // 세 화면 모두에 있어야 한다 — 한쪽만 고치면 채널에 따라 보이고 안 보인다.
  ['views/orders/form.ejs', 'views/orders/ai_intake.ejs', 'src/app/orders/new/ExtraCostSection.js'].forEach((f) => {
    const src2 = read(f);
    check(`${f} — 확인 중 카드가 있다`, /요청사항에서 확인한 내용/.test(src2));
    check(`${f} — 확정이 아니라고 말한다`, /담당자 확인 후 확정됩니다/.test(src2));
    // 섞으면 등록된 것으로 읽힌다.
    check(`${f} — 부대비용 목록과 분리돼 있다`, /memo-extra-echo/.test(src2));
  });

  console.log('\n[두 화면이 같이 있는가]');
  // EJS와 Next가 함께 살아 있어야 한다 — 한쪽만 고치면 플래그를 되돌렸을 때 기능이 사라진다.
  const ejs = read('views/orders/detail.ejs');
  const next = read('src/app/orders/[id]/MemoExtraCandidates.js');
  const routes = read('routes/orders.js');
  [['EJS', ejs], ['Next', next]].forEach(([name, src]) => {
    check(`${name} — 채택 폼이 있다`, /memo-extra/.test(src));
    check(`${name} — 근거 원문을 보여준다`, /evidence/.test(src));
    check(`${name} — 포함 항목을 따로 안내한다`, /포함/.test(src));
  });
  check('두 화면 모두에 값을 내려준다',
    (routes.match(/memoExtraCandidates:/g) || []).length === 2,
    '한 곳만 있으면 다른 화면에서는 배너가 안 뜬다');
  check('채택 라우트가 client를 막는다', /memo-extra[\s\S]{0,200}role === 'client'/.test(routes));

  console.log('\n[금액칸 규칙이 두 폼에 같이 들어갔는가]');
  // Next 폼과 EJS 공유 JS가 같은 조건을 써야 한다 — 한쪽만 고치면 플래그를 되돌렸을 때
  // 금액칸이 다시 열리고, 어림값이 영수증 없이 청구된다.
  const nextForm = read('src/app/orders/new/ExtraCostSection.js');
  const sharedJs = read('public/js/order-form.js');
  [['Next 폼', nextForm], ['공유 JS', sharedJs]].forEach(([name, src]) => {
    check(`${name} — fixedAmount로 금액칸을 가른다`, /fixedAmount\s*&&/.test(src),
      'fixedAmount를 안 보면 세차·주차에도 금액칸이 열린다');
    check(`${name} — amountOption도 함께 본다`, /amountOption/.test(src));
  });
  // 고객 화면에서 정산구분 칸이 남으면 고객이 청구 방식을 고르는 것처럼 보인다.
  check('Next 폼 — 고객이면 정산구분을 안 그린다', /forClient \? null/.test(nextForm));
  check('공유 JS — 고객이면 정산구분을 안 그린다', /xcConfig\.forClient/.test(sharedJs));
  // 역할 가드를 화면에서 뺐으니 서버가 유일한 방어선이다.
  check('접수 저장이 asClient를 넘긴다', /parseIntakeRows\([\s\S]{0,160}asClient/.test(routes));
  const ejsForms = ['views/orders/form.ejs', 'views/orders/ai_intake.ejs'].map(read);
  ejsForms.forEach((src, i) => {
    check(`EJS 폼 ${i + 1} — 역할로 감추지 않는다`,
      !/role !== 'client'[\s\S]{0,80}intakeExtra/.test(src),
      '화면에서 감추면 고객은 지시를 넣을 칸이 없다');
  });

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})();
