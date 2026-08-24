// 대리운전·일일기사 접수에서 "즉시"가 답으로 처리되는지 확인한다.
//
// 실사용 사고(2026-08-24):
//   고객: "대리운전 호출해줘"  → 봇: 요약에 "· 일시 즉시"를 찍어놓고
//                                  질문은 "예약시간을 말씀해주세요?"      ← 모순
//   고객: "즉시"               → 봇: 같은 질문 반복                      ← 무한 루프
//
// 원인: 날짜·시각을 못 잡으면 무조건 immediate:true로 두면서 reserved_date는 null로 남겼다.
// 요약은 즉시라고 하는데 missing에는 그대로 남아 있으니 계속 물었고, "즉시"라고 답해도
// Gemini가 거기서 날짜를 못 뽑아 같은 상태로 되돌아왔다.
//
// 고친 방향(사용자 확정): 아무 말이 없으면 "아직 모름"이고, 즉시는 고객이 고른 답으로 다룬다.
require('dotenv').config();
const { buildPremiumParsedFromClassified, IMMEDIATE_WORDING_RE } = require('../lib/kakaoIntakeParser');
// 필드 정의는 lib/intakeFields.js가 갖고 있다(웹·카카오가 함께 쓰는 한 벌).
const { getDailyDriverFields } = require('../lib/intakeFields');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

const base = { tripType: 'one_way' };
const parse = (classified, text, overrides) =>
  buildPremiumParsedFromClassified({ ...base, ...classified }, text, { tripType: 'one_way', ...(overrides || {}) });

console.log('[아무 말이 없으면 즉시로 단정하지 않는다]');
// 예전에는 여기서 immediate:true가 되어 요약에 "일시 즉시"가 찍혔다 — 고객은 그렇게 말한 적이 없다.
const bare = parse({}, '대리운전 호출해줘');
check('즉시로 단정하지 않는다', bare.when.immediate, false);
check('예약일시를 묻는다', bare.missing.includes('reserved_date'), true);

console.log('[질문 문구가 "즉시"도 답이 된다고 알린다]');
const field = getDailyDriverFields('one_way').find((f) => f.id === 'reserved_date');
check('예시에 즉시가 있다', /즉시/.test(field.question), true);

console.log('["즉시"라고 답하면 그게 답이다]');
// 이 지름길이 없으면 같은 질문이 무한히 반복된다 — 이번 사고의 핵심이다.
const now = parse({}, '대리운전 호출해줘\n즉시', { immediate: true });
check('즉시로 확정된다', now.when.immediate, true);
check('예약일시를 더 묻지 않는다', now.missing.includes('reserved_date'), false);
check('날짜·시각은 비어 있다', [now.when.date, now.when.time], [null, null]);

console.log('[원문에 즉시 표현이 있으면 그것도 답이다]');
// "지금 바로 대리 불러줘"처럼 첫 문장에 이미 답이 들어 있는 경우.
const inline = parse({}, '지금 바로 대리운전 불러줘');
check('즉시로 확정된다', inline.when.immediate, true);
check('예약일시를 묻지 않는다', inline.missing.includes('reserved_date'), false);

console.log('[예약 시각을 말하면 그대로 쓴다]');
const scheduled = parse({ reservationDate: '2026-08-25', reservationTime: '15:00' }, '내일 오후 3시 대리');
check('즉시가 아니다', scheduled.when.immediate, false);
check('시각이 들어간다', [scheduled.when.date, scheduled.when.time], ['2026-08-25', '15:00']);
check('예약일시를 묻지 않는다', scheduled.missing.includes('reserved_date'), false);

console.log('[즉시 표현 판정]');
['즉시', '지금 바로', '최대한 빨리', '현재'].forEach((t) => {
  check(`"${t}"는 즉시`, IMMEDIATE_WORDING_RE.test(t), true);
});
// 시각을 말한 답까지 즉시로 삼키면 예약이 지금 호출로 바뀐다 — 그건 막아야 한다.
['내일 오후 3시', '25일 2시', '없어'].forEach((t) => {
  check(`"${t}"는 즉시가 아니다`, IMMEDIATE_WORDING_RE.test(t), false);
});

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
