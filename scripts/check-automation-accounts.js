// 자동화가 실사용 계정으로 로그인하지 않는지 본다.
//
// 왜 검사로 못 박나: 이 규칙은 이미 한 번 정해졌는데 **한 곳만 고쳐져서** 되돌아왔다.
// 2026-08-25에 tests/e2e-credentials.js의 기본값을 qa_test_bot으로 바꿨지만
// (그날 접속기록에 admin LOGIN_BLOCKED 5건, qa_test_bot LOGIN_FAILURE 18건,
// LOGIN_RATE_LIMITED 78건이 찍혔다), 로그인 게이트와 워크플로는 admin / seoul_manager /
// seoulmotors 그대로였다. 주석에만 적힌 규칙은 다음 사람이 모른다.
//
// 무엇이 문제인가: 로그인은 단일 세션이다. 자동화가 admin으로 로그인하면 그 계정을 쓰던
// 사람이 그 자리에서 로그아웃된다. 하루 한 번이면 참을 수 있지만, 이 워크플로를 푸시마다
// 돌리려면 낮에도 돌아야 하므로 참을 수 없게 된다. 계정을 QA로 옮기는 것이 그 전제조건이다.
//
// 비밀번호 폴백도 같이 본다. 예전 워크플로에는 'Admin!2345' 같은 값이 박혀 있어서, 시크릿이
// 없으면 조용히 틀린 값으로 로그인을 반복했다 — 그러다 정상 계정까지 로그인 제한에 걸린다.
// 없으면 멈추는 것이 맞다.
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

// 사람이 실제로 쓰는 계정. seed.js가 만드는 데모 계정이지만 운영에서 그대로 쓰고 있다
// (seoulmotors는 가장 최근 접수가 2026-09-07이다).
const HUMAN_ACCOUNTS = ['admin', 'seoul_manager', 'seoulmotors'];

console.log('[워크플로가 실사용 계정을 쓰지 않는다]');
const wf = read('.github/workflows/playwright-e2e.yml');
// 주석은 뺀다 — 사고 경위를 적으려면 계정 이름을 써야 한다.
const wfCode = wf.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
for (const acct of HUMAN_ACCOUNTS) {
  check(`'${acct}'을 계정으로 지정하지 않는다`,
    !new RegExp(`'${acct}'`).test(wfCode),
    `.github/workflows/playwright-e2e.yml에 '${acct}'이 남아 있다`);
}

// env 기본값과 workflow_dispatch 입력 기본값 양쪽을 본다. 예전에 env만 고치고 입력
// 기본값을 두었더니 「Run workflow」를 누른 사람에게 admin이 미리 채워졌다.
const qaDefaults = (wfCode.match(/\|\| '(qa_[a-z0-9_]+)'/g) || []).length
  + (wfCode.match(/default: '(qa_[a-z0-9_]+)'/g) || []).length;
check('QA 계정을 기본값으로 쓴다', qaDefaults >= 9, `qa_* 기본값 ${qaDefaults}곳(9곳 이상이어야 한다)`);

console.log('\n[비밀번호를 하드코딩하지 않는다]');
// 'Admin!2345' 모양 — 영문 + 기호 + 숫자로 된 짧은 리터럴.
const pwLiterals = wfCode.match(/'[A-Za-z][A-Za-z0-9]*[!@#$%^&*][0-9]{2,}'/g) || [];
check('비밀번호 모양 리터럴이 없다', pwLiterals.length === 0, `남아 있다: ${pwLiterals.join(', ')}`);

