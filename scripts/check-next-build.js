// Next.js 빌드가 통과하는지 확인한다.
//
// 왜 필요한가(2026-08-29 실사고): src/app/**의 JSX를 고치면서 `{cond && (...)}` 안에 형제
// 노드를 나란히 두어 파싱이 깨졌다. Express(:3000)는 EJS라 멀쩡히 돌았고 로컬 검사도 전부
// 통과했지만, **Vercel 배포가 매번 실패해 프로덕션이 옛 코드에 그대로 멈춰 있었다**.
// 그 사이 올린 동기화 순환 수정·배치 상향·장애 알림이 하나도 반영되지 않았는데, 저장소만
// 보면 다 끝난 것처럼 보였다.
//
// 커밋 전에 이걸 돌리면 그 상태를 만들지 않는다.
const { spawnSync } = require('child_process');

const r = spawnSync('npx', ['next', 'build'], { encoding: 'utf8', cwd: process.cwd() });
const out = `${r.stdout || ''}${r.stderr || ''}`;

if (r.status === 0) {
  console.log('Next 빌드 통과');
  process.exit(0);
}
console.log('Next 빌드 실패 — 이대로 push하면 프로덕션이 옛 코드에 멈춘다.\n');
// 원인 줄만 추린다(전체 로그는 길다).
out.split('\n').filter((l) => /Error|error|Failed|failed|\.\/src\//.test(l)).slice(0, 20)
  .forEach((l) => console.log('  ' + l.trim()));
process.exit(1);
