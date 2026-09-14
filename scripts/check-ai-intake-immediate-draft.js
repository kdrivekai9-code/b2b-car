// 챗봇이 읽은 "즉시"가 **새로고침을 견디는지** 본다.
//
// 왜 필요한가(실사용 지적, 실측 2026-09-14): "일시 : 즉시"로 접수하면 우측 접수폼 라디오가
// 즉시로 켜진다 — 거기까지는 맞다(check-reservation-basis.js가 지키는 범위). 그런데 페이지를
// 다시 열면 픽업 기준으로 돌아가 있었다. 실측 A/B:
//
//     접수 직후      기준=즉시  시각=10:30
//     새로고침 이후  기준=픽업  시각=10:00   ← 고치기 전
//     새로고침 이후  기준=즉시  시각=10:30   ← 고친 뒤
//
// 조용히 틀리는 종류라 더 나쁘다. 시각 칸에는 즉시일 때 채워진 구체 시각이 그대로 남아 있어
// 폼이 비어 보이지 않고, 대화창에는 "일시 : 즉시"가 그대로 보인다. 챗봇은 "아래 오더 폼에서
// '오더 등록' 버튼을 눌러 접수를 완료해주세요"라고 안내하므로 **폼의 라디오가 곧 등록 결과**다
// — 그대로 누르면 즉시 요청이 그 시각 예약 오더가 된다.
//
// 원인은 한 줄짜리 누락이 아니라 경로 셋이 모두 기준을 안 들고 있던 것이다:
//   · reservationBasisRef가 메모리에만 있어 새로고침에 사라진다
//   · draftState에 기준이 실리지 않아 서버에 저장될 값 자체가 없다
//   · toDraftPrefill의 화이트리스트에 reservation_basis가 없어 복원해도 폼에 못 간다
// 셋 중 하나만 빠져도 증상이 그대로 돌아오므로 세 가지를 따로 본다.
//
// 파일을 읽어 확인만 한다 — DB도 모델도 브라우저도 안 부르므로 CI에서 돌 수 있다.
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

const client = read('src/app/orders/ai-intake/AiIntakeClient.js');
const workspace = read('src/app/orders/ai-intake/AiIntakeWorkspace.js');
const form = read('src/app/orders/new/OrderForm.js');

console.log('[기준을 draft에 싣는다]');
// 길목은 saveBotTurn 하나다 — draftState를 만드는 자리가 여덟 곳이라 거기서 각각 얹으면
// 한 곳이 빠진다. 실제로 그렇게 빠져 있었다.
check('saveBotTurn이 draftState에 reservationBasis를 얹는다',
  /async function saveBotTurn[\s\S]{0,900}?draftState:\s*\{[^}]*reservationBasis/.test(client),
  'saveBotTurn 안에서 draftState에 reservationBasis를 넣어야 한다');
check('그 값은 ref에서 온다', /reservationBasis:\s*reservationBasisRef\.current/.test(client));
// 서버는 draftState를 통째로 JSON으로 저장한다(routes/chat.js) — 화이트리스트가 없으므로
// 얹기만 하면 저장된다. 그 전제가 깨지면 여기가 아니라 그쪽이 바뀐 것이다.
check('서버가 draftState를 통째로 저장한다(전제)',
  /UPDATE chat_sessions SET draft_json = \?/.test(read('routes/chat.js')));

console.log('\n[새로고침 뒤 기준을 되살린다]');
check('reservationBasisRef를 draft에서 초기화한다',
  /reservationBasisRef\s*=\s*useRef\([\s\S]{0,200}?initialDraftState[\s\S]{0,80}?reservationBasis/.test(client),
  'useRef(null)로 두면 새로고침마다 기준이 사라진다');
// 새 대화에서는 반드시 비워야 한다 — 안 그러면 앞 대화의 "즉시"가 다음 접수로 새어 들어간다.
check('새 대화에서는 비운다', /reservationBasisRef\.current = null/.test(client));

console.log('\n[복원한 기준이 폼까지 간다]');
check('toDraftPrefill이 reservation_basis를 실어 보낸다',
  /function toDraftPrefill[\s\S]{0,700}?reservation_basis:\s*basis/.test(workspace),
  '화이트리스트에 없으면 복원해도 폼은 픽업 기준 그대로다');
// 기준은 collectedFields가 아니라 draft 바로 아래에 있다 — fields.reservation_basis를 보면
// 늘 undefined라 조용히 아무것도 안 한다.
check('fields가 아니라 draft에서 읽는다',
  /const basis = initialDraft\.reservationBasis/.test(workspace),
  'fields.reservation_basis에서 읽으면 항상 비어 있다');
check('값은 세 가지만 받는다',
  /basis === 'immediate'[\s\S]{0,90}?basis === 'pickup'[\s\S]{0,90}?basis === 'delivery'/.test(workspace));
check('폼이 그 값을 라디오에 반영한다(전제)',
  /p\.reservation_basis === 'immediate'[\s\S]{0,200}?setIfFilled\('reservation_basis', p\.reservation_basis\)/.test(form));

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
