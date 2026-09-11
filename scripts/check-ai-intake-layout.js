// AI 챗봇 화면이 좌(대화) / 우(접수 폼) 두 칸으로 놓이는지 본다.
//
// 왜 필요한가(실사용 지적 2026-09-11): Next 판으로 넘어가면서 대화가 위, 접수 폼이 아래로
// **세로로 쌓였다.** EJS는 .ai-intake-grid로 세 칸(대화 | 접수내용 | 요금·지도)을 만드는데
// Next의 AiIntakeWorkspace는 두 컴포넌트를 그냥 나란히 return했다 — 감싸는 칸이 없으면
// 블록 요소가 세로로 흐른다. 화면은 멀쩡히 떠서 오류로 잡히지 않았다.
//
// Next는 /orders/new의 오더 폼을 통째로 재사용하고 그 폼이 요금·지도를 이미 품고 있어
// 칸이 둘이다. 그래서 .ai-intake-grid(세 칸)를 쓰면 셋째 칸이 빈다 — 전용 규칙
// .ai-intake-workspace를 따로 둔 이유다.
//
// 같이 지키는 것: 이관 중 자기점검용으로 붙여둔 카드(MIGRATION PREVIEW 등)가 고객 화면에
// 남지 않는지. 플래그를 켠 뒤에는 그게 그대로 고객에게 보였다.
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

const workspace = read('src/app/orders/ai-intake/AiIntakeWorkspace.js');
const page = read('src/app/orders/ai-intake/page.js');
const css = read('public/css/style.css');

console.log('[대화와 접수 폼이 한 칸 안에 나란히 있다]');
// 감싸는 요소가 없으면(<> … </>) 세로로 쌓인다. 그게 이 검사가 막는 것이다.
check('두 칸 래퍼로 감싼다', /<div className="ai-intake-workspace">/.test(workspace),
  '래퍼가 없으면 대화 아래로 접수 폼이 쌓인다');
const chatIdx = workspace.indexOf('<AiIntakeClient');
const formIdx = workspace.indexOf('<OrderForm');
check('대화와 접수 폼이 둘 다 그 안에 있다', chatIdx > 0 && formIdx > 0);
// 그리드는 소스 순서대로 칸을 채운다 — 대화가 먼저 나와야 왼쪽이다.
const wrapIdx = workspace.indexOf('<div className="ai-intake-workspace">');
check('대화가 먼저 나온다(= 왼쪽)', wrapIdx >= 0 && wrapIdx < chatIdx && chatIdx < formIdx,
  `래퍼 ${wrapIdx} / 대화 ${chatIdx} / 폼 ${formIdx}`);
// 폼 쪽은 칸 하나로 묶여야 한다 — 안내문과 폼이 따로 그리드 자식이 되면 세 칸이 된다.
check('폼 쪽은 한 칸으로 묶여 있다', /<div className="ai-intake-workspace-order">/.test(workspace));
check('세로로 쌓던 인라인 여백을 쓰지 않는다', !/<div style=\{\{ marginTop: 16 \}\}>/.test(workspace));

console.log('\n[칸 나누기가 CSS에 있다]');
const media = (css.match(/@media \(min-width:1301px\)\{[^@]*?\.ai-intake-workspace\{[^}]*\}[\s\S]*?\n\}/) || [])[0] || '';
check('넓은 화면 규칙 안에 있다', media.length > 0, '.ai-intake-workspace를 담은 min-width:1301px 블록을 못 찾았다');
check('두 칸 그리드다', /\.ai-intake-workspace\{[^}]*display:grid[^}]*grid-template-columns:[^;]*minmax\([^)]*\) minmax\([^)]*\);/.test(media),
  '칸이 둘이어야 한다 — .ai-intake-grid(세 칸)를 재사용하면 셋째 칸이 빈다');
// 오더 폼의 세 칸은 최소폭 합이 970px이라 좁아진 칸에서 가로로 넘친다.
check('폼의 세 칸 최소폭을 풀어준다', /\.ai-intake-workspace \.order-grid\{grid-template-columns:minmax\(0,/.test(media),
  'minmax(350px,…)가 살아 있으면 화면이 가로로 넘친다');
// 폼이 길어도 대화는 화면에 남아 있어야 한다 — EJS도 같은 이유로 sticky다.
// align-items가 start면 대화 칸의 grid area가 카드 높이에 딱 맞아 sticky가 움직일 자리가 없다.
check('대화 칸이 화면에 붙어 있는다',
  /\.ai-intake-workspace\{[^}]*align-items:stretch/.test(media)
  && /\.ai-intake-workspace > \.ai-chat-card\{[^}]*position:sticky/.test(media),
  'align-items:stretch + position:sticky 둘 다 있어야 한다');
// 1300px 이하는 그대로 세로로 쌓인다(좁은 화면에서 옆에 붙이면 폼이 넘친다).
check('좁은 화면에서는 그리드가 아니다', !/^\.ai-intake-workspace\{display:grid/m.test(css),
  '미디어쿼리 밖에서 그리드로 만들면 좁은 화면이 가로로 넘친다');
check('쌓일 때의 간격이 있다', /\.ai-intake-workspace-order\{margin-top:16px;\}/.test(css));

console.log('\n[이관 중 붙여둔 자기점검 카드가 고객 화면에 남지 않았다]');
// 플래그를 켠 뒤로는 이 페이지가 고객이 보는 화면이다.
for (const junk of ['MIGRATION PREVIEW', 'RESTORE SNAPSHOT', 'MIGRATION STATUS', 'Next.js 단계 전환', 'NEXT_STAGE3_AI_INTAKE_ENABLED']) {
  check(`"${junk}"가 없다`, !page.includes(junk), '고객에게 보이는 화면이다');
}
// EJS와 같은 머리말이어야 한다 — 한쪽에만 부제가 붙으면 되돌릴 때 화면이 달라 보인다.
const ejs = read('views/orders/ai_intake.ejs');
check('제목이 EJS와 같다', /<h1 className="page-title">AI 챗봇<\/h1>/.test(page)
  && /<h1 class="page-title">AI 챗봇<\/h1>/.test(ejs));

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