console.log('\n[로그인 게이트]');
const gate = read('scripts/check-login-all.js');
const gateCode = gate.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
for (const acct of HUMAN_ACCOUNTS) {
  check(`기본값이 '${acct}'이 아니다`, !new RegExp(`\\|\\| '${acct}'`).test(gateCode));
}
check('기본값이 qa_ 계정이다', (gateCode.match(/\|\| 'qa_[a-z0-9_]+'/g) || []).length >= 3);
// 시도 전에 멈춰야 한다. 시도한 뒤에 판정하면 이미 실패가 쌓인다.
//
// **호출**을 본다. 처음에는 /assertSafeAccounts\(accounts\)/로 봤는데, 그건 함수 정의
// (function assertSafeAccounts(accounts))에도 걸려서 호출을 지워도 통과했다. 음성 테스트로
// 잡았다 — 통과하는 것만 확인하면 이런 검사는 아무것도 안 지킨다.
check('시작 전에 계정을 검사한다', /^\s*assertSafeAccounts\(accounts\);\s*$/m.test(gateCode));
// 자격을 만든 직후에 불러야 한다. 로그인 루프 뒤에 부르면 이미 시도가 끝나 있다.
const gateOrder = gateCode.indexOf('assertSafeAccounts(accounts);') < gateCode.indexOf('for (const account of accounts)');
check('로그인 루프보다 먼저 검사한다', gateOrder);
check('비밀번호가 없으면 멈춘다', /if \(!a\.password\)/.test(gateCode) && /process\.exit\(1\)/.test(gateCode));
check('QA 계정이 아니면 멈춘다', /\^qa_/.test(gateCode));
// 일부러 실계정을 점검할 길은 남겨둔다 — 막을 수 없으면 검사를 지우게 된다.
check('의도적 우회 경로가 있다', /ALLOW_NON_QA_LOGIN/.test(gateCode));

console.log('\n[Playwright 스펙]');
const creds = read('tests/e2e-credentials.js');
check('기본 계정이 qa_test_bot이다', /E2E_LOGIN_ID \|\| 'qa_test_bot'/.test(creds));
check('비밀번호가 없으면 던진다', /if \(!PASSWORD\)/.test(creds) && /throw new Error/.test(creds));
// 스펙이 계정을 다시 조립하면 위 두 검사를 우회한다.
//
// 'admin'은 문자열로 찾을 수 없다 — 로그인 ID이면서 **역할 이름**이기도 하다
// (currentRole === 'admin', 역할 선택 드롭다운). 처음에 그걸 그대로 찾다가 멀쩡한 스펙 둘을
// 잡았다. 그래서 로그인 ID로만 쓰이는 두 개를 문자열로 보고, 'admin'은 자격을 어디서
// 얻는지로 본다.
const specs = fs.readdirSync(path.join(ROOT, 'tests/manual')).filter((n) => n.endsWith('.js'));
const specSrc = new Map(specs.map((n) => [n, fs.readFileSync(path.join(ROOT, 'tests/manual', n), 'utf8')]));

const namedHuman = specs.filter((n) => ['seoul_manager', 'seoulmotors']
  .some((a) => new RegExp(`['"\`]${a}['"\`]`).test(specSrc.get(n))));
check('스펙이 실사용 계정을 직접 적지 않는다', namedHuman.length === 0, namedHuman.join(', '));

// 비밀번호를 직접 읽으면 없을 때 ''로 로그인을 시도하게 된다. e2e-credentials는 던진다.
// 실제로 스펙 3개가 그 상태였다(office-zone-fares, settlement-print,
// vehicle-models-dictionary) — 계정은 qa_test_bot이라 안전해 보였지만, 폴백이 ''였다.
const ownPassword = specs.filter((n) => /process\.env\.E2E_PASSWORD/.test(specSrc.get(n)));
check('스펙이 비밀번호를 직접 읽지 않는다', ownPassword.length === 0, ownPassword.join(', '));

// 로그인하는 스펙은 공용 모듈에서 자격을 얻어야 한다.
const logsIn = (src) => /login_id|loginWithRetry|['"]\/login['"]/.test(src);
const missingCreds = specs.filter((n) => logsIn(specSrc.get(n)) && !/e2e-credentials/.test(specSrc.get(n)));
check('로그인하는 스펙은 공용 모듈을 쓴다', missingCreds.length === 0, missingCreds.join(', '));

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
