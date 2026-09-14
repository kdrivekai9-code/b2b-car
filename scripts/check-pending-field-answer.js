// 되묻는 질문에 온 답을 실제로 알아듣는지 본다.
//
// 왜 필요한가(실사용, 2026-09-13 확인): 챗봇이 "출발지 주소를 알려주세요?"라고 묻고 고객이
// 주소 한 줄만 답하면 그 답이 통째로 버려지고 같은 질문이 반복되다, 3턴이면 "상담원 연결을
// 해드릴까요?"로 밀렸다. :3000(EJS)과 :3001(Next)에서 같은 대화를 나란히 돌려 확인했다 —
// **양 채널 동일**하다. 둘 다 POST /orders/ai-intake/parse 하나를 쓰기 때문이다.
//
// 원인은 폴백 경로다. 그 엔드포인트는 Gemini로 뽑고, 실패하면 규칙 파서(parseIntakeText)로
// 내려가는데 **그 파서는 pendingField를 인자로 받지도 않는다**. 아래 [모델이 죽었을 때]가
// 그 조합을 그대로 재현한다 — 폴백만으로는 못 뽑고, 이 모듈이 붙어야 살아난다.
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

const lib = read('lib/pendingFieldAnswer.js');
const orders = read('routes/orders.js');
const ejs = read('public/js/ai-intake.js');

