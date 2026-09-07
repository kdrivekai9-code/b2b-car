// QA 계정 비밀번호가 DB의 값과 맞는지 확인한다. 로그인 시도를 하지 않는다.
//
// 왜 필요한가: GitHub 시크릿에 값을 넣었는데 CI에서 전부 401이 났다. access_logs를 보니
// LOGIN_FAILURE에 user_id가 찍혀 있었다 — **계정은 찾았고 비밀번호가 거부됐다.** 즉 시크릿의
// 값이 DB의 값과 달랐다. 시크릿은 한 번 넣으면 다시 읽을 수 없으니, 틀렸는지 확인할 방법이
// 없으면 CI를 돌려보는 것 말고 길이 없다. 그건 한 번에 6번씩 로그인 실패를 쌓는다
// (계정 3개 × 잡 2개). 실패가 쌓이면 로그인 제한(IP당 15분 10회)에 걸려 정상 계정까지 잠긴다.
//
// 그래서 로그인을 하지 않고 bcrypt 해시로만 대조한다. 네트워크도 세션도 건드리지 않으므로
// 몇 번을 돌려도 아무것도 잠기지 않는다.
//
// 비밀번호는 화면에 안 보이게 받고, 어디에도 기록하지 않는다. 인자로 받지 않는 이유는
// 셸 이력과 프로세스 목록(ps)에 남기 때문이다.
//
// 쓰는 법:
//   node scripts/verify-qa-password.js                  → 어느 QA 계정 것인지 찾아준다
//   node scripts/verify-qa-password.js qa_test_bot      → 그 계정과 맞는지만 본다
require('dotenv').config();
const readline = require('readline');
const bcrypt = require('bcryptjs');
const db = require('./../db');

// 파이프로 들어온 입력은 **가리는 처리를 하면 안 된다.**
//
// 처음에 terminal: true로 고정하고 가리기 훅을 걸었더니, stdin이 터미널이 아닐 때
// (`... | node scripts/verify-qa-password.js`) readline이 입력을 그대로 화면에 되쓰면서
// 비밀번호가 출력에 찍혔다. 실제로 한 번 노출됐다.
//
// 터미널일 때만 가린다. 파이프일 때는 터미널이 애초에 입력을 되쓰지 않으므로 그냥 한 줄
// 읽으면 되고, 아무것도 화면에 안 남는다.
function askHidden(prompt) {
  const isTty = process.stdin.isTTY === true;
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: isTty ? process.stdout : undefined,
      terminal: isTty,
    });
    if (!isTty) {
      rl.question('', (answer) => { rl.close(); resolve(answer); });
      return;
    }
    // 터미널에서는 입력을 화면에 찍지 않는다 — readline이 쓰려는 것을 가로챈다.
    const onData = (char) => {
      if (['\n', '\r', ''].includes(char)) return;
      readline.moveCursor(process.stdout, -1000, 0);
      readline.clearLine(process.stdout, 1);
      process.stdout.write(prompt);
    };
    process.stdin.on('data', onData);
    rl.question(prompt, (answer) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

(async () => {
  const wanted = (process.argv[2] || '').trim();
  const users = await db.all(
    wanted
      ? 'SELECT login_id, password_hash, role, status FROM users WHERE login_id = ?'
      : "SELECT login_id, password_hash, role, status FROM users WHERE login_id LIKE 'qa%' ORDER BY login_id",
    wanted ? [wanted] : []
  );

  if (!users.length) {
    console.log(wanted ? `'${wanted}' 계정이 없습니다.` : 'QA 계정이 없습니다.');
    process.exit(1);
  }

  const pw = await askHidden('비밀번호(화면에 안 보입니다): ');
  if (!pw) {
    console.log('입력이 없었습니다.');
    process.exit(1);
  }

  // 눈에 안 보이는 차이가 가장 흔한 원인이다. 붙여넣을 때 줄바꿈이나 공백이 따라온다.
  const trimmed = pw.replace(/[\r\n]+$/, '').trim();
  if (trimmed !== pw) {
    console.log(`\n※ 입력 끝에 공백이나 줄바꿈이 있습니다(${pw.length}자 → ${trimmed.length}자).`);
    console.log('  시크릿에 이렇게 들어갔다면 그것만으로 로그인이 거부됩니다.');
  }

  console.log('');
  let anyHit = false;
  for (const u of users) {
    const asIs = bcrypt.compareSync(pw, u.password_hash);
    const asTrimmed = !asIs && trimmed !== pw && bcrypt.compareSync(trimmed, u.password_hash);
    if (asIs || asTrimmed) anyHit = true;
    const mark = asIs ? '일치' : (asTrimmed ? '공백 제거하면 일치' : '불일치');
    console.log(`  ${mark.padEnd(16)} ${u.login_id} (${u.role}, ${u.status})`);
  }

  if (!anyHit) {
    console.log('\n맞는 계정이 없습니다. 이 값으로는 로그인되지 않습니다.');
    console.log('관리자 화면(사용자 관리 → 해당 계정 → 비밀번호)에서 값을 새로 정한 뒤,');
    console.log('같은 값을 GitHub 시크릿에 넣으면 됩니다 — 두 곳을 같이 바꿔야 합니다.');
  }
  process.exit(anyHit ? 0 : 1);
})().catch((e) => {
  console.error('확인 실패:', e.message);
  process.exit(1);
});
