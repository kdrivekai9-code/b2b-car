// Next 페이지가 DB에 닿는 모듈을 import하지 않는지 본다.
//
// 왜 필요한가(2026-09-08 실사고): 알림 설정 Next 페이지가 상수 두 개를 쓰려고
// lib/kakaoOrderNotify를 import했다. 그 모듈은 ../db를 require하고 **db.js는 모듈 로드
// 시점에 던진다** — DATABASE_URL이 없으면 질의를 한 줄도 안 하는 코드까지 같이 죽는다.
//
// 그래서 `next build`가 "Failed to collect page data for /push/settings"로 실패했고,
// 프로덕션 배포 하나가 실패해 그 프로젝트는 이전 코드에 그대로 남았다. 상수 두 개 때문에.
//
// **로컬에서는 안 드러난다.** .env가 있어서 db.js가 던지지 않으므로 빌드가 통과한다. CI에서만
// 실패한다. 같은 함정을 CI 검사 목록에서도 겪었다 — 그때도 .env가 있는 로컬에서 재서 24개가
// CI에서 한꺼번에 죽었다.
//
// 로컬에서 그 조건을 재현하려면 **`DATABASE_URL= npx next build`**를 쓴다. dotenv는 이미
// 설정된 키를 덮어쓰지 않으므로 빈 값이 그대로 남고 db.js가 던진다(확인함).
// `.env`를 잠깐 옮겼다 되돌리는 방식은 쓰지 말 것 — 한 디렉터리에서 여러 작업이 동시에
// 돌면 되돌리는 단계가 어긋나 **추적되지 않는 그 파일이 사라진다**(2026-09-10에 실제로 잃었다).
//
// 규칙: Next 페이지가 import하는 lib 모듈은 DB에 닿지 않아야 한다. 값이 필요하면 상수만 담은
// 파일로 빼거나(lib/notifyEvents.js처럼), 서버 엔드포인트를 통해 받는다.
//
// 파일만 읽는다 — CI에서 돌 수 있다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

// src/app 아래 모든 .js를 훑는다.
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

// 그 모듈(과 그 모듈이 require하는 것들)이 db에 닿는지. 한 겹만 보면 놓친다 —
// lib/kakaoOrderNotify는 직접 ../db를 require하지만, 사이에 한 단계가 끼면 안 보인다.
const dbCache = new Map();
function touchesDb(libFile, depth = 0) {
  if (dbCache.has(libFile)) return dbCache.get(libFile);
  if (depth > 4 || !fs.existsSync(libFile)) return false;
  dbCache.set(libFile, false); // 순환 방지
  const src = fs.readFileSync(libFile, 'utf8');
  if (/require\(['"](\.\.?\/)+db['"]\)/.test(src)) { dbCache.set(libFile, true); return true; }
  const deps = [...src.matchAll(/require\(['"](\.\/[a-zA-Z0-9_-]+)['"]\)/g)].map((m) => m[1]);
  for (const d of deps) {
    if (touchesDb(path.join(path.dirname(libFile), `${d}.js`), depth + 1)) {
      dbCache.set(libFile, true);
      return true;
    }
  }
  return false;
}

console.log('[Next 페이지가 DB 모듈을 import하지 않는다]');
const pages = walk(path.join(ROOT, 'src/app'));
check('src/app 파일을 찾았다', pages.length > 0, `${pages.length}개`);

const offenders = [];
for (const file of pages) {
  const src = fs.readFileSync(file, 'utf8');
  // import ... from '.../lib/xxx'  와  require('.../lib/xxx') 둘 다 본다.
  const mods = [
    ...[...src.matchAll(/from\s+['"][^'"]*\/lib\/([a-zA-Z0-9_-]+)['"]/g)].map((m) => m[1]),
    ...[...src.matchAll(/require\(['"][^'"]*\/lib\/([a-zA-Z0-9_-]+)['"]\)/g)].map((m) => m[1]),
  ];
  for (const mod of [...new Set(mods)]) {
    if (touchesDb(path.join(ROOT, 'lib', `${mod}.js`))) {
      offenders.push(`${path.relative(ROOT, file)} → lib/${mod}`);
    }
  }
}
check('DB에 닿는 lib 모듈을 import하지 않는다', offenders.length === 0,
  `${offenders.join('\n       ')}\n       db.js는 모듈 로드 시점에 던진다 — next build가 실패한다(로컬은 .env가 있어 안 드러난다)`);

console.log('\n[상수는 DB 없는 모듈에 둔다]');
// 이 사고를 풀 때 만든 모듈. 여기 db가 들어오면 같은 문제가 되돌아온다.
const eventsPath = path.join(ROOT, 'lib/notifyEvents.js');
if (!fs.existsSync(eventsPath)) {
  check('lib/notifyEvents.js가 있다', false, '통보 종류·기본 문구를 담은 상수 모듈이 사라졌다');
} else {
  check('lib/notifyEvents.js가 DB에 닿지 않는다', !touchesDb(eventsPath));
  const events = fs.readFileSync(eventsPath, 'utf8');
  check('통보 종류를 내보낸다', /EVENT_TYPES/.test(events) && /DEFAULT_EVENT_SETTINGS/.test(events));
  // 값이 두 곳에 있으면 갈린다 — kakaoOrderNotify는 이 모듈을 봐야 한다.
  const notify = fs.readFileSync(path.join(ROOT, 'lib/kakaoOrderNotify.js'), 'utf8');
  check('kakaoOrderNotify가 그 모듈을 쓴다', /require\('\.\/notifyEvents'\)/.test(notify));
  check('kakaoOrderNotify에 사본이 없다',
    !/^const DEFAULT_EVENT_SETTINGS = \{/m.test(notify), '상수가 두 곳에 있으면 갈린다');
}

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
