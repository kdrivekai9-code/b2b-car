// 상담원 안읽음 배지가 "사람이 봤을 때만" 지워지는지 본다.
//
// 왜 필요한가(실사용 지적 2026-09-21): "카카오톡으로 고객이 질문한 사항이 상담관리에도
// 보이지 않는다." 세션은 목록 맨 위에 멀쩡히 있었다 — 없던 것은 **안읽음 배지**였다.
//
// 원인: 서버가 "스트림이 연결돼 있다"를 "사람이 읽었다"로 취급했다.
//   1. 상담관리 카드 보기는 들어가면 **첫 카드를 자동 선택**한다
//      (src/app/chat/sessions/CardBoard.js, public/js/chat-session-cards.js)
//   2. 선택하면 /chat/sessions/:id/stream(SSE)이 열린다
//   3. 그 중계가 도착하는 고객 메시지를 즉시 읽음 처리했다
// 목록 1위는 가장 활발한 대화라, 그 고객의 질문은 사람이 자리에 없어도 도착 1초 만에
// 읽음이 됐다. 실측(세션 735): 오늘 고객 발화 5건이 전부 1초 안에 읽음
// (13:57:17 → 13:57:18). 배지가 영영 안 뜨니 상담원은 새 질문이 온 줄 몰랐다.
//
// 고친 규칙: **읽음은 사람이 한 일에만 붙인다.**
//   · 세션을 직접 고르면 → /sessions/:id/messages가 읽음 처리(명시적 행동)
//   · 보고 있는 중에 새 메시지가 오면 → 화면이 탭 가시성을 확인하고 POST /sessions/:id/read
//   · 스트림 중계와 따라잡기 폴링(/poll)은 읽음 처리하지 않는다
//
// 파일만 읽는다 — DB도 브라우저도 안 쓰므로 CI에서 돌 수 있다.
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

const chat = read('routes/chat.js');
const nextViewer = read('src/app/chat/sessions/SessionViewer.js');
const ejsCards = read('public/js/chat-session-cards.js');

// 읽음을 쓰는 곳은 한 함수뿐이어야 한다 — 여러 곳에서 쓰면 이 검사가 무의미해진다.
console.log('[읽음을 쓰는 곳]');
const writers = (chat.match(/SET read_by_agent_at = /g) || []).length;
check('읽음 처리가 한 함수에만 있다', writers === 1, `${writers}곳`);

// 호출부를 이름으로 세어, 새 자동 읽음이 슬쩍 늘어나는 것을 막는다.
const callers = (chat.match(/await markUserMessagesReadByAgent\(/g) || []).length;
check('부르는 곳이 둘뿐이다(세션 선택 · 명시적 읽음)', callers === 2, `${callers}곳`);

console.log('\n[연결됐다고 읽은 것으로 치지 않는다]');
// 스트림 핸들러 본문 안에서 본다 — 파일 어디에 있는지가 아니라 이 핸들러가 하느냐가 문제다.
const streamIdx = chat.indexOf("router.get('/sessions/:id/stream'");
const streamEnd = chat.indexOf('\n}));', streamIdx);
const streamBody = streamIdx >= 0 && streamEnd > streamIdx ? chat.slice(streamIdx, streamEnd) : '';
check('스트림 핸들러를 찾았다', streamBody.length > 300, `${streamBody.length}자`);
check('연결할 때 읽음 처리하지 않는다', !/markUserMessagesReadByAgent\(/.test(streamBody),
  '카드 보기가 첫 카드를 자동 선택하며 여는 스트림이다 — 여기서 읽으면 배지가 영영 안 뜬다');
check('중계하면서 읽음 처리하지 않는다', !/ReadByAgent/.test(streamBody));

// 따라잡기 폴링은 7초마다 돈다. 여기서 읽으면 같은 문제가 조금 느리게 재현될 뿐이다.
const pollIdx = chat.indexOf("router.get('/sessions/:id/poll'");
const pollEnd = chat.indexOf('\n}));', pollIdx);
const pollBody = pollIdx >= 0 && pollEnd > pollIdx ? chat.slice(pollIdx, pollEnd) : '';
check('폴링 핸들러를 찾았다', pollBody.length > 200, `${pollBody.length}자`);
check('따라잡기 폴링도 읽음 처리하지 않는다', !/markUserMessagesReadByAgent\(/.test(pollBody));

console.log('\n[사람이 봤다고 알리는 길이 있다]');
check('명시적 읽음 엔드포인트가 있다', /router\.post\('\/sessions\/:id\/read'/.test(chat));
check('관리자만 부를 수 있다', /router\.post\('\/sessions\/:id\/read', requireRole\('admin'\)/.test(chat));
// 세션을 직접 고르는 것은 사람이 한 일이다 — 그때는 읽음 처리가 맞다.
const msgIdx = chat.indexOf("router.get('/sessions/:id/messages'");
const msgEnd = chat.indexOf('\n}));', msgIdx);
const msgBody = msgIdx >= 0 && msgEnd > msgIdx ? chat.slice(msgIdx, msgEnd) : '';
check('세션을 고르면 읽음 처리한다', /markUserMessagesReadByAgent\(/.test(msgBody));

console.log('\n[화면 두 벌이 탭 가시성을 보고 알린다]');
for (const [label, src] of [['Next', nextViewer], ['EJS', ejsCards]]) {
  check(`${label}: 보이는 상태일 때만 알린다`,
    /sender === 'user' && document\.visibilityState === 'visible'/.test(src),
    '가시성을 안 보면 서버에서 걷어낸 자동 읽음을 화면이 그대로 재현한다');
  check(`${label}: 읽음 엔드포인트를 부른다`, /\/read`?'?, \{ method: 'POST'|\/read', \{\s*method: 'POST'/.test(src)
    || /\/read`, \{ method: 'POST'/.test(src));
  // 뒤에 깔아둔 탭을 다시 열었을 때가 진짜로 사람이 본 순간이다.
  // **등록**을 본다. 낱말만 찾으면 정리(removeEventListener) 줄에 걸려, 등록을 지워도
  // 그대로 통과한다(되돌림 시험에서 샜다).
  check(`${label}: 탭이 다시 보이면 알린다`, /addEventListener\('visibilitychange'/.test(src));
  // 읽음 표시가 실패해도 대화가 막히면 안 된다.
  check(`${label}: 실패해도 대화를 막지 않는다`, /\.catch\(/.test(src));
}

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
