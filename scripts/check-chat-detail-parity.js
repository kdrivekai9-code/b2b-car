// 상담 상세(/chat/sessions/:id)가 EJS와 같은 두 칸인지 본다.
//
// 왜 필요한가: Next로 이식하면서 감싸는 칸(.chat-workspace-grid)과 **둘째 칸이 통째로**
// 빠졌다. 그 칸은 "접수 마무리 섹션은 상담관리 화면(카드 보기)으로 이동되었습니다" 안내와
// `상담관리에서 접수하기` 버튼 하나인데, 그게 없으니 상담원이 이 화면에서 접수로 가는 길을
// 잃는다. 머리말의 "AI 접수 화면"은 고객용 챗봇 화면이라 가리키는 곳이 다르다.
//
// 화면은 멀쩡히 떠서 오류로 안 잡혔다 — AI 챗봇 화면에서 좌우 배치가 세로로 쌓였던 것과
// 같은 종류다(감싸는 칸이 없으면 블록 요소가 세로로 흐를 뿐, 아무도 던지지 않는다).
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

const next = read('src/app/chat/sessions/SessionDetailView.js');
const ejs = read('views/chat/session_detail.ejs');
const css = read('public/css/style.css');

console.log('[두 칸 구조가 양쪽에 있다]');
for (const [label, src, wrap, chat, order] of [
  ['EJS', ejs, 'class="chat-workspace-grid"', 'class="card chat-workspace-chat"', 'class="card chat-workspace-order"'],
  ['Next', next, 'className="chat-workspace-grid"', 'className="card chat-workspace-chat"', 'className="card chat-workspace-order"'],
]) {
  check(`${label}: 감싸는 칸이 있다`, src.includes(wrap), '없으면 칸이 세로로 쌓인다');
  check(`${label}: 대화 칸이 있다`, src.includes(chat));
  check(`${label}: 접수 마무리 칸이 있다`, src.includes(order));
  // 그리드는 소스 순서대로 칸을 채운다 — 대화가 먼저 나와야 왼쪽이다.
  check(`${label}: 대화가 먼저 나온다`, src.indexOf(chat) > 0 && src.indexOf(chat) < src.indexOf(order));
}
// 칸 나누기는 공용 CSS에 있다 — 양쪽이 같은 규칙을 본다.
check('CSS에 두 칸 규칙이 있다',
  /\.chat-workspace-grid\{display:grid;grid-template-columns:[^;]+;/.test(css));

console.log('\n[접수로 가는 길이 같은 곳을 가리킨다]');
// 한쪽만 바뀌면 화면에 따라 다른 곳으로 간다.
for (const [label, src] of [['EJS', ejs], ['Next', next]]) {
  check(`${label}: 카드 보기로 보낸다`, /href="\/chat\/sessions\?view=card"/.test(src));
  check(`${label}: 버튼 문구가 같다`, src.includes('상담관리에서 접수하기'));
  check(`${label}: 안내 문구가 같다`, src.includes('접수 마무리 섹션은 상담관리 화면(카드 보기)으로 이동되었습니다'));
  // 머리말의 챗봇 화면 링크는 그것대로 둘 다 있어야 한다(서로 다른 곳이다).
  check(`${label}: 챗봇 화면 링크도 그대로다`, /href="\/orders\/ai-intake"/.test(src));
}

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
