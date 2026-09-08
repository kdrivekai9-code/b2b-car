// 콜마너 동기화가 "아직 끝나지 않은 오더"를 놓치지 않는가, 그리고 뒤늦게 알아낸 사건을
// 고객에게 알리지 않는가.
//
// 왜 필요한가(실측 2026-09-08, OID1455): 조회 대상 조건이 **접수일** 기준 3일이었다. 접수
// 8/24 건이 8/27에 창을 벗어난 뒤로는 콜마너에서 무슨 일이 나도 우리가 묻지 않았다. 그 오더는
// 오늘 실제로 운행돼 14:46에 완료됐는데 우리 화면은 2주 내내 '기사배정'이었다 — 오더리스트,
// 정산, 고객 문의 답변이 전부 틀린 상태를 근거로 돌아갔다.
//
// 창을 넓히면 반대쪽 위험이 생긴다: 오래 못 보던 오더의 사건을 오늘 처음 알아냈을 때, 그게
// 오늘 일인지 2주 전 일인지 구분하지 못하면 "2주 전 완료를 지금 완료로 통보"하거나 "진짜
// 완료를 뒤늦은 것으로 보고 안 보내는" 둘 중 하나를 틀린다. 그래서 콜마너가 주는 사건 시각을
// 저장해 두 시각을 나눠 본다.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const notify = require('../lib/kakaoOrderNotify');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`}`);
}
const sync = fs.readFileSync(path.join(__dirname, '../routes/callmanerSync.js'), 'utf8');

console.log('[조회 대상 — 끝나지 않은 오더는 계속 본다]');
check('진행중 오더를 위한 별도 창이 있다', /LIVE_LOOKBACK_DAYS/.test(sync), true);
// 접수일이 아니라 예약일로 놓는다 — 접수는 하루뿐이지만 오더가 살아 있는 기간은 예약일이 정한다.
check('예약일 기준으로 남긴다',
  /COALESCE\(reserved_date, to_char\(created_at::timestamp, 'YYYY-MM-DD'\)\)/.test(sync), true);
// 접수일 조건이 AND로 남아 있으면(예전 형태) 진행중 조건이 무력화된다 — 그게 이 사고였다.
check('접수일 조건이 AND로 걸려 있지 않다',
  /AND created_at >= to_char\(\(now\(\) at time zone 'Asia\/Seoul'\) - interval '\$\{SYNC_LOOKBACK_DAYS\}/.test(sync), false);
// 굶는 오더가 없어야 한다 — 오래 확인 안 된 순으로 돌린다.
check('오래 확인 안 된 순으로 돌린다', /callmaner_synced_at ASC NULLS FIRST/.test(sync), true);

console.log('\n[콜마너 사건 시각을 저장한다]');
const { callmanerEventAt } = require('../routes/callmanerSync');
// OrderInfo: status_time '20260825145001' / OrderHistory: end_time '2026-09-08 14:46:27'
check('단건조회 형식', callmanerEventAt({ statusTime: '20260825145001' }), '2026-08-25 14:50:01');
check('목록조회 형식', callmanerEventAt({ endTime: '2026-09-08 14:46:27' }), '2026-09-08 14:46:27');
check('초가 없어도 받는다', callmanerEventAt({ endTime: '2026-09-08 14:46' }), '2026-09-08 14:46:00');
// 없는 값을 지금 시각으로 채우면 뒤늦은 사건이 "방금"으로 둔갑해 걸러낼 근거가 사라진다.
check('없으면 null', callmanerEventAt({}), null);
check('빈 문자열도 null', callmanerEventAt({ statusTime: '', endTime: '' }), null);
check('못 읽는 값은 null', callmanerEventAt({ statusTime: '언제' }), null);
// 두 API가 서로 다른 모양으로 준다 — OrderInfo는 '20260825145001', OrderHistory는 '2026-09-08 14:46:27'.
check('status_time과 end_time 둘 다 본다', /info\.statusTime \|\| info\.endTime/.test(sync), true);
check('상태 변경과 함께 저장한다', /updateStatusWithEventAt\(order\.id, mappedStatus/.test(sync), true);
// 마이그레이션 전 DB에서도 상태 갱신 자체는 막히지 않아야 한다.
check('없는 칸을 버틴다', /supportsStatusAtColumn/.test(sync) && /e\.code === '42703'/.test(sync), true);

console.log('\n[뒤늦게 알아낸 사건은 통보하지 않는다]');
// 실제 사례: 오늘 14:46 완료를 14:52에 알아냈다 — 6분 전 일이라 통보가 맞다.
check('방금 일어난 일은 보낸다',
  notify.isBackfilled({ callmaner_status_at: '2026-09-08 14:46:27', reserved_date: '2026-08-25' }, '2026-09-08 14:52:11'), false);
// 같은 오더의 2주 전 사건이라면 보내지 않는다.
check('오래전 사건은 안 보낸다',
  notify.isBackfilled({ callmaner_status_at: '2026-08-25 14:50:01', reserved_date: '2026-08-25' }, '2026-09-08 14:52:11'), true);
// 예약일로 재면 위 첫 줄을 틀린다(예약 8/25, 실제 운행 9/8) — 그래서 예약일은 폴백일 뿐이다.
check('예약일이 오래 지났어도 사건이 방금이면 보낸다',
  notify.isBackfilled({ callmaner_status_at: '2026-09-08 14:46:27', reserved_date: '2026-07-01' }, '2026-09-08 14:52:11'), false);
// 폴링이 몇 시간 멎었다 복구된 경우까지 막으면 진짜 사건을 놓친다.
check('몇 시간 지연은 봐준다',
  notify.isBackfilled({ callmaner_status_at: '2026-09-08 09:52:00', reserved_date: '2026-09-08' }, '2026-09-08 14:52:00'), false);
check('반나절 넘으면 막는다',
  notify.isBackfilled({ callmaner_status_at: '2026-09-08 07:52:00', reserved_date: '2026-09-08' }, '2026-09-08 14:52:00'), true);

console.log('\n[사건 시각을 모를 때 — 폴백]');
check('예약일이 오늘이면 보낸다', notify.isBackfilled({ reserved_date: '2026-09-08' }, '2026-09-08 14:52:00'), false);
check('하루 밀린 건도 보낸다', notify.isBackfilled({ reserved_date: '2026-09-07' }, '2026-09-08 09:00:00'), false);
check('2주 지난 건은 안 보낸다', notify.isBackfilled({ reserved_date: '2026-08-25' }, '2026-09-08 14:52:00'), true);
// 아무 근거도 없으면 막지 않는다 — 판단할 수 없는 것을 막으면 통보가 조용히 사라진다.
check('아무 정보도 없으면 보낸다', notify.isBackfilled({}, '2026-09-08 14:52:00'), false);

console.log('\n[통보 예약 경로에 실제로 물려 있는가]');
const notifySrc = fs.readFileSync(path.join(__dirname, '../lib/kakaoOrderNotify.js'), 'utf8');
check('이력 스캔이 감지 시각을 읽는다', /SELECT id, order_id, old_status, new_status, created_at FROM order_status_history/.test(notifySrc), true);
check('예약을 만들기 전에 판정한다', /if \(isBackfilled\(target\.order, row\.created_at\)\)/.test(notifySrc), true);
// 커서는 넘겨야 한다 — 막힌 행에서 멈추면 그 뒤의 정상 통보가 전부 밀린다.
check('막은 행에서 멈추지 않는다', /backfilled \+= 1;\n      console\.log/.test(notifySrc), true);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
