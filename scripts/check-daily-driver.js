// 일일기사가 **자기 요금 기준(이용 시간)과 자기 접수 흐름**으로 다뤄지는지 본다.
//
// 무엇을 막나 — 실측(2026-09-09)한 두 가지 어긋남이다.
//
//   1. **요금 문의.** 프로덕션 고객 챗봇(EJS 위젯)은 "일일대리기사 요금 문의는 현재 설계
//      준비 중입니다"로 답하고 있었다. 요금표는 이미 등록돼 있었고(premium_fare_rules /
//      group_daily_driver_fare_rules), 카카오 채널은 같은 질문에 금액을 답했다 — 채널마다
//      다른 답이 나가고 있었다.
//
//   2. **접수.** Next 챗봇의 수집 흐름은 탁송 전용이다(ORDER_FIELD_IDS가 탁송 필드다).
//      그래서 일일기사 요청도 도착지 연락처를 묻고, 이용형태·경유지·대기시간은 아예 묻지
//      않은 채 탁송으로 등록됐다. 그 흐름은 서버(lib/webIntakeTurn.js)에 이미 있었는데
//      쓰지 않고 있었다.
//
// 그래서 이 검사가 지키는 것은 세 가지다:
//   · 일일기사 요금은 **거리가 아니라 시간**으로 계산한다(경로를 요구하지 않는다).
//   · 안내 문구에 금액을 박지 않는다 — 관리자가 표를 바꾸면 안내도 바뀌어야 한다.
//   · 접수 FSM은 서버 한 벌만 쓴다 — 화면으로 옮기면 같은 판단이 세 벌이 된다.
//
// 파일만 읽는다 — CI에서 돌 수 있다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// 주석 안의 글자가 코드로 읽히면 안 된다 — 이 저장소에서 이미 겪었다.
const code = (p) => read(p).split('\n').filter((l) => !/^\s*(\/\/|--)/.test(l)).join('\n');

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

const assist = code('lib/agentAssist.js');
const policy = code('lib/branchPolicy.js');
const orders = code('routes/orders.js');
const ejs = code('public/js/ai-intake.js');
const ejsApi = code('public/js/ai-intake-api.js');
const next = code('src/app/orders/ai-intake/AiIntakeClient.js');
const form = code('src/app/orders/new/OrderForm.js');

