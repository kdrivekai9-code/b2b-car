// 챗봇이 읽은 예약 기준(즉시 / 픽업 기준 / 도착 기준)이 접수 폼의 라디오까지 가는지 본다.
//
// 왜 필요한가(실사용 지적 2026-09-11): "일시 : 07/27 즉시"로 접수하면 챗봇은 "즉시로 예약을
// 확인했습니다"라고 답하는데 **우측 접수창은 픽업 기준 그대로**였다. 서버는 예전부터
// reservation_immediate를 내려주고 있었고 EJS 챗봇은 그걸 받아 라디오를 켰는데(public/js/
// ai-intake.js applyImmediateReservationBasis), Next 판은 그 값을 버렸다 — 폼에 넘기는 항목
// 목록(ORDER_FIELD_IDS)에 없는 키였기 때문이다.
//
// 조용히 틀리는 종류라 더 나쁘다: 폼에는 그럴듯한 날짜·시각이 들어가 있어서(즉시 = 지금
// 시각이므로) 비어 보이지 않는다. 그대로 저장하면 "즉시"가 "오늘 14:00 픽업 예약"이 된다.
//
// 판별 규칙은 lib/reservationBasis.js 한 곳에 두고 서버가 계산해 내려준다. EJS 쪽 사본은
// 동작 중인 경로라 그대로 뒀으므로, 두 사본이 갈라지지 않는지도 여기서 본다.
//
// 파일을 읽고 lib을 직접 부른다 — DB도 모델도 안 부르므로 CI에서 돌 수 있다.
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

const libSrc = read('lib/reservationBasis.js');
const ejs = read('public/js/ai-intake.js');
const orders = read('routes/orders.js');
const assist = read('lib/agentAssist.js');
const client = read('src/app/orders/ai-intake/AiIntakeClient.js');
const form = read('src/app/orders/new/OrderForm.js');

