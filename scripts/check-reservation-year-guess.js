// 연도를 우리가 추정했을 때 확인 문구에 그 사실이 붙는지 본다.
//
// 왜 필요한가: 고객은 "07/27"처럼 연도를 안 적는다. 그 날짜가 올해 기준으로 지났으면 내년으로
// 넘기는데, 확인 문구에는 결과만 "2027-07-27"로 찍혀서 고객은 그게 자기가 말한 값인지 우리가
// 민 값인지 알 수 없다. 실제로 그렇게 접수돼 1년 뒤 예약으로 콜마너까지 등록된 건이 있다
// (OID2075, 2026-09-07).
//
// lib/intakeSummary.js는 경고를 붙일 준비가 되어 있었고 카카오 경로는 잘 나왔는데,
// **웹 챗봇만 빠져 있었다**(EJS·Next 둘 다). 그 경로는 Gemini가 연도까지 정해 내려주므로
// "밀었다"는 신호 자체가 없다. 그래서 서버가 결과로 되짚어 내려주고, 화면이 확인 요약을
// 청할 때 그대로 돌려준다 — reservation_immediate와 같은 흐름이다.
//
// 값이 지나가는 고리가 다섯이라(판단 → parse 응답 → 화면이 기억 → 요약 요청 → 공용 모듈)
// 하나만 끊겨도 경고가 조용히 사라진다. 다섯을 다 본다.
//
// 모델·DB를 부르지 않는다 — CI에서 돌 수 있다.
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

const lib = read('lib/reservationYearGuess.js');
const orders = read('routes/orders.js');
const summary = read('lib/intakeSummary.js');
const nextClient = read('src/app/orders/ai-intake/AiIntakeClient.js');
const ejs = read('public/js/ai-intake.js');

console.log('[판단 규칙]');
// 이 모듈을 쓰는 화면이 있으므로 db에 닿으면 안 된다(db.js는 모듈 로드 시점에 던진다).
check('DB에 닿지 않는다', !/require\(['"](\.\.?\/)+db['"]\)/.test(lib));

let reservedYearGuessed;
try {
  ({ reservedYearGuessed } = require('../lib/reservationYearGuess'));
} catch (e) {
  check('모듈을 불러올 수 있다', false, e.message);
  console.log(`\n${failed}건 실패`);
  process.exit(1);
}

const Y = new Date(Date.now() + 9 * 3600 * 1000).getUTCFullYear();
const CASES = [
  ['일시 : 07/27 09:00', `${Y}-07-27`, false, '올해로 잡혔으면 민 적이 없다'],
  ['일시 : 07/27 09:00', `${Y + 1}-07-27`, true, '연도를 안 적었는데 내년이 됐다'],
  [`일시 : ${Y + 1}년 7월 27일`, `${Y + 1}-07-27`, false, '연도를 적어줬다'],
  [`일시 : ${Y + 1}-07-27`, `${Y + 1}-07-27`, false, 'ISO로 적어줬다'],
  ['내년 3월 2일 오전 9시', `${Y + 1}-03-02`, false, '고객이 "내년"이라고 말했다'],
  ['일시 : 즉시', '', false, '날짜가 없으면 판단하지 않는다'],
];
for (const [text, date, want, why] of CASES) {
  check(why, reservedYearGuessed(text, date) === want,
    `${JSON.stringify(text.slice(0, 26))} + ${JSON.stringify(date)} → ${reservedYearGuessed(text, date)} (기대 ${want})`);
}

console.log('\n[서버가 판단해 내려준다]');
check('라우트가 그 모듈을 쓴다', /require\('\.\.\/lib\/reservationYearGuess'\)/.test(orders));
check('parse 응답에 싣는다', /fields\.reservation_year_guessed = true;/.test(orders));
// 즉시 요청은 지금 시각으로 채운 것이라 "연도를 안 적으셔서"가 뜻이 안 맞는다.
check('즉시 요청에는 붙이지 않는다',
  /if \(!fields\.reservation_immediate && reservedYearGuessed\(text, fields\.reserved_date\)\)/.test(orders));
check('요약 엔드포인트가 공용 모듈에 넘긴다',
  /reservedYearGuessed: !!b\.reservation_year_guessed,/.test(orders));
// 받는 쪽이 그 이름을 보고 있어야 한다.
check('공용 모듈이 그 이름으로 경고를 붙인다',
  /data\.reservedYearGuessed \? ' \(연도를 안 적으셔서 내년으로 봤습니다\)'/.test(summary));

console.log('\n[Next 챗봇이 나른다]');
check('파싱 응답에서 받는다', /source\.reservation_year_guessed/.test(nextClient));
check('요약 요청에 싣는다', /reservation_year_guessed: reservationYearGuessedRef\.current,/.test(nextClient));
// 되묻기 답변에는 날짜가 없다 — 턴마다 다시 읽으면 지워진다.
check('대화 내내 들고 간다', /const reservationYearGuessedRef = useRef\(/.test(nextClient));
// 새로고침 한 번에 경고가 사라지면 안 된다.
check('draft에 실어 보낸다', /reservationYearGuessed: reservationYearGuessedRef\.current,/.test(nextClient));
check('draft에서 되살린다', /initialDraftState && initialDraftState\.reservationYearGuessed/.test(nextClient));
check('새 대화에서 비운다', /reservationYearGuessedRef\.current = false;/.test(nextClient));

console.log('\n[EJS 챗봇도 나른다]');
// 부르는 자리가 넷이라 각자 꺼내면 한 곳만 빠져도 조용히 사라진다 — 한 곳으로 모은다.
check('파싱 응답을 한 곳에서 받는다', /function parseTextRemembering\(/.test(ejs));
check('그 함수가 값을 기억한다',
  /function parseTextRemembering[\s\S]{0,400}?data\.reservation_year_guessed\) reservationYearGuessed = true;/.test(ejs));
const direct = (ejs.match(/api\.parseText\(/g) || []).length;
check('그 함수 말고 직접 부르는 곳이 없다', direct === 1,
  `${direct}곳 — 래퍼를 건너뛰면 그 경로만 경고가 빠진다`);
check('요약 요청에 싣는다', /reservation_year_guessed: reservationYearGuessed,/.test(ejs));
check('draft에 저장한다', /reservationYearGuessed: reservationYearGuessed,/.test(ejs));
check('draft에서 되살린다', /reservationYearGuessed = !!draft\.reservationYearGuessed;/.test(ejs));

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
