// 자동화가 운영 DB에 시험 데이터를 남기지 않는지, 그리고 지울 때 실데이터를 지우지 않는지 본다.
//
// 이 검사가 지키는 사고 둘:
//
//   1. 워크플로에 `DELETE FROM chat_sessions`가 조건 없이 있었다. 운영 DB에 붙으므로 실고객
//      카카오 상담톡까지 모든 대화를 지운다. 세션 338건, 메시지 3,950건이 있던 시점이다.
//      남아 있는 가장 오래된 세션 날짜가 이 워크플로의 마지막 실행일과 같았다.
//
//   2. check-special-toll-settlement의 정리가 `oid LIKE 'MARK%'`였는데, createOrder가 oid를
//      'OID####'로 덮어쓴다(lib/orderCreate.js:165). 그래서 정리가 한 건도 못 지웠고 성공한
//      실행에서도 매번 2건씩 남아 22건이 쌓였다.
//
// 둘의 공통점: 정리 코드가 **있었다.** 조건이 틀렸을 뿐이다. 그래서 "정리가 있나"가 아니라
// "조건이 맞나"를 본다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripJs = (s) => s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const stripYaml = (s) => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

console.log('[쓸기는 확인 없이 지우지 않는다]');
const orders = stripJs(read('scripts/clean-test-orders.js'));
const sessions = stripJs(read('scripts/clean-test-chat-sessions.js'));
for (const [label, src] of [['오더', orders], ['세션', sessions]]) {
  check(`${label} 쓸기는 --apply가 있어야 지운다`,
    /--apply/.test(src) && /if \(!APPLY\)/.test(src));
}

console.log('\n[쓸기가 실데이터를 지우지 않는다]');
// 표식이 붙었는데 콜마너에 올라가 있으면 실제 배차가 걸린 것이다. 자동 정리가 그걸 지우는
// 경로는 만들지 않는다.
check('콜마너에 올라간 오더는 건드리지 않는다',
  /callmaner_conf_slip \|\| r\.callmaner_synced_at/.test(orders));
check('표식으로만 고른다', /origin_address LIKE \? OR destination_address LIKE \?/.test(orders));
// 소유자가 없는 세션은 카카오 상담톡 — 실고객이다.
check('세션은 QA 계정 것만 지운다',
  /user_id IN \(\$\{placeholders\}\)/.test(sessions) && /qa\\\\_%/.test(sessions));
check('소유자 없는 세션을 지우지 않는다',
  !/user_id IS NULL/.test(sessions.split('if (!APPLY)')[1] || ''));

console.log('\n[워크플로]');
const wf = stripYaml(read('.github/workflows/playwright-e2e.yml'));
check('무조건 대화 삭제가 없다', !/DELETE FROM chat_sessions'/.test(wf),
  "조건 없는 DELETE FROM chat_sessions가 남아 있다");
// 시작 전에 돌아야 지난번 실행이 죽어서 남긴 것을 걷어낸다. 끝에만 돌리면 죽은 실행은
// 영원히 자기 쓰레기를 안고 있다.
const sweepBefore = (wf.match(/name: 시험 데이터 쓸기\(시작 전\)/g) || []).length;
const sweepAfter = (wf.match(/name: 시험 데이터 쓸기\(정리\)/g) || []).length;
check('두 잡 모두 시작 전에 쓸어낸다', sweepBefore === 2, `${sweepBefore}곳`);
check('두 잡 모두 끝에도 쓸어낸다', sweepAfter === 2, `${sweepAfter}곳`);
// 테스트가 실패하면 정리가 가장 필요한 순간이다.
const afterBlocks = wf.split('name: 시험 데이터 쓸기(정리)').slice(1);
check('끝 쓸기는 실패해도 돈다',
  afterBlocks.length > 0 && afterBlocks.every((b) => /always\(\)/.test(b.slice(0, 120))));
// 서버를 띄우기 전에 쓸어야 한다 — 테스트가 이미 시작된 뒤면 방금 만든 것을 지운다.
const jobs = wf.split('\n  e2e').slice(1);
check('쓸기가 서버 기동보다 먼저다', jobs.every((j) => {
  const sweep = j.indexOf('시험 데이터 쓸기(시작 전)');
  const start = j.indexOf('name: Start server');
  return sweep >= 0 && start >= 0 && sweep < start;
}));

console.log('\n[oid로 정리하지 않는다]');
// createOrder는 oid를 덮어쓴다. 그걸로 자기 데이터를 찾으면 영원히 못 찾는다.
const dirs = ['scripts', 'tests/manual'];
const offenders = [];
for (const d of dirs) {
  for (const n of fs.readdirSync(path.join(ROOT, d)).filter((x) => x.endsWith('.js'))) {
    const src = stripJs(fs.readFileSync(path.join(ROOT, d, n), 'utf8'));
    if (/createOrder\(/.test(src) && /oid LIKE/.test(src)) offenders.push(`${d}/${n}`);
  }
}
check('createOrder를 쓰는 곳은 oid로 정리하지 않는다', offenders.length === 0, offenders.join(', '));

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
