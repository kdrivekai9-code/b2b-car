// 지나간 날짜로 예약하려 하면 등록 전에 되묻는지.
//
// 왜 필요한가(실측 2026-09-08): 9월에 들어온 "07/27"이 2027-07-27로 밀려 접수되고 콜마너까지
// 등록됐다(OID2075). 확인 문구에는 결과만 찍혀서, "네"를 누른 사람은 자기가 적은 날짜가 그대로
// 있는 줄 알았다. 밀렸다고 알리는 것만으로는 부족하다 — 물어봐야 한다.
//
// 관문이 채널마다 따로 있어서(카카오 상담톡·웹 챗봇 접수턴·웹 접수장 브라우저 흐름) 한 곳에만
// 넣으면 같은 문장이 화면에 따라 등록되기도 하고 되묻기도 한다. 판단은 lib/reservationReask.js
// 한 곳에서 하고, 각 채널이 그것을 부르는지 여기서 확인한다.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { needsDateReask, buildDateQuestion, applyDateAnswer, buildRetryQuestion } = require('../lib/reservationReask');
const { FAR_FUTURE_DAYS } = require('../lib/reservationSanity');
const { parseKakaoIntake } = require('../lib/kakaoIntakeParser');
const { kstNow, toDateStr } = require('../lib/period');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`}`);
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const now = kstNow();
const shift = (days) => new Date(now.getTime() + days * 86400000);
const md = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;

function form(dateText) {
  return `[출발지]\n일시 : ${dateText} 18시 30분 도착\n차량번호 : 토레스 150두8774\n`
    + `주소 : 서울 양천로 53길 30\n연락처 : 010-8116-1240\n\n`
    + `[도착지]\n주소 : 경기 화성시 병점구 진안동 922-1\n연락처 : 010-3094-3523`;
}
const whenOf = (dateText) => parseKakaoIntake(form(dateText)).when;

console.log('[무엇을 되묻는가]');
// 연도가 없어 내년으로 밀렸고, 그 결과가 상식 범위를 넘었다 — 고객은 올해로 말한 것이다.
const far = needsDateReask(whenOf(md(shift(-40))));
check('올해 기준 지난 날짜(연도 없음)', [far.ask, far.reason], [true, 'rolled_far']);

// 연도를 적어 지난 날짜를 지정했다 — 밀지 않으니 그대로 등록되면 조회에서 영영 안 나온다.
const past = needsDateReask({ immediate: false, date: toDateStr(shift(-10)), dateRolled: false });
check('연도를 적은 지난 날짜', [past.ask, past.reason], [true, 'past']);

console.log('\n[무엇을 그냥 쓰는가]');
// 연말 넘김 — 12/28에 "1/3"은 며칠 뒤가 된다. 이걸 되물으면 정상 요청마다 턴이 하나 늘어난다.
const yearEnd = needsDateReask({ immediate: false, date: toDateStr(shift(6)), dateRolled: true });
check(`밀렸지만 ${FAR_FUTURE_DAYS}일 안(연말 넘김)`, yearEnd.ask, false);
check('평범한 미래 날짜', needsDateReask(whenOf(md(shift(12)))).ask, false);
check('오늘', needsDateReask(whenOf('오늘')).ask, false);
// "즉시"는 날짜가 아니라 "지금"이다(resolveReservation이 오늘로 되돌린다).
check('즉시 요청', needsDateReask({ immediate: true, date: toDateStr(shift(-40)), dateRolled: true }).ask, false);
check('날짜를 못 잡은 경우', needsDateReask({ immediate: false, date: null }).ask, false);

