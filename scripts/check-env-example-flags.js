// 코드가 읽는 플래그가 .env.example에 다 적혀 있는지 본다.
//
// 왜 필요한가(2026-09-08 확인): 프로덕션은 경로 20개 전수가 EJS였다. Vercel 환경변수에는
// NEXT_* 중 두 개만 있었고 그 둘도 Preview 범위였다. 로컬 .env에는 26개가 켜져 있었다 —
// 즉 이관한 화면 전부가 프로덕션에서 아무도 안 쓰는 상태였고, 아무도 그걸 몰랐다.
//
// 원인은 .env.example이었다. 화면을 이관할 때마다 플래그를 만들어 로컬 .env에는 넣었는데
// 템플릿에는 안 적었다. 그러면 프로덕션 env를 채우는 사람에게 **목록 자체가 없다** —
// 무엇을 넣어야 하는지 알 방법이 없고, 빠뜨려도 아무 곳에도 흔적이 안 남는다. 16개가 그렇게
// 빠져 있었다.
//
// 그래서 사람이 기억하는 대신 **코드에서 읽는 이름과 템플릿을 대조**한다. 새 플래그를 만들고
// 템플릿에 안 적으면 여기서 잡힌다.
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

const example = read('.env.example');
const documented = new Set((example.match(/^[A-Z][A-Z0-9_]*=/gm) || []).map((m) => m.slice(0, -1)));

console.log('[프록시가 읽는 플래그가 템플릿에 다 있다]');
const proxy = read('src/proxy.js');
// PATH_FLAGS 값, idSuffixRoutes의 flag, 그리고 직접 참조(process.env.NEXT_...) 전부.
const flags = new Set([
  ...(proxy.match(/'(NEXT_[A-Z0-9_]+)'/g) || []).map((m) => m.slice(1, -1)),
  ...(proxy.match(/process\.env\.(NEXT_[A-Z0-9_]+)/g) || []).map((m) => m.replace('process.env.', '')),
]);
check('플래그를 찾았다', flags.size > 0, `${flags.size}개`);
const missing = [...flags].filter((f) => !documented.has(f)).sort();
check('빠진 플래그가 없다', missing.length === 0,
  `.env.example에 없음: ${missing.join(', ')}\n       템플릿에 없으면 프로덕션 env를 채우는 사람이 알 방법이 없다`);

console.log('\n[값 형식이 문서와 코드에서 같다]');
// src/proxy.js는 === 'true'로 문자열을 그대로 비교한다. True·1은 조용히 안 먹는다.
check('코드가 소문자 true를 비교한다', /=== 'true'/.test(proxy));
check('그 사실이 템플릿에 적혀 있다', /소문자 'true'/.test(example));
// 템플릿의 기본값은 꺼진 상태여야 한다 — 켜진 값을 예시로 두면 그대로 복사돼 나간다.
const enabledInExample = (example.match(/^NEXT_[A-Z0-9_]+=true$/gm) || []);
check('템플릿 기본값이 전부 꺼져 있다', enabledInExample.length === 0, enabledInExample.join(', '));

console.log('\n[로컬 .env와도 어긋나지 않는다]');
// .env는 저장소에 없다(개인 파일). 있을 때만 본다 — 로컬에만 있는 플래그는 템플릿에
// 적히지 않은 채 잊히기 쉽다.
const envPath = path.join(ROOT, '.env');
if (!fs.existsSync(envPath)) {
  check('로컬 .env 없음 — 건너뜀', true);
} else {
  const local = new Set((fs.readFileSync(envPath, 'utf8').match(/^NEXT_[A-Z0-9_]+=/gm) || [])
    .map((m) => m.slice(0, -1)));
  const onlyLocal = [...local].filter((f) => !documented.has(f)).sort();
  check('로컬에만 있는 플래그가 없다', onlyLocal.length === 0, onlyLocal.join(', '));
}

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
