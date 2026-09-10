// 되돌릴 수 없는 동작 앞에 확인창이 있는지 본다 — EJS와 Next 양쪽 모두.
//
// 무엇을 막나(2026-09-10 실측): EJS는 삭제·세션 종료 앞에
// `onsubmit="return confirm(...)"`을 두는데, Next로 이식하면서 **다섯 화면에서 그게 조용히
// 사라졌다** — 공지 목록·공지 상세·지식베이스 목록·분류 목록·계정 접속 종료. 전부 프로덕션에서
// Next로 서비스 중이었고, 버튼을 잘못 누르면 확인 없이 바로 지워졌다.
//
// 왜 빠졌나: 서버 컴포넌트는 onSubmit 같은 핸들러를 붙일 수 없다. 그래서 이식할 때 그냥
// <form>으로 옮겨졌고, 눈에 띄는 차이가 없어 아무도 못 봤다. 화면마다 작은 클라이언트
// 컴포넌트를 새로 만들면 다음 이식에서 또 빠지므로 공용 부품(_components/ConfirmForm.js)을
// 두고, 이 검사가 "그 부품을 썼는지"를 지킨다.
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

console.log('[공용 부품이 있다]');
const componentPath = 'src/app/_components/ConfirmForm.js';
check('ConfirmForm이 있다', fs.existsSync(path.join(ROOT, componentPath)));
if (fs.existsSync(path.join(ROOT, componentPath))) {
  const c = read(componentPath);
  check('클라이언트 컴포넌트다', /^'use client';/m.test(c), '서버 컴포넌트는 onSubmit을 붙일 수 없다');
  check('확인을 거절하면 막는다', /window\.confirm\(message\)\) e\.preventDefault\(\)/.test(c));
  // 메시지를 안 넘겼을 때 조용히 막아버리면 버튼이 죽는다.
  check('메시지가 없으면 그냥 보낸다', /if \(message &&/.test(c));
}

console.log('\n[되돌릴 수 없는 동작에 확인창이 있다]');
// 이 목록은 **되돌릴 수 없는 것**만이다. 지우기·접속 종료·상담 종료.
//
// toggle(사용/중지)은 뺐다 — 되돌릴 수 있어서 EJS도 확인을 안 묻는다. 넣어두면 기사 목록·
// 결제방식 같은 멀쩡한 화면이 계속 걸려서, 검사가 "무시해도 되는 경고"가 된다.
const DESTRUCTIVE_RE = /\/(delete|revoke-session|close)(['"`}]|$)/;

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
    const l = lines[i];
    // POST form의 action이 파괴적 경로인가
    if (!/<form[\s\S]{0,200}?method="POST"|<form[^>]*action=/.test(l)) continue;
    if (!/action=/.test(l) || !DESTRUCTIVE_RE.test(l)) continue;
    // 같은 줄이 이미 ConfirmForm이면 통과. 클라이언트 컴포넌트 안에서 window.confirm으로
    // 직접 막는 경우도 있다(CardBoard 등) — 그 파일은 'use client'라 핸들러를 붙일 수 있다.
    if (/<ConfirmForm/.test(l)) continue;
    if (/^'use client';/m.test(src) && /window\.confirm\(/.test(src)) continue;
    offenders.push(`${path.relative(ROOT, file)}:${i + 1}  ${l.trim().slice(0, 90)}`);
  }
}
check('확인 없이 실행되는 파괴적 form이 없다', offenders.length === 0,
  offenders.join('\n       ') + '\n       ConfirmForm으로 감싸거나(서버 컴포넌트), 클라이언트에서 window.confirm으로 막을 것');

console.log('\n[EJS에 있던 확인창이 Next에도 있다]');
// EJS 원본에 확인창이 있던 화면들 — 이식된 짝을 콕 집어 대조한다.
const PAIRS = [
  ['공지 상세 삭제', 'views/notices/detail.ejs', 'src/app/notices/[id]/page.js'],
  ['지식베이스 삭제', 'views/knowledge_base/list.ejs', 'src/app/knowledge-base/page.js'],
  ['분류 삭제', 'views/knowledge_base/categories.ejs', 'src/app/knowledge-base/categories/page.js'],
  ['계정 접속 종료', 'views/users/list.ejs', 'src/app/users/page.js'],
  ['빠른답변 삭제', 'views/quick_replies/index.ejs', 'src/app/quick-replies/page.js'],
];
// Next가 **새로 만든** 삭제 버튼들 — EJS에는 없어서 위 대조로는 안 잡힌다.
// 이식하면서 기능을 더한 것 자체는 좋지만, 그때 확인창은 같이 안 왔다(2026-09-10 실측).
const NEXT_ONLY = [
  ['공지 목록 삭제(Next에만 있음)', 'src/app/notices/page.js'],
  ['거점 별칭 삭제(Next에만 있음)', 'src/app/location-aliases/page.js'],
];
for (const [label, nextPath] of NEXT_ONLY) {
  check(label, /<ConfirmForm/.test(read(nextPath)), `${nextPath}에 확인창이 없다`);
}

for (const [label, ejsPath, nextPath] of PAIRS) {
  const ejs = read(ejsPath);
  const hasEjs = /onsubmit="return confirm/.test(ejs);
  if (!hasEjs) { check(`${label}: EJS 원본에 확인창이 있다`, false, `${ejsPath}에서 사라졌다`); continue; }
  const next = read(nextPath);
  check(`${label}`, /<ConfirmForm/.test(next) || /window\.confirm\(/.test(next),
    `${nextPath}에 확인창이 없다`);
}

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
