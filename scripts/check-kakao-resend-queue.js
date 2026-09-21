// 카카오로 못 나간 봇 말풍선이 나중에 다시 나가는지 본다.
//
// 왜 필요한가(사용자 확정 2026-09-21): 오래 쉰 뒤 첫 발신이 중계서버에서 502로 거부되는 일이
// 반복됐다. 봇 답변은 chat_messages에 저장되므로 **상담관리 화면에는 정상으로 답한 것처럼
// 보이고** 고객만 아무것도 못 받는다 — 그래서 아무도 못 알아챘다.
//
// 그 자리 재시도(lib/kakaoConsult.js SEND_RETRY_DELAYS_MS, 0.6초·1.8초)로는 부족했다:
//   09-17  실패 → 4초 뒤 성공        (재시도로 건지는 폭)
//   09-21  3초간 세 번 다 실패 → 2분 뒤 성공  (건질 수 없는 폭)
// 회복까지 수 초에서 수 분까지 들쭉날쭉해서 요청 안에서 기다리는 방식으로는 덮을 수 없다.
//
// 그래서 못 나간 것을 남겨두고 **매분 크론이 다시 보낸다.** 말풍선은 이미 저장돼 있으니
// 새 표를 만들지 않고 그 행에 배달 상태만 붙인다(마이그레이션 20260921050000).
//
// 파일만 읽는다 — DB도 카카오도 안 부르므로 CI에서 돌 수 있다.
// (실제 동작은 가짜 중계서버를 띄워 resendPendingKakaoMessages를 직접 불러 확인했다.)
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

const route = read('routes/kakaoConsult.js');
const migration = read('supabase/migrations/20260921050000_add_kakao_message_delivery.sql');

console.log('[못 나간 것을 남긴다]');
check('발신 실패를 대기로 표시한다', /async function markSendPending\(messageId, error\)/.test(route));
check('그 표시를 발신부가 부른다', /await markSendPending\(messageId, result\.error\);/.test(route));
// 어느 말풍선인지 알아야 다시 보낼 수 있다 — botSay가 저장한 행 id를 넘겨야 한다.
check('저장한 말풍선 id를 넘긴다', /return sendAndLog\(session, text, label, stored && stored\.id\);/.test(route));
// 마이그레이션은 사람이 돌린다. 컬럼이 없으면 예전처럼 로그만 남고 접수는 계속돼야 한다.
check('마이그레이션 전이면 조용히 넘어간다',
  /async function markSendPending[\s\S]{0,700}?e\.code === '42703'/.test(route));

console.log('\n[매분 크론이 다시 보낸다]');
check('재전송 함수가 있다', /async function resendPendingKakaoMessages\(\)/.test(route));
check('대기 중인 것만 집는다', /WHERE m\.kakao_send_state = 'pending'/.test(route));
check('매분 크론이 부른다',
  /runKakaoOrderNotifications\(\)[\s\S]{0,400}?await resendPendingKakaoMessages\(\)/.test(route),
  '크론에 안 붙으면 큐에 쌓이기만 하고 영영 안 나간다');
// 재전송이 실패해도 통보 크론 본래 일이 멈추면 안 된다.
check('재전송 실패가 크론을 멈추지 않는다',
  /resendPendingKakaoMessages\(\)\s*\n?\s*\.catch\(/.test(route));
// 한 회차에 다 붙잡으면 크론의 다른 일이 밀린다.
check('한 회차 처리량에 상한이 있다', /const KAKAO_RESEND_BATCH = \d+;/.test(route));
check('그 상한을 조회에 쓴다', /LIMIT \$\{KAKAO_RESEND_BATCH\}/.test(route));

console.log('\n[성공하면 다시 안 보낸다]');
check('성공하면 상태를 바꾼다', /SET kakao_send_state = 'sent'/.test(route));
// 'pending'만 집으므로 sent/failed는 자연히 대상에서 빠진다.
check('대상 조회가 상태로 거른다', /kakao_send_state = 'pending'/.test(route));

console.log('\n[영원히 시도하지 않는다]');
check('시도 한도가 있다', /const KAKAO_RESEND_MAX_ATTEMPTS = \d+;/.test(route));
const max = Number((route.match(/const KAKAO_RESEND_MAX_ATTEMPTS = (\d+);/) || [])[1]);
// 매분 도니까 횟수가 곧 분이다. 너무 길면 맥락 없는 답이 뒤늦게 날아간다.
check('한도가 30분을 넘지 않는다', max > 0 && max <= 30, `${max}회(≈${max}분)`);
check('한도에 닿으면 포기한다', /done \? 'failed' : 'pending'/.test(route));
// 포기한 것은 고객이 끝내 답을 못 받은 것이다 — 반드시 사람이 보게 남겨야 한다.
check('포기를 오류 로그에 남긴다', /operation: 'send_giveup'/.test(route));

console.log('\n[끝난 대화에는 뒤늦게 보내지 않는다]');
// 닫힌 상담에 며칠 뒤 봇 답이 튀어나오면 고객에게는 맥락 없는 말이 된다.
check('닫힌 세션은 보내지 않는다', /row\.status === 'closed'/.test(route));
check('닫힌 세션은 대기에서 뺀다',
  /row\.status === 'closed'[\s\S]{0,260}?kakao_send_state = 'failed'/.test(route));

console.log('\n[마이그레이션]');
for (const col of ['kakao_send_state', 'kakao_send_attempts', 'kakao_send_last_at', 'kakao_send_error']) {
  check(`${col} 컬럼을 만든다`, new RegExp(`ADD COLUMN IF NOT EXISTS ${col}`).test(migration));
}
// chat_messages는 계속 커지는 표다 — 대상이 극소수라 부분 인덱스여야 한다.
check('대기분만 부분 인덱스로 건다', /WHERE kakao_send_state = 'pending'/.test(migration));
// 지난 실패를 소급해 보내면 며칠 지난 답이 날아간다.
check('기존 행을 소급 처리하지 않는다', !/UPDATE chat_messages SET kakao_send_state/.test(migration));

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
