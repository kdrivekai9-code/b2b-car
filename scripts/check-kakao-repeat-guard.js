// 카카오 반복 문구 판정에서 짧은 답을 빼는 규칙을 확인한다.
//
// 반복 판정은 과거 이벤트의 payload_json을 LIKE로 훑는다. 텍스트가 짧으면 아무 이벤트에나
// 걸려서, 고객이 주소 후보를 "1"로 고르면 봇이 침묵했다 — 주소 확정 기능이 통째로 멈췄다.
// 반대로 너무 많이 빼면 원래 막으려던 "네"·"확인부탁드립니다" 연속 발송에 봇이 두 번 답한다.
// 그 경계를 못박는다.
//
//   node scripts/check-kakao-repeat-guard.js
const { isTooShortForRepeatCheck } = require('../routes/kakaoConsult');

let failed = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}`);
  if (!ok) console.log(`         기대: ${expected}, 실제: ${actual}`);
}

console.log('[반복 판정에서 빼야 하는 답]');
// 주소 후보·선택지 번호. 이게 걸리면 고객이 골라도 봇이 아무 말을 안 한다.
check('"1"', isTooShortForRepeatCheck('1'), true);
check('"2."', isTooShortForRepeatCheck('2.'), true);
check('"3)"', isTooShortForRepeatCheck('3)'), true);
check('" 1 "(공백 포함)', isTooShortForRepeatCheck(' 1 '), true);
check('"네"', isTooShortForRepeatCheck('네'), true);
check('빈 문자열', isTooShortForRepeatCheck(''), true);
check('null', isTooShortForRepeatCheck(null), true);

console.log('\n[반복 판정을 그대로 적용할 답]');
// 이런 문장이 연달아 오는 걸 막으려고 만든 판정이다 — 여기까지 빼면 봇이 두 번 답한다.
check('"확인부탁드립니다"', isTooShortForRepeatCheck('확인부탁드립니다'), false);
check('"감사합니다"', isTooShortForRepeatCheck('감사합니다'), false);
check('접수 문장', isTooShortForRepeatCheck('판교역에서 사당역까지 탁송 부탁드립니다'), false);
check('차량번호', isTooShortForRepeatCheck('48조9416'), false);

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exitCode = failed ? 1 : 0;
