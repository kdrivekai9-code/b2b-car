// 기사 운행 단계 — 사슬 구성, 순서 강제, 대기시간 계산.
//
// 왜 필요한가: 기사가 누르는 순서가 곧 기록이다. 건너뛰기가 한 번 허용되면 대기 시작이 없는
// 재출발이 남고, 그러면 그 경유지의 대기시간은 영원히 알 수 없다. 되돌릴 방법도 없다.
//
// 시각 계산은 특히 조심한다. 저장값은 KST 벽시계 문자열이고 "지금"은 진짜 Date라, 그대로
// 빼면 9시간 어긋난다 — 실제로 그랬고 음수가 0으로 눌려 화면에 "대기 0분"이 떴다
// (2026-09-08, tests/manual/driver-trip-steps.playwright.spec.js가 잡았다).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const t = require('../lib/tripSteps');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`}`);
}
const labels = (n) => t.buildChain(n).map((s) => s.label);

console.log('[사슬은 경유지 개수로 정해진다]');
check('경유지 없음', labels(0), ['출발지 도착', '운행 시작', '운행 완료']);
// 하나뿐인데 "경유지1"이라고 하면 두 번째가 있는 줄 알게 된다.
check('경유지 하나 — 번호 없음', labels(1), ['출발지 도착', '운행 시작', '경유지 대기', '운행 시작', '운행 완료']);
check('경유지 둘 — 번호를 붙인다', labels(2),
  ['출발지 도착', '운행 시작', '경유지1 대기', '운행 시작', '경유지2 대기', '운행 시작', '운행 완료']);
check('경유지 셋', labels(3).filter((l) => l.startsWith('경유지')), ['경유지1 대기', '경유지2 대기', '경유지3 대기']);
// 경유지마다 대기 + 재출발 두 단계가 생긴다.
check('단계 수 = 3 + 경유지×2', [labels(0).length, labels(1).length, labels(2).length, labels(4).length], [3, 5, 7, 11]);

console.log('\n[누를 수 있는 것은 하나뿐]');
const chain = t.buildChain(2);
const at = (k, seq, when) => ({ step_key: k, seq, occurred_at: when });
const rows0 = [];
check('처음엔 출발지 도착', t.decorate(chain, rows0, new Date()).steps.filter((s) => s.active).map((s) => s.label), ['출발지 도착']);
check('건너뛰기 거절', t.canTake(chain, rows0, 'trip_completed', 0).ok, false);
check('거절 이유가 무엇을 눌러야 하는지 알려준다',
  /출발지 도착/.test(t.canTake(chain, rows0, 'trip_completed', 0).error), true);
check('순서대로면 허용', t.canTake(chain, rows0, 'origin_arrived', 0).ok, true);

const rows3 = [
  at('origin_arrived', 0, '2026-09-08 10:00:00'),
  at('drive_started', 0, '2026-09-08 10:05:00'),
  at('waypoint_wait', 1, '2026-09-08 10:40:00'),
];
check('대기 다음은 재출발', t.decorate(chain, rows3, new Date()).steps.filter((s) => s.active).map((s) => s.label), ['운행 시작']);
check('두 번 누르면 거절', t.canTake(chain, rows3, 'waypoint_wait', 1).ok, false);
check('같은 단계 재기록 거절 이유', t.canTake(chain, rows3, 'waypoint_wait', 1).error, '이미 기록된 단계입니다.');
// 경유지2의 대기를 먼저 누를 수는 없다 — 경유지1에서 아직 출발하지 않았다.
check('다음 경유지로 건너뛰기 거절', t.canTake(chain, rows3, 'waypoint_wait', 2).ok, false);
check('사슬에 없는 단계', t.canTake(t.buildChain(0), [], 'waypoint_wait', 1).ok, false);

