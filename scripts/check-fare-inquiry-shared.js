// 요금 문의 계산이 한 곳에만 있는지 본다.
//
// 왜 이렇게 했나: Next 챗봇에 요금 문의 흐름이 없었다(격차 목록의 필수 항목). EJS 위젯은 그
// 흐름에 함수 32개·약 933줄을 쓴다 — 그걸 React로 옮기는 것이 첫 계획이었다.
//
// 그런데 **서버에 이미 같은 계산이 있었다.** lib/agentAssist.js buildFareSuggestion을 카카오
// 채널이 같은 목적으로 부른다(routes/kakaoConsult.js tryAnswerFare). 옮기면 같은 계산이 **세
// 벌**이 된다. 이 저장소는 그 실수를 이미 한 번 했다 — 접수 확인 요약을 세 곳이 각자 만들어서
// 옵션(주유·서류)이 카카오 요약에만 들어가는 식으로 항목이 갈렸고, 그래서 lib/intakeSummary.js로
// 모았다.
//
// 그래서 933줄을 옮기는 대신 엔드포인트 하나(POST /orders/ai-intake/fare-inquiry)를 두고 Next가
// 그것을 부른다. 이 검사가 지키는 것은 **그 방향이 유지되는지**다 — 누군가 클라이언트에서 다시
// 계산하기 시작하면 잡는다.
//
// 파일만 읽는다 — CI에서 돌 수 있다.
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

const orders = read('routes/orders.js');
const kakao = read('routes/kakaoConsult.js');
const nextClient = read('src/app/orders/ai-intake/AiIntakeClient.js');
const assist = read('lib/agentAssist.js');

console.log('[계산은 한 곳에만 있다]');
check('요금 계산이 lib/agentAssist에 있다', /async function buildFareSuggestion\(/.test(assist));
check('카카오가 그 함수를 쓴다', /buildFareSuggestion\(/.test(kakao));
check('웹 엔드포인트도 그 함수를 쓴다',
  /fare-inquiry[\s\S]{0,800}buildFareSuggestion\(/.test(orders));
// Next가 요금표·거리·도선 계산을 자기 안에서 하기 시작하면 세 벌이 된다.
for (const bad of ['quoteFareByAddress', 'distanceKm.toFixed', 'hasFerryLeg']) {
  check(`Next가 ${bad}를 직접 다루지 않는다`, !nextClient.includes(bad));
}

console.log('\n[Next가 그 엔드포인트를 부른다]');
check('요금 문의를 시도한다', /\/orders\/ai-intake\/fare-inquiry/.test(nextClient));
check('값싼 관문을 먼저 통과시킨다', /FARE_QUESTION_RE/.test(nextClient));
// 서버와 같은 낱말이어야 한다 — 다르면 한쪽만 잡히는 질문이 생긴다.
const clientRe = (nextClient.match(/const FARE_QUESTION_RE = (\/[^;]+\/)/) || [])[1];
const serverRe = (assist.match(/const FARE_QUESTION_RE = (\/[^;]+\/)/) || [])[1];
check('관문 낱말이 서버와 같다', !!clientRe && clientRe === serverRe, `Next ${clientRe} / 서버 ${serverRe}`);
// 되묻는 중의 "얼마"는 대개 그 답의 일부다 — 거기서 새면 대화가 어긋난다.
check('되묻는 중에는 끼어들지 않는다', /!activePendingField && await tryAnswerFare\(/.test(nextClient));
// 아래 셋은 **tryAnswerFare 본문 안에서** 본다.
//
// 처음에는 함수 이름에서 몇 백 글자 안쪽이라는 창으로 봤는데, 그 함수에 일일기사 시간
// 되묻기 처리가 붙자 창을 벗어나 세 개가 한꺼번에 깨졌다 — 코드는 멀쩡한데 길어졌다는
// 이유로 깨지는 검사는 배포를 막는 근거가 못 된다. 함수 경계로 자른다.
const fareFnIdx = nextClient.indexOf('async function tryAnswerFare(');
const fareFn = nextClient.slice(fareFnIdx, nextClient.indexOf('\n  }\n', fareFnIdx) + 4);
check('tryAnswerFare 본문을 찾았다', fareFnIdx >= 0 && fareFn.length > 200, `${fareFn.length}자`);
// 답을 못 만들면 기존 경로(FAQ → 상담원)가 받아야 한다.
check('답이 없으면 false로 넘긴다',
  /if \(!data \|\| !data\.ok \|\| !data\.text\)[\s\S]{0,200}?return false;/.test(fareFn));
check('실패해도 대화를 막지 않는다', /catch \{[\s\S]{0,200}return false;/.test(fareFn));
// 답은 배차 도우미와 같은 경로로 남긴다(저장·중계·초안 상태가 거기 모여 있다).
check('답을 replyWithMessage로 남긴다', /replyWithMessage\(sid, data\.text/.test(fareFn));

console.log('\n[어느 상품의 요금인지 밝힌다]');
// 실사용(2026-09-08): 금액만 답했더니 고객이 곧바로 "탁송요금이나요?"라고 되물었다 —
// 화면이 답해야 할 것을 고객이 물어야 했다. 이 계산은 거리 기준 탁송 요금표만 본다.
check('답변에 상품명이 있다', /탁송 예상 요금은/.test(assist));
// 상품마다 입력이 다르다: 탁송·프리미엄대리는 거리, 일일기사는 이용 시간이다.
// 시간 기준 요금을 거리로 환산해 추정하면 우리가 만든 숫자가 되고 실제 청구와 어긋난다 —
// 그래서 그 함수에 거리를 넘기지 않는지를 본다(부르는 것 자체는 이제 맞는 동작이다).
check('일일기사 요금을 거리로 추정하지 않는다',
  !/calculatePremiumFare\([^)]*distanceKm/.test(assist), '일일기사는 이용 시간을 받아야 한다');
check('프리미엄대리는 편도 거리 표로 낸다', /calculatePremiumOnewayFare\(/.test(assist));
// 접수 후 안내(routes/kakaoConsult.js)는 상품이 이미 정해져 있어 여기서 이름을 박으면 안 된다 —
// 그 경로는 탁송 등록에서만 불리므로 지금은 문제가 없지만, 프리미엄으로 확장되면 갈린다.
check('접수 후 안내에는 상품명을 박지 않았다',
  !/탁송 예상 요금/.test(kakao), '그 경로가 프리미엄으로 확장되면 잘못된 이름이 나간다');

console.log('\n[엔드포인트가 지켜야 할 것]');
const block = orders.slice(orders.indexOf("router.post('/ai-intake/fare-inquiry'"), orders.indexOf("router.post('/ai-intake/activity'"));
check('모델을 부르므로 사용량 제한을 건다', /aiRateLimit/.test(block));
// 법인 요금표를 먼저 본다 — 카카오 호출부와 같은 순서여야 답이 갈리지 않는다.
check('법인 → 지사 순서로 요금표를 본다', /groupId:[\s\S]{0,120}group_id/.test(block));
check('빈 입력을 걸러낸다', /reason: 'empty'/.test(block));
// 요금을 고객에게 안 보여주는 설정이면 buildFareSuggestion이 null을 준다 — 여기서 다시
// 판단하면 두 곳이 갈린다.
check('노출 여부를 다시 판단하지 않는다', !/visibleToClient/.test(block));

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