console.log('\n[되묻기 문구]');
const q = buildDateQuestion(far, whenOf(md(shift(-40))));
// 고객이 적은 표현을 되읽어줘야 무엇을 고쳐야 하는지 안다.
check('말한 일시를 되읽는다', q.includes(md(shift(-40))), true);
check('다시 알려달라고 한다', /다시 알려주세요/.test(q), true);
// 예시가 굳은 날짜면 언젠가 "지난 날짜"를 예시로 드는 문구가 된다.
const example = (q.match(/\(예: (\d{1,2})월 (\d{1,2})일/) || []).slice(1).map(Number);
check('예시가 미래다', example.length === 2, true);

console.log('\n[답 해석]');
const good = applyDateAnswer(whenOf(md(shift(-40))), `${md(shift(12))} 14시`);
check('정상 날짜를 받는다', [good.ok, good.when.date, good.when.time],
  [true, toDateStr(shift(12)), '14:00']);
// 확정했으므로 추정 표시가 남으면 안 된다 — 확인 문구에 "내년으로 봤습니다"가 또 붙는다.
check('추정 표시를 지운다', good.when.dateRolled, false);
// 시각을 안 적으면 원래 말한 시각을 지킨다.
const timeless = applyDateAnswer(whenOf(md(shift(-40))), md(shift(12)));
check('시각은 원래 값을 유지', timeless.when.time, '18:30');
check('못 알아들은 답', applyDateAnswer(null, '글쎄요').reason, 'unparsed');
check('또 지난 날짜', applyDateAnswer(null, toDateStr(shift(-10))).reason, 'still_past');
check('재질문 문구가 이유를 말한다', /지난 날짜/.test(buildRetryQuestion({ reason: 'still_past', date: toDateStr(shift(-10)) })), true);

console.log('\n[채널마다 관문이 있는가]');
const kakao = read('routes/kakaoConsult.js');
check('카카오 탁송', /const reask = needsDateReask\(parsed\.when\)/.test(kakao), true);
check('카카오 프리미엄/일일기사', /const reaskPremium = needsDateReask\(parsed\.when\)/.test(kakao), true);
// 답을 받는 자리가 없으면 질문만 하고 영원히 못 받는다.
check('카카오 답 처리', /pending\.awaiting === 'reserved_date'\) return handleReservedDateReply/.test(kakao), true);
// 스몰토크·배차 도우미·LLM 재분류보다 먼저 봐야 한다(confirm과 같은 이유).
check('카카오 앞단 가로채기', /confirmPending\.awaiting === 'reserved_date'/.test(kakao), true);

const web = read('lib/webIntakeTurn.js');
check('웹 탁송', /const reask = needsDateReask\(parsed\.when\)/.test(web), true);
check('웹 프리미엄/일일기사', /const reaskPremium = needsDateReask\(parsed\.when\)/.test(web), true);
check('웹 답 처리', /pending\.awaiting === 'reserved_date'/.test(web), true);

// 접수장(브라우저) 흐름은 Gemini가 준 절대 날짜를 그대로 폼에 채운다 — 지난 날짜면 여기서도 묻는다.
const client = read('public/js/ai-intake.js');
check('접수장 챗봇 판정', /function reservedDateProblem\(/.test(client), true);
check('접수장 챗봇 되묻기', /function askReservedDateAgain\(/.test(client), true);
check('접수장 챗봇 — 탁송 진입점', /var datePast = reservedDateProblem\(data\)/.test(client), true);
check('접수장 챗봇 — 프리미엄 진입점', /var premiumDatePast = reservedDateProblem\(data\)/.test(client), true);
check('접수장 챗봇 — 일일기사 진입점', /var ddDatePast = reservedDateProblem\(data\)/.test(client), true);

console.log('\n[폼 제출 확인이 EJS·Next 양쪽에 있는가]');
// 같은 화면이 두 벌이라(플래그 전환) 한쪽에만 있으면 되묻기가 켜졌다 꺼졌다 한다 —
// 실제로 Next 폼에만 있었다(2026-09-08 발견).
const nextForm = read('src/app/orders/new/OrderForm.js');
const ejsForm = read('public/js/order-form.js');
check('Next 폼', /reservationSanity\.describe\(reservedDate\)/.test(nextForm), true);
check('EJS 폼', /reservedDateSanityMessage\(/.test(ejsForm), true);
check('EJS 폼도 같은 문구로 묻는다', /이대로 접수할까요/.test(ejsForm), true);
// 두 폼이 같은 임계값을 써야 한다.
check('EJS 폼 임계값이 서버와 같다',
  [/SANITY_FAR_FUTURE_DAYS = 90/.test(ejsForm), /SANITY_PAST_LIMIT_DAYS = 180/.test(ejsForm)], [true, true]);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