console.log('\n[대기시간]');
check('문자열끼리 — 분', t.minutesBetween('2026-09-08 10:40:00', '2026-09-08 10:57:00'), 17);
// 진짜 Date를 "지금"으로 넘겨도 맞아야 한다(9시간 어긋나던 자리).
const startedAgo = t.kstStamp(new Date(Date.now() - 23 * 60000));
check('KST 문자열 vs 진짜 Date', t.minutesBetween(startedAgo, new Date()), 23);
check('decorate가 대기 중 분을 센다',
  t.decorate(t.buildChain(1), [at('origin_arrived', 0, startedAgo), at('drive_started', 0, startedAgo), at('waypoint_wait', 1, startedAgo)], new Date()).waitingMinutes, 23);
// 형식이 어긋나면 0이 아니라 null이다 — "대기 0분"은 실제로 안 기다린 것과 구분이 안 된다.
check('못 읽는 시각은 null', t.minutesBetween('언젠가', new Date()), null);
check('미래 시각은 0으로 눌러 음수를 막는다', t.minutesBetween(t.kstStamp(new Date(Date.now() + 60000)), new Date()), 0);
check('대기 중이 아니면 셀 것이 없다', t.decorate(chain, rows0, new Date()).waitingSeq, null);
check('전부 끝나면 allDone', t.decorate(t.buildChain(0), [
  at('origin_arrived', 0, '2026-09-08 10:00:00'), at('drive_started', 0, '2026-09-08 10:01:00'),
  at('trip_completed', 0, '2026-09-08 11:00:00')], new Date()).allDone, true);

console.log('\n[서버가 다시 판정하는가]');
const route = fs.readFileSync(path.join(__dirname, '../routes/driverChat.js'), 'utf8');
// 화면 판단만 믿으면 오래된 상태로 보낸 요청이나 두 화면 동시 누름이 순서를 깬다.
check('순서를 서버에서 판정한다', /tripSteps\.canTake\(chain, rows, stepKey, seq\)/.test(route), true);
check('남의 오더에는 기록 못 한다', /callmaner_driver_sabun = \? AND status NOT IN \('완료','취소'\)/.test(route), true);
// 유일 인덱스 위반은 오류가 아니다 — 장갑 낀 손이 두 번 닿았을 뿐이다.
check('중복 삽입을 오류로 다루지 않는다', /e\.code === '23505'/.test(route), true);
// 표가 아직 없을 수 있다(마이그레이션 수동). 기사 화면이 통째로 죽으면 안 된다.
check('없는 표를 버틴다', /e\.code === '42P01'/.test(route), true);

// 오더 상태는 콜마너가 주인이다. 여기서 바꾸면 동기화가 덮거나 고객 통보가 두 번 나간다.
const stepRoute = route.slice(route.indexOf("router.post('/chat/step'"), route.indexOf('// ── 영수증 업로드'));
check('오더 상태를 바꾸지 않는다', /UPDATE orders SET status/.test(stepRoute), false);
// 접수 때 정한 예정 대기(order_waypoints.wait_minutes)는 요금성 값이라 덮지 않는다.
check('예정 대기시간을 덮지 않는다', /UPDATE order_waypoints/.test(stepRoute), false);
check('대화에 한 줄 남긴다', /\[운행\] \$\{allowed\.step\.label\}/.test(stepRoute), true);

console.log('\n[화면]');
const view = fs.readFileSync(path.join(__dirname, '../views/driver/chat.ejs'), 'utf8');
check('단계 줄이 있다', /id="triprail"/.test(view), true);
check('사슬 전체를 미리 그린다', /trip\.steps\.forEach/.test(view), true);
check('단계 사이에 이동 화살표', /class="arrow2"/.test(view), true);
check('활성 아닌 버튼은 눌리지 않는다', /\(s\.active \? '' : ' disabled'\)/.test(view), true);
check('대기 분을 재출발 앞에 끼운다', /id="waitnow"/.test(view), true);
// 되돌릴 수 없는 단계라 한 번 묻는다.
check('운행 완료는 확인을 받는다', /운행 완료로 기록할까요/.test(view), true);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
