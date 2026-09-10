// 지사·법인 설정 탭 목록이 EJS와 Next에서 같은지 본다.
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

// 지사와 법인이 각각 EJS/Next 한 벌씩 갖고 있다 — 넷을 두 쌍으로 대조한다.
//
// 법인 쪽에서 이 사고가 먼저 났다(2026-08-29): EJS에 '정산내역'과 '지점 구간요금'을 더하면서
// Next 파일을 안 고쳐서, Next가 그리는 화면에서는 그 탭이 아예 보이지 않았다. 두 탭이 보이는
// 화면과 안 보이는 화면이 섞여 "정산내역이 안 나온다"가 됐다.
const PAIRS = [
  { label: '지사', ejs: 'views/partials/branch_tabs.ejs', next: 'src/app/branches/_components/BranchTabs.js', routes: 'routes/branches.js' },
  { label: '법인', ejs: 'views/partials/group_tabs.ejs', next: 'src/app/groups/_components/GroupTabs.js', routes: 'routes/groups.js' },
];

for (const pair of PAIRS) {
  const ejs = tabsOf(read(pair.ejs));
  const next = tabsOf(read(pair.next));

  console.log(`[${pair.label} 설정 탭이 두 화면에서 같다]`);
  check(`${pair.label}: EJS 탭을 읽었다`, ejs.length > 0, `${ejs.length}개`);
  check(`${pair.label}: Next 탭을 읽었다`, next.length > 0, `${next.length}개`);
  check(`${pair.label}: 개수가 같다`, ejs.length === next.length, `EJS ${ejs.length} / Next ${next.length}`);
  // 순서까지 같아야 한다 — 탭 순서가 다르면 같은 자리를 눌러도 다른 화면이 열린다.
  check(`${pair.label}: 내용과 순서가 같다`, ejs.join('\n') === next.join('\n'),
    ejs.filter((t, i) => next[i] !== t).map((t) => `EJS ${t} ≠ Next ${next[i] || '(없음)'}`).join('\n       ')
    || next.filter((t) => !ejs.includes(t)).map((t) => `Next에만 ${t}`).join('\n       '));

  console.log(`\n[${pair.label} 탭이 가리키는 화면이 실제로 있다]`);
  const routes = read(pair.routes);
  for (const t of next) {
    const [, label, p] = t.split('|');
    check(`${pair.label}: ${label} → /${p}`, new RegExp(`router\\.get\\('/:id/${p}'`).test(routes));
  }
  console.log('');
}

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
