// 장애가 풀리면 복구 알림이 한 번 가는지 본다.
//
// 왜 필요한가(사용자 지시 2026-09-21): 장애 알림은 오는데 **복구 알림이 없었다.** 받은
// 사람은 아직 고장 난 상태인지 이미 풀린 상태인지 알 수 없어서, 매번 /alerts 화면을 열어
// 확인해야 했다. 콜마너가 몇 시간씩 고장 나던 날 이게 특히 불편했다.
//
// clearResolved는 원래도 있었지만 하는 일이 "쿨다운 상태 지우기"뿐이었다 — 지워야 다음에
// 같은 장애가 났을 때 다시 알릴 수 있기 때문이다. 거기에 알림을 얹었다.
//
// 지켜야 할 것 셋:
//   · 진행 중인 장애에는 복구 알림이 가면 안 된다
//   · 알린 적 없는 건에는 복구 알림이 가면 안 된다(state에 있는 것만 = 실제로 보낸 것만)
//   · 복구 알림은 한 번만 — 상태를 지우므로 다음 회차에 또 가지 않는다
//
// 파일만 읽는다 — DB도 발송도 안 하므로 CI에서 돌 수 있다.
// (실제 동작은 lib/systemAlert.js clearResolved를 직접 불러 확인했다.)
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

const alert = read('lib/systemAlert.js');

console.log('[복구되면 알린다]');
check('clearResolved가 발송기를 받는다', /async function clearResolved\(activeKeys, send\)/.test(alert));
check('크론이 발송기를 넘긴다', /clearResolved\(alerts\.map\(\(a\) => a\.key\), send\)/.test(alert),
  '안 넘기면 복구 알림이 조용히 안 나간다 — 예전 동작 그대로가 된다');
check('복구 제목을 붙인다', /title: `✅ 복구: \$\{title\}`/.test(alert));
check('장애 알림과 같은 경로로 보낸다', /eventType: 'system_alert'/.test(alert));

console.log('\n[알린 적 있는 것만, 진행 중이 아닌 것만]');
// state에 남아 있는 키 = recordSent가 써 넣은 것 = 실제로 알림을 보낸 것.
check('state에 있는 것만 대상이다', /SELECT \* FROM system_alert_state/.test(alert));
check('이번 회차에 걸린 것은 뺀다', /!activeKeys\.includes\(r\.alert_key\)/.test(alert));
// 상태를 지우므로 다음 회차에 또 가지 않는다.
check('보낸 뒤 상태를 지운다',
  /DELETE FROM system_alert_state WHERE alert_key = \?/.test(alert));

console.log('\n[무엇이 복구됐는지 알 수 있다]');
// "복구됐습니다"만 오면 어느 장애 이야기인지 알 수 없다.
check('문구를 만드는 함수가 있다', /function describeRecovery\(row\)/.test(alert));
check('제목에 원래 장애 이름을 쓴다', /const title = row\.last_title \|\| row\.alert_key;/.test(alert));
check('몇 번 알렸는지 담는다', /알림 \$\{count\}회/.test(alert));
check('언제가 마지막이었는지 담는다', /마지막 알림 \$\{mins\}분 전/.test(alert));

console.log('\n[알림 이력에 남는다]');
// /alerts 화면이 "알림이 나갔었나"를 되짚는 곳이라, 복구만 빠지면 장애가 아직 진행 중인
// 것처럼 읽힌다.
check('이력에 기록한다', /INSERT INTO system_alert_log[\s\S]{0,200}?:resolved/.test(alert));
check('장애 알림과 키를 구분한다', /`\$\{row\.alert_key\}:resolved`/.test(alert));

console.log('\n[발송이 실패해도 멈추지 않는다]');
// 발송 실패가 상태 진행을 막으면, 실패가 이어질 때 5분마다 같은 것을 영원히 다시 시도한다.
// 장애 알림 경로도 같은 판단이라(send 실패를 잡고 recordSent는 그대로 한다) 맞춰둔다.
check('발송 실패를 잡는다', /catch \(e\) \{[\s\S]{0,80}?복구 알림 발송 실패/.test(alert));
check('실패해도 상태를 지운다',
  /복구 알림 발송 실패[\s\S]{0,700}?DELETE FROM system_alert_state/.test(alert));
// 기록이 실패해도 본 흐름이 멈추면 안 된다.
check('이력 기록 실패도 삼킨다', /복구 알림 기록 실패/.test(alert));

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
