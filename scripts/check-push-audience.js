// 어떤 알림을 **누가** 받는가, 그리고 "켜짐" 표시가 사실인가.
//
// 왜 필요한가(실측 2026-09-08): lib/push.js notify()에 역할 조건이 없어서 고객 구독이 내부
// 알림 전부에 잡히고 있었다. 실제 데이터로 확인했다 — 고객(seoulmotors) 구독 2건이 상담원
// 호출·시스템 장애·번호판 상이·지사 오더 등록/수정 대상에 모두 들어 있었다.
//
// 왜 그렇게 됐나: 고객 설정 화면에는 체크박스가 하나뿐이라(내 오더 진행 알림) 나머지 칸을
// 끌 방법이 없고, 서버는 지정되지 않은 칸을 켜짐으로 저장한다(`=== false ? 0 : 1`).
// 그래서 고객 구독은 모든 플래그가 1로 남는다 — UI로는 못 막는다. 애초에 받을 대상이 아니다.
//
// 새던 것: "🚨 상담원 호출"(다른 고객의 상담 요청), 시스템 장애(연동 오류), 번호판 상이
// (다른 오더의 차량번호), 지사 범위 오더 등록/수정(남의 오더). 고객에게 갈 값이 아니다.
//
// 함께 보는 것: 사이드바의 "알림 켜짐" 표시가 실제 발송 여부와 같은 말을 하는가.
// 오더 알림 설정에서 체크를 끄면 구독은 남고 플래그만 0이 되는데, 예전 라벨은 브라우저 구독
// 유무만 보고 계속 "켜짐"이라고 적었다.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`}`);
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const push = read('lib/push.js');
const routes = read('routes/push.js');
const client = read('public/js/push.js');

console.log('[내부 알림은 내부 사용자에게만]');
check('내부 역할 목록이 한 곳에', /const INTERNAL_ROLES = "\('admin', 'branch_manager'\)"/.test(push), true);
// 네 갈래 모두 걸어야 한다 — 하나만 빠져도 그 알림이 고객에게 간다.
const branches = push.match(/SELECT p\.\* FROM push_subscriptions p JOIN users u ON u\.id = p\.user_id/g) || [];
check('네 갈래 모두 users를 조인한다', branches.length, 4);
const roleGuards = push.match(/u\.role IN \$\{INTERNAL_ROLES\}/g) || [];
check('네 갈래 모두 역할을 본다', roleGuards.length, 4);
// 역할 조건 없는 옛 형태가 남아 있으면 그 갈래는 여전히 새고 있다.
check('역할 조건 없는 옛 조회가 없다',
  /SELECT \* FROM push_subscriptions WHERE notify_(agent_call|system_alert)/.test(push), false);

console.log('\n[고객은 자기 오더만 받는다]');
// 고객용은 지사·이벤트가 아니라 user_id로 고른다 — 남의 오더가 섞일 수 없다.
check('notifyUser는 user_id로 고른다',
  /WHERE user_id = \? AND notify_order_events = 1/.test(push), true);
// 고객 구독이 내부 알림 대상에 들어가지 않는지는 위 역할 조건이 지킨다.
check('고객 역할은 내부 목록에 없다', /INTERNAL_ROLES = "\('admin', 'branch_manager'\)"/.test(push) && !/client/.test((push.match(/INTERNAL_ROLES = "[^"]*"/) || [''])[0]), true);

console.log('\n[고객 구독에는 내부 칸을 켜주지 않는다]');
// 발송 쪽 역할 조건만으로도 막히지만, 데이터가 거짓말을 하는 상태를 남기면 그 조건을 잊은
// 조회 하나가 다시 새게 만든다. 화면이 아니라 서버에서 끊는다 — 요청 본문은 만들어 보낼 수 있다.
//
// 왜 이 값이 켜져 있었나: 고객 화면에는 체크박스가 하나뿐이라 나머지 넷은 요소를 못 찾고
// `? el.checked : true`로 굳어 전송된다(EJS·Next 양쪽 동일).
check('고객이면 내부 칸을 0으로 저장한다',
  /const isClient = req\.session\.user\.role === 'client';/.test(routes)
  && /const internalOn = \(v\) => \(isClient \? 0 : \(v === false \? 0 : 1\)\);/.test(routes), true);
// 오더 알림은 고객이 직접 고르는 값이라 그대로 존중한다.
check('오더 알림 칸은 그대로 존중', /notify_order_events === false \? 0 : 1,/.test(routes), true);
// 지사 범위 알림 대상이 아니라 지사도 매지 않는다.
check('고객 구독에는 지사를 매지 않는다', /isClient \? null : \(branch_id \|\| null\)/.test(routes), true);
// 화면이 넷을 true로 보내는 것 자체는 그대로 둔다(관리자 화면과 같은 코드다) — 서버가 끊는다.
check('화면은 그대로여도 된다(서버가 끊는다)',
  /notify_agent_call: notifyAgentCallEl \? notifyAgentCallEl\.checked : true/.test(read('views/push_settings.ejs')), true);

console.log('\n[알림 끄기는 구독을 지운다]');
// 체크 해제+저장과 다른 동작이다. 끄기는 행을 삭제하므로 어떤 알림도 오지 않는다.
check('끄기는 DELETE다', /DELETE FROM push_subscriptions WHERE endpoint = \? AND user_id = \?/.test(routes), true);
check('EJS 끄기 버튼이 공용 함수를 쓴다', /window\.__push\.unsubscribe\(\)/.test(read('views/push_settings.ejs')), true);
check('Next 끄기 버튼도 같은 함수', /window\.__push\.unsubscribe\(\)/.test(read('src/app/push/settings/PushSettingsClient.js')), true);

console.log('\n["켜짐" 표시가 사실인가]');
// 구독이 있어도 켜진 칸이 하나도 없으면 알림은 안 온다. 그 판정을 서버가 한다(역할마다 기준이 다르다).
check('서버가 effective를 준다', /effective: isEffective\(req\.session\.user, sub\)/.test(routes), true);
check('고객 기준은 오더 알림 하나', /if \(user\.role === 'client'\) return on\(sub\.notify_order_events\);/.test(routes), true);
check('내부 사용자는 하나라도 켜져 있으면', /\.some\(\(k\) => on\(sub\[k\]\)\)/.test(routes), true);
check('엔드포인트가 없으면 꺼짐', /return res\.json\(\{ subscribed: false, effective: false \}\)/.test(routes), true);

console.log('\n[사이드바 버튼]');
check('라벨을 서버 판정으로 정한다', /await isNotifyOn\(sub\)\) \? '🔔 알림 켜짐' : '🔕 알림 받기'/.test(client), true);
// 구독은 있는데 설정에서 꺼둔 상태에서 누르면 "켜기"여야 한다 — 끄면 누를 때마다 꺼지기만 한다.
check('꺼둔 상태에서 누르면 켠다', /if \(current && !\(await isNotifyOn\(current\)\)\)/.test(client), true);
// 서버에 못 물어봐도 버튼은 살아 있어야 한다.
check('서버 조회 실패는 켜짐으로 본다', /return true;\n    \}\n  \}/.test(client), true);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
