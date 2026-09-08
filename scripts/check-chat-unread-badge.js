// 고객이 "통보가 왔다"는 사실을 알 수 있는지 본다.
//
// 왜 필요한가(실사용 지적 2026-09-08): 통보는 상담창에 꽂히는데, 창을 열지 않으면 도착한
// 줄을 모른다. 카카오는 앱 알림이 저절로 뜨는 반면 웹은 아무 표시가 없었다 — 배차 통보를
// 보내놓고도 고객은 인지할 수 없었다.
//
// 세 자리에 배지를 붙였다: 메뉴(AI 챗봇), 챗봇 화면 상단, 최근 항목의 세션별.
//
// 이 검사가 지키는 것 중 가장 중요한 것은 **세는 규칙이 한 가지**라는 점이다. 목록 배지들의
// 합과 메뉴 배지 숫자가 어긋나면 사용자는 어느 쪽을 믿을지 모른다. 그래서 두 질의가 같은
// 조건(sender IN ('system','agent') AND read_by_user_at IS NULL)을 쓰는지 확인한다.
//
// 파일만 읽는다 — DB도 모델도 부르지 않으므로 CI에서 돌 수 있다.
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

console.log('[세는 규칙이 한 가지다]');
const chatRoutes = read('routes/chat.js');
const orderRoutes = read('routes/orders.js');
// 통보(system)와 상담원 답장(agent)만. 봇 메시지는 고객이 그 자리에 있었던 대화라 세지 않는다 —
// 실측으로 봇까지 세면 한 계정에 620건(세션 60개)이 잡혀 숫자가 아무 뜻이 없어진다.
// 별칭(m.)이 붙어도 같은 규칙이다 — 한 질의는 JOIN이 있어 m.을 쓰고 다른 하나는 안 쓴다.
// 처음에 별칭을 안 받아 멀쩡한 코드를 잡았다.
const RULE = /(?:m\.)?sender IN \('system', 'agent'\) AND (?:m\.)?read_by_user_at IS NULL/;
check('메뉴·상단 배지가 통보와 상담원 답장만 센다', RULE.test(chatRoutes));
check('최근 항목 배지도 같은 규칙을 쓴다', RULE.test(orderRoutes));
// 숨긴 세션에 배지가 붙으면 눌러볼 데가 없다.
check('숨긴 세션은 빼고 센다', /user_hidden_at IS NULL[\s\S]{0,200}sender IN \('system', 'agent'\)/.test(chatRoutes));

console.log('\n[열어서 읽으면 줄어든다]');
// 서버가 읽음으로 표시하고, 클라이언트가 배지를 다시 물어야 숫자가 내려간다.
check('세션을 열면 통보를 읽음으로 표시한다', /markSystemMessagesReadByUser\(session\.id\)/.test(chatRoutes));
// 상담원 읽음영수증과 섞이면 안 된다 — 봇 통보를 열어본 것만으로 상담원 화면에 읽음이 뜬다.
check('상담원 읽음영수증과 분리돼 있다',
  /async function markSystemMessagesReadByUser/.test(chatRoutes)
  && !/sender = 'system'[\s\S]{0,300}broadcastReadReceiptAsync/.test(chatRoutes));
check('EJS가 읽은 뒤 배지를 다시 묻는다',
  /chat-unread-refresh/.test(read('public/js/ai-intake-api.js')));
check('Next도 읽은 뒤 배지를 다시 묻는다',
  /chat-unread-refresh/.test(read('src/app/orders/ai-intake/AiIntakeClient.js')));

console.log('\n[세 자리에 붙는다]');
const badgeJs = read('public/js/chat-unread-badge.js');
check('메뉴(AI 챗봇) 옆', /a\[href="\/orders\/ai-intake"\]/.test(badgeJs));
check('챗봇 화면 상단', /\.ai-chat-title/.test(badgeJs));
check('최근 항목 세션별(EJS)', /className = 'unread-badge'/.test(read('public/js/ai-intake.js')));
// Next 챗봇 화면에는 최근 항목이 아예 없다(EJS에만 있는 기능) — 그래서 Next는 두 자리다.
check('Next 상단 제목', /unread-badge ai-chat-title-badge/.test(read('src/app/orders/ai-intake/AiIntakeClient.js')));

console.log('\n[EJS와 Next가 같이 바뀐다]');
// 이 저장소에서 반복된 함정: 공용 화면 조각이 두 벌이라 한쪽만 고치면 채널에 따라 다르게 보인다.
check('EJS가 배지 스크립트를 싣는다', /chat-unread-badge\.js/.test(read('views/partials/header.ejs')));
check('Next도 같은 스크립트를 싣는다', /chat-unread-badge\.js/.test(read('src/app/_components/AppShell.js')));
// 관리자는 별도 알림센터(agent-notification-center.js)가 있어 이 배지가 필요 없다.
check('고객에게만 싣는다(EJS)', /role === 'client'[\s\S]{0,200}chat-unread-badge/.test(read('views/partials/header.ejs')));
check('고객에게만 싣는다(Next)', /role === 'client'[\s\S]{0,200}chat-unread-badge/.test(read('src/app/_components/AppShell.js')));

console.log('\n[모양은 한 곳에서 정한다]');
const css = read('public/css/style.css');
check('배지 스타일이 공용 CSS에 있다', /\.unread-badge\s*\{/.test(css));
// 빨강 원형 + 흰 숫자(사용자 확정).
check('빨강 배경', /\.unread-badge[\s\S]{0,400}background:\s*#d92b2b/.test(css));
check('흰 숫자', /\.unread-badge[\s\S]{0,400}color:\s*#fff/.test(css));
check('원형', /\.unread-badge[\s\S]{0,400}border-radius:\s*9px/.test(css));
// 1과 11의 폭이 달라 배지가 들썩이는 것을 막는다.
check('숫자 폭이 고정이다', /\.unread-badge[\s\S]{0,500}tabular-nums/.test(css));

console.log('\n[숫자가 화면을 밀어내지 않는다]');
// 세 자리가 넘으면 라벨을 밀어낸다. 정확한 수보다 "많다"는 사실이 중요하다.
for (const [label, src] of [
  ['공용 스크립트', badgeJs],
  ['최근 항목(EJS)', read('public/js/ai-intake.js')],
  ['Next 상단', read('src/app/orders/ai-intake/AiIntakeClient.js')],
]) {
  check(`${label}이 99+로 자른다`, /> 99 \? '99\+'/.test(src));
}

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
