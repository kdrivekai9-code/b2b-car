// 상담원 연결 제안 중에 사용자가 "네/아니요" 대신 원래 질문의 답을 보냈을 때,
// 그 답이 버려지지 않고 받아들여지는지 확인한다.
//
// 왜: 2026-08-14 세션 923 실측에서 실제로 버려졌다.
//   09:43:47 고객  48조94233                 (형식이 틀린 차량번호)
//   09:43:47 봇    잘못된 차량번호입니다 / 더 빠른 처리를 위해 상담원 연결을 해드릴까요?
//   09:43:54 고객  123가4949                 ← 정정한 번호. 형식이 맞다.
//   09:43:54 봇    상담원 연결이 필요하시면 "네" ...   ← 답을 버리고 되물었다
//   09:44:04 고객  아니오
//   09:44:17 고객  48조9416                  ← 번호를 또 입력
// 고객 입장에서는 정정한 번호를 두 번 친 셈이고, 3턴이 낭비됐다.
//
// 화면 코드는 DOM에 묶여 있어 그대로 돌릴 수 없으므로, 두 화면(EJS/Next)이 같은 규칙을
// 갖고 있는지를 소스에서 확인한다 — 한쪽만 고쳐져 갈라지는 것을 막는 것이 이 검사의 목적이다.
//
//   node scripts/check-offer-agent-answer.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EJS = fs.readFileSync(path.join(ROOT, 'public/js/ai-intake.js'), 'utf8');
const NEXT = fs.readFileSync(path.join(ROOT, 'src/app/orders/ai-intake/AiIntakeClient.js'), 'utf8');

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}`);
  if (!ok) console.log(`         기대: ${JSON.stringify(expected)}\n         실제: ${JSON.stringify(actual)}`);
}

// 각 화면의 offer_agent 처리 본문만 떼어낸다.
function offerAgentBody(src, startMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`${startMarker}를 찾지 못했습니다.`);
  // 다음 함수 선언 전까지를 본문으로 본다.
  const rest = src.slice(start + startMarker.length);
  const end = rest.search(/\n  (?:async )?function /);
  return rest.slice(0, end === -1 ? rest.length : end);
}

console.log('[두 화면 모두 답을 받아들인다]');
const ejsBody = offerAgentBody(EJS, 'function handleOfferAgentPhase(text) {');
const nextBody = offerAgentBody(NEXT, 'async function handleOfferAgentPhase(sid, text) {');

check('EJS: 차량번호 형식이면 되묻지 않는다', /VEHICLE_NUMBER_RE\.test/.test(ejsBody), true);
check('Next: 차량번호 형식이면 되묻지 않는다', /VEHICLE_NUMBER_RE\.test/.test(nextBody), true);
check('EJS: 원래 상태로 복구한 뒤 처리한다', /resumeFromOfferAgent\(\)[\s\S]{0,200}handleVehicleNumberPendingReply/.test(ejsBody), true);
check('Next: 원래 상태로 복구한 뒤 처리한다', /setPendingField\(resumeField\)[\s\S]{0,300}handleCollectingPhase\(sid, text, resumeField\)/.test(nextBody), true);

console.log('\n[되묻기는 마지막 수단으로 남아 있다]');
// 형식이 확실한 필드에서만 지름길을 쓴다 — 아무 텍스트나 받으면 제안과 실패가 무한히 오간다.
check('EJS: 그래도 되묻는 경로가 있다', /getOfferAgentClarifyText\(\)/.test(ejsBody), true);
check('Next: 그래도 되묻는 경로가 있다', /상담원 연결이 필요하시면/.test(nextBody), true);

console.log('\n[지름길이 답보다 먼저 오지 않는다]');
// "네"/"아니요"가 여전히 우선이어야 한다. 순서가 뒤집히면 "네"가 차량번호로 해석될 일은
// 없지만(형식 불일치) 의도는 분명히 해둔다.
const ejsAffirmAt = ejsBody.indexOf('isAffirmative');
const ejsShortcutAt = ejsBody.indexOf('VEHICLE_NUMBER_RE');
check('EJS: 긍정 판정이 지름길보다 앞', ejsAffirmAt >= 0 && ejsAffirmAt < ejsShortcutAt, true);
const nextAffirmAt = nextBody.indexOf('isAffirmative');
const nextShortcutAt = nextBody.indexOf('VEHICLE_NUMBER_RE');
check('Next: 긍정 판정이 지름길보다 앞', nextAffirmAt >= 0 && nextAffirmAt < nextShortcutAt, true);

console.log('\n[실사고 입력이 형식 검사를 통과한다]');
// 세션 923에서 버려진 그 값이 "형식이 맞는 번호"임을 못박는다.
const EJS_RE = /^(?:[가-힣]{2})?(?:\d{2}|\d{3})[가-힣]\d{4}$/;
const NEXT_RE = /\d{2,3}[가-힣]\d{4}$/;
check('EJS 정규식: 123가4949는 유효', EJS_RE.test('123가4949'), true);
check('Next 정규식: 123가4949는 유효', NEXT_RE.test('123가4949'), true);
check('EJS 정규식: 48조94233은 무효(원래 오류)', EJS_RE.test('48조94233'), false);
check('Next 정규식: 48조94233은 무효(원래 오류)', NEXT_RE.test('48조94233'), false);
check('"네"는 차량번호로 오인되지 않는다', EJS_RE.test('네') || NEXT_RE.test('네'), false);

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
