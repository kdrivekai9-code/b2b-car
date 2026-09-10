// 오더 상태 배지 색이 Express(config.js)와 Next에서 같은지 본다.
//
// 무엇을 막나(2026-09-10 실측): Next 오더 목록이 자기 사본을 들고 있었는데 **'예약'이 빠져
// 있었다**. 그래서 예약 오더의 배지가 EJS에서는 indigo, Next에서는 회색으로 나왔다 —
// 프로덕션에서 그 화면은 Next였으므로, 실제로 고객·상담원이 보는 색이 틀려 있었다.
//
// 빠진 상태는 조용하다. 코드가 `STATUS_COLORS[s] || 'gray'`로 떨어지기 때문에 오류가 안 나고
// 그냥 회색이 된다 — 상태값이 늘어날 때마다 같은 일이 반복될 수 있다.
//
// 파일만 읽는다 — CI에서 돌 수 있다.
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { STATUS_COLORS: server, ORDER_STATUSES } = require(path.join(ROOT, 'config'));
const fs = require('fs');

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

// Next 쪽은 ESM이라 require로 못 읽는다 — 파일에서 뽑는다.
const src = fs.readFileSync(path.join(ROOT, 'src/app/_lib/statusColors.js'), 'utf8');
const next = {};
for (const m of src.matchAll(/'([^']+)':\s*'([a-z]+)',/g)) next[m[1]] = m[2];

console.log('[상태 배지 색이 한 벌이다]');
check('Next 정의를 읽었다', Object.keys(next).length > 0, `${Object.keys(next).length}개`);

const missing = Object.keys(server).filter((k) => !(k in next));
const extra = Object.keys(next).filter((k) => !(k in server));
const differ = Object.keys(next).filter((k) => k in server && server[k] !== next[k]);
check('Express에 있는 상태가 다 있다', missing.length === 0,
  `빠진 것: ${missing.join(', ')} — 배지가 회색으로 떨어진다`);
check('Next에만 있는 상태가 없다', extra.length === 0, extra.join(', '));
check('색이 같다', differ.length === 0,
  differ.map((k) => `${k}: Express ${server[k]} ≠ Next ${next[k]}`).join(', '));

// 상태값이 늘면 색도 함께 정해야 한다 — 안 정하면 그 상태만 회색이 된다.
const uncolored = ORDER_STATUSES.filter((s) => !(s in server));
check('모든 오더 상태에 색이 있다', uncolored.length === 0, uncolored.join(', '));

console.log('\n[사본을 만들지 않는다]');
// 화면마다 자기 목록을 들고 있으면 같은 누락이 되돌아온다.
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}
const offenders = walk(path.join(ROOT, 'src/app'))
  .filter((f) => !f.endsWith('_lib/statusColors.js'))
  .filter((f) => /const STATUS_COLORS = \{/.test(fs.readFileSync(f, 'utf8')))
  .map((f) => path.relative(ROOT, f));
check('src/app 안에 다른 정의가 없다', offenders.length === 0,
  offenders.join(', ') + ' — _lib/statusColors에서 import할 것');

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
