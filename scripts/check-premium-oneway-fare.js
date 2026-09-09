// 법인대리(프리미엄) 요금이 **자기 표로** 계산되는지 본다.
//
// 무엇을 막나: 이 저장소에는 프리미엄 이름이 붙은 표가 두 개 있고, 둘은 청구 기준이 다르다.
//
//   premium_oneway_fare_rules / group_premium_oneway_fare_rules   편도 **거리** — 프리미엄대리
//   premium_fare_rules        / group_daily_driver_fare_rules     이용 **시간** — 일일기사
//
// 이름이 함정이다. `premium_fare_rules`는 이름과 달리 일일기사 표다(법인 쪽 이름이 그 증거다).
// 그래서 실제로 이런 일들이 있었다:
//   · 화면 안내문은 "프리미엄은 일일기사 요금표를 그대로 쓴다"고 적혀 있었지만 그렇게 동작한
//     적이 없다 — /orders/premium-fare-preview를 부르는 화면이 없었다.
//   · 대신 /orders/fare-preview가 **오더구분을 안 봐서** 프리미엄 오더에 탁송 금액이 들어갔다.
//   · 요금 문의도 거리 기준 탁송 표만 보고 답했다.
//
// 그래서 이 검사는 세 가지를 지킨다: (1) 상품마다 자기 표를 볼 것, (2) 표가 비었으면 **다른
// 표로 대신 계산하지 말 것**, (3) 시간 기준 상품을 거리로 추정하지 말 것.
//
// 파일만 읽는다 — CI에서 돌 수 있다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// 주석 안의 글자가 코드로 읽히면 안 된다 — 이 저장소에서 이미 두 번 겪었다(주석에 인용한
// 이름 때문에 검사가 통과해버렸다).
const code = (p) => read(p).split('\n').filter((l) => !/^\s*(\/\/|--|%#)/.test(l)).join('\n');

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

console.log('[표가 따로 있다]');
const migrations = fs.readdirSync(path.join(ROOT, 'supabase/migrations'));
const mig = migrations.find((f) => /premium_oneway/.test(f));
check('마이그레이션이 있다', !!mig, '프리미엄 편도 요금표를 만드는 파일이 없다');
if (mig) {
  const sql = read(`supabase/migrations/${mig}`);
  for (const t of ['premium_oneway_fare_rules', 'group_premium_oneway_fare_rules']) {
    check(`${t}를 만든다`, new RegExp(`create table if not exists ${t}`).test(sql));
  }
  // 열 구성이 탁송과 같아야 같은 계산 함수(fareFromTiers)를 쓸 수 있다.
  for (const c of ['base_distance_km', 'base_fare', 'surcharge_unit_km', 'surcharge_fare', 'round_unit', 'round_method']) {
    check(`거리 구간 열 ${c}`, sql.includes(c));
  }
  // **기본값을 넣으면 관리자가 정한 적 없는 금액이 청구된다.**
  check('기본 구간을 넣지 않는다', !/insert into (group_)?premium_oneway_fare_rules/i.test(sql),
    '빈 표여야 { enabled:false }로 떨어져 "미등록"으로 안내된다');
  // 일일기사 표를 건드리면 그쪽 청구가 멈춘다.
  check('일일기사 표를 건드리지 않는다',
    !/(alter|drop|rename)[\s\S]{0,60}premium_fare_rules/i.test(sql));
}

console.log('\n[계산이 자기 표만 본다]');
const policy = code('lib/branchPolicy.js');
check('calculatePremiumOnewayFare가 있다', /async function calculatePremiumOnewayFare\(/.test(policy));
const onewayFn = policy.slice(policy.indexOf('async function calculatePremiumOnewayFare('));
const onewayBody = onewayFn.slice(0, onewayFn.indexOf('\n}\n') + 2);
check('법인 표를 먼저 본다', onewayBody.indexOf('group_premium_oneway_fare_rules') < onewayBody.indexOf('FROM premium_oneway_fare_rules'));
check('지사 표로 내려간다', /FROM premium_oneway_fare_rules/.test(onewayBody));
// 시간 기준 표를 여기서 읽으면 두 상품이 다시 한 표를 공유한다.
check('일일기사 표를 읽지 않는다',
  !/premium_fare_rules|group_daily_driver_fare_rules/.test(onewayBody),
  '프리미엄=거리, 일일기사=시간이라 한 표를 공유할 수 없다');
// 등록된 구간이 없으면 금액을 만들지 않는다.
check('표가 없으면 enabled:false', /if \(!tiers\.length\) return \{ enabled: false \}/.test(onewayBody));
// 탁송과 같은 방식이면 계산을 두 벌 만들 이유가 없다 — 두 벌이면 한쪽만 고쳐 금액이 갈린다.
check('탁송과 같은 계산 함수를 쓴다', /fareFromTiers\(tiers/.test(onewayBody));
// 마이그레이션 전에도 접수가 진행돼야 한다.
check('표가 없어도 던지지 않는다', /\.catch\(/.test(onewayBody));
check('내보낸다', /module\.exports = \{[\s\S]*calculatePremiumOnewayFare/.test(policy));

console.log('\n[오더 등록 화면이 오더구분에 맞는 표를 쓴다]');
const orders = code('routes/orders.js');
const preview = orders.slice(orders.indexOf("router.get('/fare-preview'"), orders.indexOf("router.get('/vehicle-type-suggest'"));
check('오더구분을 본다', /req\.query\.order_type === 'premium'/.test(preview));
check('프리미엄은 편도 표로 계산한다', /calculatePremiumOnewayFare\(/.test(preview));
// **표가 없을 때 탁송 표로 흘러내리면 안 된다** — 이 검사의 핵심이다.
check('표가 없으면 계산을 포기한다',
  /reason: 'premium_oneway_unset'/.test(preview) && /return res\.json\(\{ enabled: false, reason: 'premium_oneway_unset' \}\)/.test(preview),
  '프리미엄 분기가 return 없이 끝나면 아래 탁송 계산이 그대로 이어진다');
// 법인 표를 먼저 보는 순서를 지키려면 group_id가 필요하다.
check('법인을 넘긴다', /calculatePremiumOnewayFare\(groupId/.test(preview));
// 화면이 읽는 이름으로 돌려줘야 금액이 채워진다.
for (const f of ['totalFare', 'baseFare', 'editableByClient']) {
  check(`응답에 ${f}가 있다`, new RegExp(`${f}:`).test(preview));
}

console.log('\n[두 화면이 오더구분을 넘긴다]');
// 한쪽만 넘기면 그 화면에서만 맞는 금액이 나온다 — 이 저장소는 EJS/Next 이중 화면이다.
const ejsForm = code('public/js/order-form.js');
const nextForm = code('src/app/orders/new/OrderForm.js');
// **요금 조회를 만드는 자리만 본다.** 파일 전체로 보면 통과해버린다 — 두 화면 모두 오더를
// 저장할 때 쓰는 별도의 params 조립부에서 order_type을 이미 넘기고 있어서, 요금 조회에서
// 빠져도 파일 어딘가에 그 낱말이 남는다(음성 시험에서 실제로 통과했다).
const ejsFareParams = ejsForm.slice(ejsForm.indexOf('function ferryQueryParams('), ejsForm.indexOf('function updateFarePreview('));
const nextFareIdx = nextForm.indexOf("const res = await fetch('/orders/fare-preview?'");
const nextFareParams = nextForm.slice(nextForm.lastIndexOf('const params = new URLSearchParams();', nextFareIdx), nextFareIdx);
check('요금 조회 조립부를 찾았다', ejsFareParams.length > 200 && nextFareParams.length > 200,
  `EJS ${ejsFareParams.length}자 / Next ${nextFareParams.length}자`);
check('EJS가 order_type을 넘긴다', /params\.set\('order_type'/.test(ejsFareParams));
check('Next가 order_type을 넘긴다', /params\.set\('order_type'/.test(nextFareParams));
// 법인 요금표·지점 구간요금은 group_id 없이는 통째로 무시된다.
check('EJS가 group_id를 넘긴다', /params\.set\('group_id'/.test(ejsFareParams));
check('Next가 group_id를 넘긴다', /params\.set\('group_id'/.test(nextFareParams));
// 미등록 사유를 갈라 말해야 관리자가 고칠 곳을 찾는다.
for (const [label, src] of [['EJS', ejsForm], ['Next', nextForm]]) {
  check(`${label}: 미등록을 따로 안내한다`, /premium_oneway_unset/.test(src));
}

console.log('\n[요금 문의가 상품을 갈라 답한다]');
const assist = code('lib/agentAssist.js');
check('질문에서 상품을 읽는다', /function askedProduct\(/.test(assist));
// 좁은 낱말부터 봐야 한다 — "일일기사"에는 대리가 없지만 "법인대리"에는 대리가 있어서,
// 순서를 뒤집으면 일일기사 질문이 프리미엄으로 잡힌다.
check('일일기사를 대리보다 먼저 본다',
  assist.indexOf('DAILY_DRIVER_RE.test') < assist.indexOf('PREMIUM_RE.test'));
check('프리미엄은 편도 표로 답한다', /calculatePremiumOnewayFare\(/.test(assist));
// 시간 기준 상품을 **거리로** 추정하면 실제 청구와 어긋난다.
//
// 예전에는 "그 함수를 아예 부르지 마라"였다. 이제는 이용 시간을 받아 부르는 것이 맞는 동작이라
// (2026-09-09 일일기사 요금 문의) 규칙을 좁혔다 — 인자로 **거리를 넘기지 않는지**를 본다.
check('일일기사 금액을 거리로 만들지 않는다',
  !/calculatePremiumFare\([^)]*distanceKm/.test(assist),
  '일일기사는 이용 시간을 받아야 금액이 나온다');
check('일일기사는 이용 시간으로 계산한다', /calculatePremiumFare\(branchId, hours/.test(assist));
check('일일기사는 등록된 표를 읽어 안내한다', /describeDailyDriverFare\(/.test(assist));
// 숫자를 문구에 박으면 관리자가 표를 바꿔도 안내가 조용히 낡는다.
check('안내 문구에 금액을 박지 않았다', !/90,000원|90000원/.test(assist));
// 등록되지 않은 상품에 금액을 지어내지 않고 상담원으로 넘긴다(사용자 확정 문구).
check('미등록이면 상담원 연결을 제안한다',
  /요금 정보가 등록되어 있지 않습니다/.test(assist) && /상담원에게 연결해 드릴까요\?/.test(assist));
check('구분 없는 질문은 탁송으로 답한다', /탁송 예상 요금은/.test(assist));
check('구분 없는 질문에 다른 상품도 알린다', /일일기사 요금".{0,40}말씀해주세요|일일기사\(하루 단위\)/.test(assist));

console.log('\n[관리자가 표를 입력할 수 있다]');
const branches = code('routes/branches.js');
const groups = code('routes/groups.js');
check('지사 화면 라우트가 있다', /'\/:id\/premium-oneway-fare-rules'/.test(branches));
check('지사 저장이 있다', /router\.post\('\/:id\/premium-oneway-fare-rules'/.test(branches));
check('법인 저장이 있다', /router\.post\('\/:id\/premium-fare-rules'/.test(groups));
check('법인이 지사 표를 가져올 수 있다', /premium-fare-rules\/copy/.test(groups));
// 저장 화면과 계산이 같은 표를 봐야 한다 — 다른 표에 저장하면 입력해도 요금이 안 바뀐다.
//
// **저장 처리부만 본다.** 파일 전체로 보면 통과해버린다 — 법인 화면에는 "지사 표 가져오기"가
// 있어서 같은 INSERT가 두 번 나오고, 저장 쪽이 일일기사 표로 바뀌어도 낱말이 남는다
// (음성 시험에서 실제로 통과했다).
const branchSave = branches.slice(branches.indexOf("router.post('/:id/premium-oneway-fare-rules'"));
const groupSaveIdx = groups.indexOf("router.post('/:id/premium-fare-rules'");
const groupSave = groups.slice(groupSaveIdx, groups.indexOf('router.', groupSaveIdx + 10));
check('저장 처리부를 찾았다', branchSave.length > 200 && groupSave.length > 200,
  `지사 ${branchSave.length}자 / 법인 ${groupSave.length}자`);
check('지사 저장이 premium_oneway_fare_rules에 넣는다', /INSERT INTO premium_oneway_fare_rules/.test(branchSave));
check('법인 저장이 group_premium_oneway_fare_rules에 넣는다', /INSERT INTO group_premium_oneway_fare_rules/.test(groupSave));
// 일일기사 표에 거리 값을 넣으면 그쪽 청구까지 망가진다.
for (const [label, src] of [['지사', branchSave], ['법인', groupSave]]) {
  check(`${label}: 일일기사 표에 쓰지 않는다`,
    !/INSERT INTO (premium_fare_rules|group_daily_driver_fare_rules)/.test(src));
}
// 할증단위 0은 금액 ÷ 단위라 Infinity가 된다.
for (const [label, src] of [['지사', branchSave], ['법인', groupSave]]) {
  check(`${label}: 할증단위 0을 막는다`, /Number\(surUnit\[i\]\) \|\| 1/.test(src));
}
// 마이그레이션 전에 저장하면 조용히 삼켜지지 않고 사유가 보여야 한다.
for (const [label, src] of [['지사', branches], ['법인', groups]]) {
  check(`${label}: 마이그레이션 전 저장을 알린다`, /42P01/.test(src));
}
// 화면이 열려 있어야 관리자가 찾는다.
const tabs = read('views/partials/branch_tabs.ejs');
check('지사 탭에 있다', /premium-oneway-fare-rules/.test(tabs));
check('일일기사 탭과 따로다', /'일일기사 요금', path: 'premium-fare-rules'/.test(tabs));
// 행을 추가할 때 칸 수가 헤더와 어긋나면 값이 한 칸씩 밀려 다른 열로 저장된다.
const fareJs = code('public/js/fare-rules.js');
check('추가 행에 비고 칸을 만든다', /hasNote \?/.test(fareJs));
for (const v of ['views/branches/premium_oneway_fare_rules.ejs', 'views/groups/premium_fare_rules.ejs']) {
  const src = read(v);
  check(`${path.basename(v)}: 비고 칸을 쓴다고 표시한다`, /data-note="1"/.test(src));
  // 준비 중 문구가 남아 있으면 관리자가 입력을 시도하지 않는다.
  check(`${path.basename(v)}: 준비 중 문구가 없다`, !/준비 중/.test(src));
  check(`${path.basename(v)}: 일일기사와 다름을 밝힌다`, /일일기사/.test(src));
}

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
