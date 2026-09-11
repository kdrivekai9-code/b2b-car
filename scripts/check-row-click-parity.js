// 목록에서 **행 전체를 눌러 상세로 가는** 동작이 Next에도 있는지 본다.
//
// 무엇을 막나(2026-09-11 실사용 지적): 문의 관리 목록이 Next로 이식되면서 행 클릭이 빠졌다.
// 그런데 `cursor: pointer`는 그대로 남아서 **눌리는 것처럼 보이는데 아무 일도 안 일어났다** —
// 사용자에게는 "상세 페이지가 안 나온다"로 보인다. 실제로는 맨 왼쪽 ID 숫자를 눌러야만 열렸다.
//
// 목록에서 문의 요약이 40자로 잘리므로 상세로 가는 길이 곧 그 화면의 쓸모다. 링크 하나가
// 남아 있어도 "되는 것처럼 보이는데 안 되는" 상태가 더 나쁘다.
//
// 파일만 읽는다 — CI에서 돌 수 있다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return ''; }
};

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

console.log('[공용 부품이 있다]');
const comp = read('src/app/_components/ClickableRow.js');
check('ClickableRow가 있다', comp.length > 0);
check('클라이언트 컴포넌트다', /^'use client';/m.test(comp));
// 안쪽 링크·버튼 위의 클릭까지 가로채면 수정·삭제가 안 눌린다.
check('안쪽 링크·버튼은 그대로 둔다', /closest\('a, button, input, select, textarea, label'\)/.test(comp));

console.log('\n[EJS에서 행이 클릭되던 목록은 Next에서도 클릭된다]');
// EJS에서 `<tr onclick="location.href=...">`를 쓰는 목록을 찾아, 짝이 되는 Next 화면을 본다.
const PAIRS = [
  ['문의 관리', 'views/inquiries/list.ejs', ['src/app/inquiries/page.js']],
  ['공지사항', 'views/notices/list.ejs', ['src/app/notices/page.js']],
  // 오더 목록은 클라이언트 컴포넌트라 router.push로 직접 처리한다(부품을 쓰지 않는다).
  ['오더 리스트', 'views/orders/list.ejs', ['src/app/orders/OrderListTable.js']],
];
for (const [label, ejsPath, nextPaths] of PAIRS) {
  const ejs = read(ejsPath);
  const hasEjs = /onclick="location\.href/.test(ejs);
  check(`${label}: EJS에서 행이 클릭된다`, hasEjs, `${ejsPath}에서 사라졌다면 이 대조도 지워야 한다`);
  if (!hasEjs) continue;
  const next = nextPaths.map(read).join('\n');
  // ClickableRow를 쓰거나, 클라이언트 컴포넌트가 직접 router.push 한다.
  const ok = /<ClickableRow/.test(next) || /router\.push\(`\/[a-z-]+\/\$\{/.test(next);
  check(`${label}: Next에서도 행이 클릭된다`, ok,
    `${nextPaths.join(', ')} — ClickableRow로 감싸거나 router.push로 직접 처리할 것`);
}

console.log('\n[손 모양 커서만 남기지 않는다]');
// 눌리는 것처럼 보이는데 안 되는 상태가 아예 안 되는 것보다 나쁘다.
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}
const offenders = [];
for (const file of walk(path.join(ROOT, 'src/app'))) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/<tr\b/.test(lines[i])) continue;
    if (!/cursor: 'pointer'/.test(lines[i])) continue;
    // 같은 줄에 onClick이 있으면 정상. ClickableRow는 <tr>이 아니라 부품 이름으로 쓰인다.
    if (/onClick/.test(lines[i])) continue;
    offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
  }
}
check('눌리지 않는 pointer 행이 없다', offenders.length === 0,
  offenders.join(', ') + ' — 커서만 바뀌고 아무 일도 안 일어난다');

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
