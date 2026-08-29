// EJS 파셜과 Next 컴포넌트의 탭 목록이 같은지 확인한다.
//
// 왜 필요한가(2026-08-29 지적): 법인 관리 상단 탭을 EJS(views/partials/group_tabs.ejs)와
// Next(src/app/groups/_components/GroupTabs.js)가 각각 갖고 있는데, EJS에만 '정산내역'과
// '지점 구간요금'을 더해서 **Next가 그리는 화면에서는 그 두 탭이 아예 안 보였다.**
// 탭이 보이는 화면과 안 보이는 화면이 섞이니 "정산내역이 안 나온다"가 된다.
//
// 이런 이중 화면은 한쪽만 고치기 쉽고, 고친 사람은 자기가 연 화면에서 잘 보이니 눈치채지 못한다.
// 사람이 기억하는 대신 검사로 막는다.
const fs = require('fs');
const path = require('path');

// { key: '...', label: '...', path: '...' } 형태를 양쪽에서 같은 방법으로 뽑는다.
const DEF_RE = /\{\s*key:\s*'([a-z_]+)',\s*label:\s*'([^']+)',\s*path:\s*'([^']+)'\s*\}/g;

function readDefs(file) {
  const full = path.join(__dirname, '..', file);
  const text = fs.readFileSync(full, 'utf8');
  return [...text.matchAll(DEF_RE)].map((m) => `${m[1]} | ${m[2]} | ${m[3]}`);
}

// 같은 탭 줄을 그리는 파일 쌍. 새 이중 화면이 생기면 여기에 더한다.
const PAIRS = [
  { name: '법인 관리 탭', ejs: 'views/partials/group_tabs.ejs', next: 'src/app/groups/_components/GroupTabs.js' },
];

let failures = 0;
for (const pair of PAIRS) {
  console.log(`[${pair.name}]`);
  let a; let b;
  try {
    a = readDefs(pair.ejs);
    b = readDefs(pair.next);
  } catch (e) {
    console.log(`  FAIL 파일을 읽지 못했습니다: ${e.message}`);
    failures += 1;
    continue;
  }

  if (!a.length || !b.length) {
    // 정규식이 안 맞으면 조용히 "둘 다 0개라 같다"가 되어 검사가 무의미해진다.
    console.log(`  FAIL 탭 정의를 찾지 못했습니다 (EJS ${a.length}개 / Next ${b.length}개) — 형식이 바뀌었는지 확인하세요.`);
    failures += 1;
    continue;
  }

  const same = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${same ? 'OK  ' : 'FAIL'} 두 화면의 탭이 ${same ? '같습니다' : '다릅니다'} (각 ${a.length} / ${b.length}개)`);
  if (!same) {
    failures += 1;
    const onlyEjs = a.filter((x) => !b.includes(x));
    const onlyNext = b.filter((x) => !a.includes(x));
    if (onlyEjs.length) console.log('    EJS에만 있음 :', onlyEjs.join(' , '));
    if (onlyNext.length) console.log('    Next에만 있음:', onlyNext.join(' , '));
    // 순서만 다른 경우도 잡는다 — 관리자가 보는 줄이 화면마다 다르면 그것도 버그다.
    if (!onlyEjs.length && !onlyNext.length) console.log('    항목은 같은데 순서가 다릅니다.');
  } else {
    a.forEach((x, i) => console.log(`       ${String(i + 1).padStart(2)} ${x}`));
  }
}

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