console.log('[판별이 한 곳에 있다]');
check('lib/reservationBasis.js가 있다', libSrc.length > 0);
// Next 페이지가 import해도 안전해야 한다(check-next-page-imports.js와 같은 규칙).
check('DB에 닿지 않는다', !/require\(['"](\.\.?\/)+db['"]\)/.test(libSrc));
check('판별 함수를 내보낸다', /module\.exports = \{[^}]*resolveReservationBasis/.test(libSrc));

console.log('\n[EJS 사본과 규칙이 같다]');
// 두 벌이 갈라지면 같은 문장에 채널마다 다른 라디오가 켜진다.
const grab = (src, name) => (src.match(new RegExp(`${name} = (\\/[^;]+\\/)`)) || [])[1];
const libDelivery = grab(libSrc, 'DELIVERY_TIME_HINT_RE');
const ejsDelivery = grab(ejs, 'DELIVERY_TIME_HINT_RE');
check('도착 기준 낱말이 같다', !!libDelivery && libDelivery === ejsDelivery,
  `lib ${libDelivery} / EJS ${ejsDelivery}`);
// "일시" 줄만 좁혀 보는 규칙도 같아야 한다 — 이게 갈리면 폼 붙여넣기에서 답이 달라진다.
const lineRe = /raw\.match\(\/일시\[\^\\n\]\*\/\)/;
check('"일시" 줄을 좁혀 보는 규칙이 같다', lineRe.test(libSrc) && lineRe.test(ejs));
check('픽업 낱말이 같다', /\/픽업\/\.test\(line\)/.test(libSrc) && /\/픽업\/\.test\(line\)/.test(ejs));
// 즉시 낱말도 두 곳에 있다(lib/kakaoIntakeParser.js와 routes/orders.js). 원래 있던 사본이다.
const immParser = grab(read('lib/kakaoIntakeParser.js'), 'IMMEDIATE_WORDING_RE');
const immRoute = grab(orders, 'IMMEDIATE_WORDING_RE');
check('즉시 낱말이 두 사본에서 같다', !!immParser && immParser === immRoute,
  `parser ${immParser} / route ${immRoute}`);

console.log('\n[서버가 폼이 쓰는 값으로 내려준다]');
check('parse 응답이 예약 기준을 싣는다', /fields\.reservation_basis = reservationBasis/.test(orders));
check('그 값을 lib에서 받는다', /resolveReservationBasis\(\{ immediate:/.test(orders));
check("lib을 require한다", /require\('\.\.\/lib\/reservationBasis'\)/.test(orders));
// 되묻기를 거절해 즉시로 확정되는 경로도 같은 값을 실어야 한다.
check('되묻기 거절 경로도 싣는다', /reservation_immediate: true,[\s\S]{0,600}?reservation_basis: 'immediate'/.test(orders));
// 못 알아본 경우엔 아무것도 안 실어서 폼 기본값에 둔다 — 빈 문자열을 실으면 라디오가 꺼진다.
check('못 알아보면 싣지 않는다', /if \(reservationBasis\) fields\.reservation_basis/.test(orders));

console.log('\n[공용 변환기도 싣는다]');
// toIntakeFields는 카카오·상담관리 접수 미니폼·Next 서버 턴이 같이 쓴다.
check('toIntakeFields가 즉시를 넘긴다',
  /reservation\.immediate \? \{ reservation_basis: 'immediate' \} : \{\}/.test(assist));

console.log('\n[Next가 그 값을 폼까지 나른다]');
check('응답에서 예약 기준을 읽는다', /function reservationBasisOf\(parseData\)/.test(client));
// 예전 형태(reservation_immediate)도 같이 받는다 — EJS가 쓰는 값이라 서버가 계속 내려준다.
check('예전 형태도 받는다', /parseData\.reservation_immediate/.test(client));
// 세 값만 받는다. 아무 문자열이나 통과시키면 라디오가 조용히 안 켜진다.
check('알 수 없는 값은 버린다',
  /basis === 'immediate' \|\| basis === 'pickup' \|\| basis === 'delivery'/.test(client));
// 수집 항목에 섞으면 확인 요약과 draft에 뜻 모를 줄이 늘어난다 — 폼에만 얹어야 한다.
check('수집 항목에 섞지 않는다',
  !/ORDER_FIELD_IDS = \[[^\]]*reservation_basis/.test(client),
  '수집 항목에 넣으면 확인 요약에 그대로 나온다');
// 프리필 호출부가 아홉 곳이라 한 곳에만 얹으면 나머지에서 조용히 빠진다 — 실측에서
// 파싱이 덜 된 접수가 되묻기 경로로 프리필되며 기준이 빠졌다(2026-09-11). 한 함수로 모은다.
check('프리필을 한 함수로 모았다', /function pushPrefill\(fields\)/.test(client));
check('그 함수가 기준을 얹는다',
  /function pushPrefill\(fields\) \{[\s\S]{0,400}?reservation_basis: basis/.test(client));
const directCalls = (client.match(/onOrderPrefill\(/g) || []).length;
check('직접 부르는 곳이 그 함수 안 하나뿐이다', directCalls === 1,
  `${directCalls}곳 — 래퍼를 건너뛰면 그 경로만 기준이 빠진다`);
// 파싱 직후 한 번 읽어 기억한다. 되묻기 답변엔 기준이 없으므로 매번 다시 읽으면 지워진다.
check('파싱 직후 기억한다', /rememberReservationBasis\(parseData\);/.test(client));
check('서버 턴 결과에서도 기억한다', /rememberReservationBasis\(turnResult\.intake\)/.test(client));
// 새 대화에서 안 비우면 앞 대화의 기준이 다음 접수까지 따라간다.
check('새 대화에서 비운다', /reservationBasisRef\.current = null;/.test(client));

console.log('\n[폼이 라디오를 켠다]');
check('프리필이 예약 기준을 반영한다',
  /setIfFilled\('reservation_basis', p\.reservation_basis\)/.test(form));
check('세 값만 반영한다',
  /p\.reservation_basis === 'immediate' \|\| p\.reservation_basis === 'pickup' \|\| p\.reservation_basis === 'delivery'/.test(form));
// 즉시면 날짜·시각을 지금으로 맞추고 잠그는 처리가 폼에 이미 있다 — 그게 사라지면 무의미해진다.
check('즉시면 날짜·시각을 지금으로 맞춘다', /state\.reservation_basis === 'immediate'/.test(form));

console.log('\n[실제 문장으로 판별해 본다]');
const { resolveReservationBasis } = require('../lib/reservationBasis');
const cases = [
  ['일시 : 07/27 즉시', true, 'immediate', '실사용 접수 문장(2026-09-11 지적 건)'],
  ['일시 : 07/27 18시 30분 도착', false, 'delivery', '도착 기준'],
  ['일시 : 07/27 09:00 픽업', false, 'pickup', '픽업 기준'],
  ['[출발지]\n주소 : 판교역\n[도착지]\n주소 : 강남역', false, null, '기준 표현이 없으면 폼 기본값'],
  ['출발지는 판교역이고 내일 오후 3시까지 도착요망', false, 'delivery', '자유 문장 도착 기준'],
  ['일시 : 내일 오후 3시', false, null, '"일시" 줄에 기준 표현이 없으면 판단하지 않는다'],
];
for (const [text, immediate, want, why] of cases) {
  const got = resolveReservationBasis({ immediate, text });
  check(`${why}`, got === want, `${JSON.stringify(text.slice(0, 34))} → ${got} (기대 ${want})`);
}

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
