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

  console.log('\n[두 화면이 같이 있는가]');
  // EJS와 Next가 함께 살아 있어야 한다 — 한쪽만 고치면 플래그를 되돌렸을 때 기능이 사라진다.
  const fs = require('fs');
  const path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
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

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})();