// **파일 글자를 먼저 본다.** 이 모듈이 db를 require하면 db.js가 모듈 로드 시점에 던지고,
// 아래 require에서 이 검사 스크립트가 통째로 죽는다 — 그러면 무엇이 잘못됐는지 한 줄도
// 못 남기고 종료 코드만 남는다(되돌림 시험에서 실제로 그랬다). 죽는 검사는 배포를 막는
// 근거로 못 쓴다. 그래서 순서를 뒤집어, 원인을 먼저 이름 붙여 보고한다.
console.log('[DB에 닿지 않는다]');
const touchesDb = /require\(['"](\.\.?\/)+db['"]\)/.test(lib);
check('lib이 db를 require하지 않는다', !touchesDb,
  'db.js는 모듈 로드 시점에 던진다 — 이 모듈을 쓰는 화면·검사가 같이 죽는다');

let readPendingFieldAnswer;
let parseIntakeText;
try {
  ({ readPendingFieldAnswer } = require('../lib/pendingFieldAnswer'));
  ({ parseIntakeText } = require('../lib/aiIntakeParser'));
} catch (e) {
  check('모듈을 불러올 수 있다', false, e.message);
  console.log(`\n${failed}건 실패`);
  process.exit(1);
}


// [되묻기 답, pendingField, 채워져야 할 응답 칸, 값]
const ANSWERS = [
  ['origin_address', '경기 성남시 분당구 판교역로 166', 'origin_address', '경기 성남시 분당구 판교역로 166'],
  ['destination_address', '판교역 1번출구', 'destination_address', '판교역 1번출구'],
  ['origin_contact', '010-1111-2222', 'origin_contact', '010-1111-2222'],
  ['destination_contact', '010 3333 4444', 'destination_contact', '010-3333-4444'],
  ['vehicle_number', '12가 3456', 'origin_vehicle_number', '12가3456'],
  ['vehicle_type', '카니발', 'vehicle_type', '카니발'],
];

console.log('[모델이 죽었을 때 — 라우트의 폴백 경로를 그대로 재현한다]');
for (const [pending, text, field, value] of ANSWERS) {
  // 라우트는 Gemini가 실패하면 fields = parseIntakeText(text)로 내려간다.
  const fallbackFields = parseIntakeText(text);
  const answer = readPendingFieldAnswer(pending, text);
  const filled = answer && !String(fallbackFields[answer.field] || '').trim()
    ? { ...fallbackFields, [answer.field]: answer.value }
    : fallbackFields;
  check(`${pending} ← ${JSON.stringify(text)}`,
    String(filled[field] || '') === value,
    `폴백만: ${JSON.stringify(fallbackFields[field] || '')} / 이 모듈까지: ${JSON.stringify(filled[field] || '')} (기대 ${JSON.stringify(value)})`);
}

console.log('\n[답이 아닌 것은 값으로 삼지 않는다]');
// 이걸 값으로 받으면 "상담원"이 출발지 주소가 된다.
const NOT_ANSWERS = [
  ['origin_address', '상담원 연결해줘', '상담원 연결 요청'],
  ['origin_address', '요금이 얼마예요?', '질문'],
  ['origin_address', '네', '확인 답변'],
  ['origin_contact', '모르겠어요', '전화번호가 아님'],
  ['vehicle_number', '몰라요', '차량번호가 아님'],
  ['origin_address', '탁송 접수합니다.\n\n출발 : 판교역\n도착 : 강남역', '새 접수 본문'],
  ['origin_address', '[출발지]\n주소 : 판교역\n[도착지]\n주소 : 강남역', '새 접수 본문(대괄호)'],
  ['reserved_date', '내일 오후 3시', '예약일시는 일부러 안 다룬다'],
];
for (const [pending, text, why] of NOT_ANSWERS) {
  check(`${why}: ${JSON.stringify(text.slice(0, 24))}`, readPendingFieldAnswer(pending, text) === null);
}

console.log('\n[응답 계약의 칸 이름과 맞는다]');
// 값은 실려 갔는데 화면이 다른 이름을 보면, 같은 질문이 또 나간다.
check('차량번호는 origin_vehicle_number로 넣는다',
  /return \{ field: 'origin_vehicle_number'/.test(lib),
  "EJS는 field.id==='vehicle_number'일 때 data.origin_vehicle_number만 본다");
check('EJS가 그 이름으로 읽는 것이 그대로다',
  /field\.id === 'vehicle_number' \? !!data\.origin_vehicle_number/.test(ejs));
// 나머지 칸은 EJS가 data[field.id]로 그대로 읽는다 — 이름이 같아야 한다.
check('EJS가 나머지는 필드 이름 그대로 읽는다', /: !!data\[field\.id\]/.test(ejs));
// 경유지는 응답 계약이 배열(waypoints)이라 평평한 칸이 없다 — 흉내 내지 않는다.
check('경유지는 다루지 않는다', readPendingFieldAnswer('premium_waypoint_address', '판교역 1번출구') === null);

console.log('\n[라우트가 이 모듈을 쓴다]');
check('require한다', /require\('\.\.\/lib\/pendingFieldAnswer'\)/.test(orders));
check('파싱 결과 뒤에 붙인다', /readPendingFieldAnswer\(pendingField, text\)/.test(orders));
// 모델이 제대로 뽑았으면 그 값이 이겨야 한다.
check('비어 있을 때만 채운다',
  /if \(pendingAnswer && !String\(fields\[pendingAnswer\.field\] \|\| ''\)\.trim\(\)\)/.test(orders),
  '덮어쓰면 모델이 읽은 상세주소·표기가 지워진다');
// 되묻기 답변은 예약일시가 없는 게 당연하다 — "예약 없으면 대리" 규칙이 걸리면 안 된다.
check('되묻는 중에는 규칙 분류를 적용하지 않는다',
  /const intent = \(pendingField \? null : classifyOrderIntentByRule\(text, fields\)\) \|\| fallbackIntent;/.test(orders),
  '그 규칙이 걸려 "010-1111-2222" 같은 답이 전부 proxy_order로 뒤집혔다');

console.log('\n[답을 받은 뒤 다음 항목으로 이어간다]');
// 답을 알아듣는 것만으로는 부족했다(실측 2026-09-13): 출발지 주소·연락처를 받고는 도착지를
// 묻지 않고 바로 "등록할까요?"로 갔다. 고객은 "네"라고 답하는데 폼은 도착지가 비어 저장이
// 막힌다. 값을 받는 자리가 여럿이라(연락처·차량번호 셋·요청사항·주소 후보 선택) 한 곳에만
// 고치면 나머지에서 조용히 빠진다 — 그래서 다음 걸음을 한 함수로 모았다.
const client = read('src/app/orders/ai-intake/AiIntakeClient.js');
check('다음 걸음이 한 함수에 모여 있다', /async function advanceAfterValue\(sid, nextFields/.test(client));
check('빈 필수 항목이 있으면 그걸 묻는다',
  /async function advanceAfterValue[\s\S]{0,900}?const missing = firstMissingField\(nextFields\);[\s\S]{0,400}?setPendingField\(missing\.id\)/.test(client));
check('없으면 확인 단계로 간다',
  /async function advanceAfterValue[\s\S]{0,1800}?setPhase\('confirming'\)/.test(client));
// makeDraftState는 React 상태를 그대로 읽는다. 부르는 쪽이 바로 앞줄에서 후보 선택을
// 지웠어도 그 값은 아직 반영되지 않아, 그대로 저장하면 복원했을 때 "1번/2번을 골라주세요"에
// 멈춰 있는 대화가 된다 — 이 함수를 만들면서 실제로 한 번 넣었던 결함이다.
check('저장하는 draft에서 후보 선택을 비운다',
  /const CLEARED_DISAMBIGUATION = \{ pendingDisambiguation: null, disambiguationQueue: \[\] \};/.test(client)
  && (client.match(/\.\.\.CLEARED_DISAMBIGUATION/g) || []).length >= 2);

// 값을 받는 자리가 제 마음대로 확인 단계로 건너뛰면 사슬이 거기서 끊긴다.
const collectIdx = client.indexOf('async function handleCollectingPhase(');
const collectEnd = client.indexOf('\n  async function ', collectIdx + 10);
const collectBody = collectIdx >= 0 ? client.slice(collectIdx, collectEnd > 0 ? collectEnd : undefined) : '';
check('되묻기 본문을 찾았다', collectBody.length > 500, `${collectBody.length}자`);
const strays = (collectBody.match(/setPhase\('confirming'\)/g) || []).length;
check('되묻기 본문이 직접 확인 단계로 건너뛰지 않는다', strays === 0,
  `${strays}곳 — 그 경로만 다음 항목을 안 묻는다`);

console.log('\n[고객이 넘긴 항목은 다시 묻지 않는다]');
// 차량번호를 "출발지에서 확인"으로 넘기면 그 칸은 빈 채로 남는다. 기억해두지 않으면
// 위 사슬이 빈 필수 항목을 보고 같은 질문을 무한히 던진다.
check('넘긴 항목을 기억한다', /declinedFieldsRef/.test(client));
check('빈 항목을 고를 때 그걸 건너뛴다',
  /function firstMissingField[\s\S]{0,400}?declinedFieldsRef\.current\.has\(field\.id\)/.test(client));
check('차량번호를 넘길 때 기억에 넣는다',
  (client.match(/declinedFieldsRef\.current\.add\('vehicle_number'\)/g) || []).length >= 2,
  '건너뛰기와 형식 실패 두 경로 모두에서 넣어야 한다');
// 안 비우면 앞 대화에서 넘긴 항목이 다음 접수까지 따라간다.
check('새 대화에서 비운다', /declinedFieldsRef\.current = new Set\(\);/.test(client));

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
