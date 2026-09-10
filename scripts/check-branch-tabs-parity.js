// 지사 설정 탭 목록이 EJS와 Next에서 같은지 본다.
//
// 무엇을 막나: 지사 설정 화면은 열세 개인데 탭 줄은 한 벌이어야 한다. 이관 도중에는 두 벌이
// 되므로(EJS views/partials/branch_tabs.ejs, Next src/app/branches/_components/BranchTabs.js)
// 한쪽에만 탭을 더하면 **같은 화면인데 탭이 다르게 보인다** — 그 차이를 사용자는 "어느
// 화면이 Next인지"로 읽는다. 실제로 이 저장소는 프리미엄(대리) 요금 탭을 EJS에만 더한 적이
// 있고(2026-09-09), 그때 Next 판이 없어서 드러나지 않았을 뿐이다.
//
// 이관이 끝나 EJS 쪽이 지워지면 이 검사도 함께 지운다.
//
// 파일만 읽는다 — CI에서 돌 수 있다.
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

// { key: '...', label: '...', path: '...' } 를 순서대로 뽑는다. 주석은 걷어낸다.
function tabsOf(src) {
  const body = src.split('\n').filter((l) => !/^\s*(\/\/|<%#)/.test(l)).join('\n');
  return [...body.matchAll(/\{\s*key:\s*'([^']+)',\s*label:\s*'([^']+)',\s*path:\s*'([^']+)'\s*\}/g)]
    .map((m) => `${m[1]}|${m[2]}|${m[3]}`);
}

const ejs = tabsOf(read('views/partials/branch_tabs.ejs'));
const next = tabsOf(read('src/app/branches/_components/BranchTabs.js'));

console.log('[지사 설정 탭이 두 화면에서 같다]');
check('EJS 탭을 읽었다', ejs.length > 0, `${ejs.length}개`);
check('Next 탭을 읽었다', next.length > 0, `${next.length}개`);
check('개수가 같다', ejs.length === next.length, `EJS ${ejs.length} / Next ${next.length}`);
// 순서까지 같아야 한다 — 탭 순서가 다르면 같은 자리를 눌러도 다른 화면이 열린다.
check('내용과 순서가 같다', ejs.join('\n') === next.join('\n'),
  ejs.filter((t, i) => next[i] !== t).map((t) => `EJS ${t} ≠ Next ${next[ejs.indexOf(t)] || '(없음)'}`).join('\n       ')
  || next.filter((t) => !ejs.includes(t)).map((t) => `Next에만 ${t}`).join('\n       '));

console.log('\n[탭이 가리키는 화면이 실제로 있다]');
const routes = read('routes/branches.js');
for (const t of next) {
  const [, label, p] = t.split('|');
  // /branches/:id/<path> 라우트가 있어야 한다. 'edit'만 지사 신규(/new)와 짝을 이룬다.
  check(`${label} → /${p}`, new RegExp(`router\\.get\\('/:id/${p}'`).test(routes));
}

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
