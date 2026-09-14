// 프록시가 보는 Next 전환 플래그가 **운영에 실제로 등록돼 있는지** 확인한다.
//
// 왜 필요한가(2026-09-14 실사고): /upload/:token(기사 사진 업로드) Next 페이지를 만들고
// 빌드까지 통과했는데, 프록시가 보는 NEXT_UPLOAD_ENABLED가 Vercel 운영 환경변수에 등록되지
// 않았다. 그래서 운영은 계속 EJS를 내보냈다 — **만들어 놓고 아무도 못 쓰는 화면**이 된다.
//
// 조용히 틀린다: 빌드도 통과하고, 로컬 .env에는 값이 있어 개발에서는 잘 돌고, .env.example
// 에도 적혀 있었다. 어느 검사에도 안 걸렸다. 운영 환경변수는 CI에서 볼 수 없으므로
// (네트워크 + Vercel 인증이 필요하다) 이건 CI 목록이 아니라 **사람이 돌리는 점검**이다.
//
// 쓰는 법:
//   node scripts/audit-next-flags.js
//
// 값은 읽지 않는다(Vercel이 Hidden으로 가린다) — 이름이 등록돼 있는지만 본다.
// 등록돼 있어도 값이 'true'가 아닐 수 있으니, 새로 켠 화면은 실제로 열어봐야 한다.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const proxyFlags = [...new Set((read('src/proxy.js').match(/NEXT_[A-Z0-9_]+_ENABLED/g) || []))].sort();
if (!proxyFlags.length) {
  console.error('src/proxy.js에서 플래그를 하나도 못 찾았다 — 파일 구조가 바뀌었는지 확인할 것.');
  process.exit(1);
}

let listing = '';
try {
  listing = execFileSync('npx', ['vercel', 'env', 'ls', 'production'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  console.error('Vercel 환경변수 목록을 못 읽었다:', e.message.split('\n')[0]);
  console.error('로그인이 필요하면 `npx vercel login`을 먼저 하세요.');
  process.exit(1);
}
const registered = new Set(listing.match(/NEXT_[A-Z0-9_]+_ENABLED/g) || []);

const missing = proxyFlags.filter((f) => !registered.has(f));
console.log(`프록시가 보는 플래그 ${proxyFlags.length}개 / 운영에 등록된 것 ${proxyFlags.length - missing.length}개`);

if (!missing.length) {
  console.log('\n모두 등록돼 있다.');
  console.log('(등록 ≠ 켜짐 — 값이 true인지는 화면을 직접 열어 확인할 것)');
  process.exit(0);
}

console.log('\n운영에 등록되지 않은 플래그:');
for (const f of missing) {
  // 그 플래그가 어떤 경로를 가리키는지 같이 보여준다 — 이름만 보면 무슨 화면인지 모른다.
  const src = read('src/proxy.js');
  const paths = [...src.matchAll(new RegExp(`'(/[^']*)':\\s*'${f}'`, 'g'))].map((m) => m[1]);
  const hint = paths.length ? paths.join(', ') : '(경로는 src/proxy.js에서 확인)';
  console.log(`  ${f}  →  ${hint}`);
}
console.log('\n이 화면들은 Next 페이지가 있어도 운영에서는 EJS가 나간다.');
console.log('켜려면: npx vercel env add <이름> production  (값 true) 후 재배포.');
process.exit(1);