console.log('[요금은 시간으로 계산한다]');
check('이용 시간을 읽는다', /function parseUseHours\(/.test(assist));
// 하루를 넘는 값은 시간이 아니라 다른 숫자를 잘못 읽은 것이다.
check('24시간을 넘으면 시간으로 보지 않는다', /hours > 24/.test(assist));
check('분·반 표현을 다룬다', /반/.test(assist) && /\/ 60/.test(assist));
check('시간 기준 요금표로 계산한다', /calculatePremiumFare\(/.test(assist));
// **경로를 요구하기 전에** 답해야 한다. 뒤에 두면 "일일기사 8시간 얼마예요?"가
// "출발지·도착지를 못 찾았다"로 떨어져 답이 안 나간다.
const fareFn = assist.slice(assist.indexOf('async function buildFareSuggestion('));
const body = fareFn.slice(0, fareFn.indexOf('\n}\n') + 2);
// **질문이 일일기사일 때의 분기**가 경로 추출보다 앞에 있어야 한다.
//
// 그냥 buildDailyDriverFareAnswer가 앞에 있는지만 보면 안 된다 — 되묻는 답을 받는 분기
// (awaitingDailyDriverHours)도 같은 함수를 부르므로, 정작 질문 분기를 지워도 통과한다
// (음성 시험에서 실제로 그랬다).
const askIdx = body.indexOf('if (isDailyDriverAsk)');
check('일일기사 질문 분기가 있다', askIdx >= 0);
check('경로 추출보다 먼저 답한다', askIdx >= 0 && askIdx < body.indexOf('extractRoute(raw)'),
  '일일기사는 출발·도착이 없어도 금액이 나온다');
check('경로가 없어도 막지 않는다',
  askIdx >= 0 && askIdx < body.indexOf('if (!from || !to) return null;'));
check('되묻는 답도 경로 없이 받는다',
  body.indexOf('opts.awaitingDailyDriverHours') < body.indexOf('extractRoute(raw)'));
// 시간 없이 물으면 표를 알려주고 시간을 받는다.
check('시간을 못 받으면 되묻는다', /DAILY_DRIVER_HOURS_QUESTION/.test(assist));
check('되묻는 문장을 상수로 둔다', /const DAILY_DRIVER_HOURS_QUESTION = /.test(assist),
  '문구가 갈리면 "방금 물어봤다"는 판단이 조용히 깨진다');
check('되묻는 중임을 호출부에 알린다', /awaitingHours: true/.test(assist));
// 숫자를 문구에 박으면 관리자가 표를 바꿔도 안내만 옛 값으로 남는다.
check('안내에 금액을 박지 않았다', !/90,000원|90000원|15,000원/.test(assist));
check('등록된 구간을 그대로 보여준다', /describeDailyDriverTiers\(/.test(assist));

console.log('\n[구간 없이 물어도 답한다]');
// 프리미엄대리는 거리 기준이라 금액은 못 내지만, 아무 답도 안 하면 질문이 통째로 FAQ 검색으로
// 새서 "관련된 답변을 찾지 못했습니다"로 끝난다(실측 2026-09-09).
check('구간 없는 대리 질문을 다룬다', /if \(!route && askedProduct\(t\) === 'premium'\)/.test(assist));
check('요금표가 없으면 상담원을 제안한다',
  /요금 정보가 등록되어 있지 않습니다/.test(assist) && /offerAgent: true/.test(assist));
check('요금표가 있으면 구간을 묻는다', /출발지와 도착지를 알려주시면/.test(assist));

console.log('\n[왜 그 금액인지 밝힌다]');
// 기준 시간보다 짧게 써도 기준요금이 그대로 나온다 — 설명 없이는 과청구로 보인다.
check('계산이 근거를 함께 돌려준다',
  /baseHours: Number\(tier\.base_hours\)/.test(policy) && /extraHours,/.test(policy));
check('기준 시간 미만을 설명한다', /기준 시간 미만도 기준요금/.test(assist));
check('초과 시간을 설명한다', /초과 \$\{formatHours\(quote\.extraHours\)\}/.test(assist));

console.log('\n[세 화면이 같은 낱말을 쓴다]');
// 한쪽만 넓으면 화면은 시간으로 보고 보냈는데 서버는 못 읽어 답이 사라진다(또는 그 반대).
const res = [
  ['서버', (assist.match(/const USE_HOURS_RE = (\/[^;]+\/)/) || [])[1]],
  ['EJS', (ejs.match(/var USE_HOURS_RE = (\/[^;]+\/)/) || [])[1]],
  ['Next', (next.match(/const USE_HOURS_RE = (\/[^;]+\/)/) || [])[1]],
];
check('세 곳 모두 정의돼 있다', res.every((r) => !!r[1]), res.map((r) => `${r[0]}=${r[1]}`).join(' / '));
check('셋이 같다', new Set(res.map((r) => r[1])).size === 1, res.map((r) => `${r[0]}=${r[1]}`).join(' / '));

console.log('\n[계산은 서버 한 곳에만 있다]');
// 위젯이 시간 요금표를 직접 읽기 시작하면 계산이 두 벌이 된다.
for (const [label, src] of [['EJS', ejs], ['Next', next]]) {
  check(`${label}: 시간 요금표를 직접 다루지 않는다`,
    !/premium_fare_rules|group_daily_driver_fare_rules|extra_per_hour/.test(src));
}
check('EJS가 서버 계산을 부른다', /ai-intake\/fare-inquiry/.test(ejsApi) && /fetchProductFare/.test(ejs));
check('Next가 서버 계산을 부른다', /ai-intake\/fare-inquiry/.test(next));
// "설계 준비 중"으로 끝내던 자리가 실제 답으로 바뀌었는지.
check('EJS에 "준비 중" 응답이 남아 있지 않다', !/요금 문의는 현재 설계 준비 중/.test(ejs),
  '요금표는 등록돼 있는데 안내만 없던 상태였다');
// **EJS의 상품 판정이 일일기사를 잡아야 한다.** 낱말이 좁아서 "일일기사 8시간 요금"이 맨 아래
// 규칙으로 탁송이 되면, 시간 요금을 물었는데 출발지·도착지를 되묻는다(실측 2026-09-09).
const detect = ejs.slice(ejs.indexOf('function detectFareInquiryType('));
const detectBody = detect.slice(0, detect.indexOf('\n  }\n') + 4);
for (const w of ['일일', '대리', '프리미엄']) {
  check(`EJS 상품 판정이 "${w}"를 본다`, detectBody.includes(w));
}
// 어느 상품인지는 서버가 정한다 — 여기서 또 가르면 판정이 두 벌이 된다.
check('EJS가 상품을 직접 가르지 않는다', !/'daily_proxy'|'proxy'/.test(ejs),
  '서버(askedProduct)가 시간 유무까지 보고 편도인지 시간제인지 가른다');
// 답을 못 만들면 상담원으로 넘겨야 한다 — "준비 중"만 말하면 고객은 갈 곳이 없다.
check('EJS: 답이 없으면 상담원으로 넘긴다',
  /fetchProductFare[\s\S]{0,600}handleUnsupportedIntent/.test(ejs));
check('Next: 요금표 미등록이면 상담원 버튼을 띄운다', /needsAgent: !!data\.offerAgent/.test(next));

console.log('\n[되묻는 답을 받는다]');
const inquiry = orders.slice(orders.indexOf("router.post('/ai-intake/fare-inquiry'"), orders.indexOf("router.post('/ai-intake/activity'"));
check('엔드포인트가 되묻기 상태를 받는다', /awaitingDailyDriverHours: !!\(req\.body && req\.body\.awaitingHours\)/.test(inquiry));
check('엔드포인트가 되묻기 상태를 돌려준다', /awaitingHours: !!draft\.awaitingHours/.test(inquiry));
for (const [label, src] of [['EJS', ejs], ['Next', next]]) {
  check(`${label}: 되묻는 중임을 기억한다`, /(dailyDriverHoursPending|dailyDriverHoursPendingRef)/.test(src));
  // 계속 켜 두면 한참 뒤의 "8시간"이 엉뚱하게 요금 답변으로 새어 나간다.
  check(`${label}: 시간이 아닌 답이 오면 끈다`,
    /dailyDriverHoursPending(Ref\.current)? = false/.test(src));
}

console.log('\n[접수 FSM은 서버 한 벌만 쓴다]');
// 일일기사 필드 정의는 서버에 있다 — 화면이 자기 목록을 만들기 시작하면 갈린다.
check('서버에 일일기사 필드 정의가 있다', /getDailyDriverFields/.test(code('lib/intakeFields.js')));
check('서버 턴 엔진이 그 정의를 쓴다', /getDailyDriverFields\(/.test(code('lib/webIntakeTurn.js')));
check('Next가 대리/일일기사를 서버로 넘긴다',
  /parseData\.intent === 'proxy_order' \|\| parseData\.intent === 'daily_driver_order'/.test(next));
check('넘긴 뒤에도 서버가 대화를 잇는다', /premiumTurnActiveRef/.test(next));
// 되묻는 답을 받는 중에 갈아타면 진행 중인 탁송 수집이 통째로 사라진다.
check('되묻는 중에는 갈아타지 않는다',
  /if \(!activePendingField\s*\n?\s*&& \(parseData\.intent === 'proxy_order'/.test(next));
// 새 대화로 넘어갈 때 ref를 안 지우면 첫 메시지가 엉뚱한 흐름으로 들어간다.
check('새 대화에서 상태를 비운다',
  /createFreshSession[\s\S]{0,900}premiumTurnActiveRef\.current = false/.test(next));
// 대화가 닫히면 지름길도 꺼져야 한다.
check('등록이 끝나면 지름길을 끈다', /closeSession\) premiumTurnActiveRef\.current = false/.test(next));
// 화면이 일일기사 필드 목록을 자체로 들고 있으면 서버와 갈린다.
check('Next가 일일기사 필드 목록을 따로 만들지 않는다',
  !/trip_type[\s\S]{0,200}destination_wait[\s\S]{0,200}final_destination/.test(next));

console.log('\n[오더구분이 폼까지 간다]');
// 대화는 일일기사로 진행됐는데 폼이 탁송이면, 상담원이 그대로 저장할 때 오더구분이 바뀐다.
check('파싱 결과가 오더구분을 싣는다', /parsed\.category === 'premium_daily'/.test(assist));
for (const f of ['order_type', 'trip_type', 'final_destination_address', 'destination_wait_minutes', 'waypoint_address']) {
  check(`${f}를 넘긴다`, new RegExp(`${f}:`).test(assist));
}
// 탁송은 지금까지와 같아야 한다.
check('탁송에는 붙이지 않는다', /\.\.\.\(parsed\.category === 'premium_daily' \? \{/.test(assist),
  '조건 없이 넣으면 탁송 접수까지 order_type이 박힌다');
// 폼이 그 값들을 실제로 받는지 — 안 받으면 넘겨도 사라진다.
for (const f of ['order_type', 'trip_type', 'final_destination_address']) {
  check(`폼이 ${f}를 반영한다`, new RegExp(`setIfFilled\\('${f}'`).test(form));
}
check('폼이 도착지 대기시간을 반영한다', /destination_wait_minutes != null/.test(form));
// 일일기사는 경유지를 **항상** 묻는다 — 폼이 행을 안 만들면 받은 주소가 조용히 사라진다.
check('폼이 경유지 행을 만든다', /ADD_WAYPOINT[\s\S]{0,200}SET_WAYPOINT_FIELD/.test(form)
  && /p\.waypoint_address/.test(form));
// 선언만 남고 판정에서 빠지면 같은 행이 두 번 만들어진다 — **조건절에서 쓰는지**를 본다.
check('같은 경유지를 두 번 만들지 않는다',
  /if \(waypointAddress && prefilledWaypointRef\.current !== waypointAddress\)/.test(form),
  '선언만 있고 조건에서 안 쓰면 프리필이 올 때마다 행이 늘어난다');

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
