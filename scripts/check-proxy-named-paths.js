// 플래그가 정말 도달하는지 본다 — src/proxy.js의 :id 블록에 먹히는 경로가 없는지.
//
// 무엇을 지키나(2026-09-08 확인): NEXT_STAGE3_AI_INTAKE_ENABLED가 만들어진 뒤로 **한 번도
// 효과가 없었다.** /orders/:id 블록이 `/orders/ai-intake`를 먼저 잡고, "ai-intake"는 숫자가
// 아니므로 무조건 Express로 보냈다. 맨 아래 PATH_FLAGS 검사까지 도달하지 못한 것이다.
// 로컬에서 :3001(Next 경유)로 요청해도 EJS가 응답했다.
//
// 같은 함정을 이미 한 번 겪고 주석에 적어뒀다 — "플래그를 켜도 /orders/new는 계속 legacy로
// 서빙됐다". 그때 'new'만 고치고 형제 경로를 함께 보지 않았다.
//
// 그래서 사람이 목록을 맞추는 대신 **PATH_FLAGS와 제외 목록을 서로 대조**한다. 플래그가 있는
// 이름 있는 경로가 :id 블록에 먹히면 여기서 잡힌다.
//
// 파일만 읽는다 — DB도 모델도 부르지 않으므로 CI에서 돌 수 있다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src/proxy.js'), 'utf8');

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

// PATH_FLAGS에 등록된 경로들 — "이 경로는 플래그로 Next에 넘길 수 있다"는 선언이다.
const flagged = [];
const flagBlock = src.slice(src.indexOf('const PATH_FLAGS'), src.indexOf('};', src.indexOf('const PATH_FLAGS')));
const flagRe = /'([^']+)':\s*'([A-Z0-9_]+)'/g;
let m;
while ((m = flagRe.exec(flagBlock)) !== null) flagged.push({ path: m[1], flag: m[2] });

console.log('[플래그가 있는 경로가 :id 블록에 먹히지 않는다]');
check('PATH_FLAGS를 읽었다', flagged.length > 0, `${flagged.length}개`);

// :id 블록들: /^\/<prefix>\/([^/]+)$/ 로 한 세그먼트를 잡고, 숫자가 아니면 Express로 보내는 것들.
// 그 prefix 아래에 플래그가 걸린 이름 있는 경로가 있으면, 제외 목록에 들어 있어야 한다.
const idBlockRe = /pathname\.match\(\/\^\\\/([a-z-]+)\\\/\(\[\^\/\]\+\)\$\/\)/g;
const idPrefixes = [];
while ((m = idBlockRe.exec(src)) !== null) idPrefixes.push(m[1]);
check(':id 블록을 찾았다', idPrefixes.length > 0, idPrefixes.join(', '));

for (const prefix of idPrefixes) {
  // 그 블록이 어떤 이름을 제외하는지 — 배열 상수이거나 !== 비교다.
  const blockStart = src.indexOf(`/^\\/${prefix}\\/([^/]+)$/`);
  const blockEnd = src.indexOf('return toExpress(req);', blockStart);
  // **주석을 걷어내고 본다.** 처음에는 원문 그대로 찾았는데, 이 블록 위 주석에 사고 경위를
  // 적으면서 'ai-intake'라고 인용해 둔 것이 코드로 오인됐다 — 제외 목록에서 그 경로를 지워도
  // 검사가 통과했다(음성 테스트로 잡았다). 주석은 설명이고 판정 근거가 아니다.
  const stripComments = (t) => t.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const block = blockStart >= 0
    ? stripComments(src.slice(Math.max(0, blockStart - 600), blockEnd + 40))
    : '';

  const named = flagged
    .filter((f) => f.path.startsWith(`/${prefix}/`) && f.path.slice(prefix.length + 2).indexOf('/') < 0)
    .map((f) => f.path.slice(prefix.length + 2))
    .filter((seg) => !/^\d+$/.test(seg));

  for (const seg of named) {
    // 제외되어 있으면 통과. 배열(indexOf)이든 !== 비교든 둘 다 인정한다.
    const excluded = new RegExp(`'${seg}'`).test(block);
    check(`/${prefix}/${seg} 이 제외돼 있다`, excluded,
      `/${prefix}/:id 블록이 먼저 잡아 플래그가 도달하지 못한다`);
  }
}

console.log('\n[목록으로 못 박아 뒀다]');
// !== 비교를 이어 붙이면 다음 사람이 또 하나를 빠뜨린다. 배열 한 곳에 모은다.
check('제외 경로가 배열로 모여 있다', /const ORDERS_NAMED_PATHS = \[/.test(src));
check('그 배열로 판정한다', /ORDERS_NAMED_PATHS\.indexOf\(orderIdMatch\[1\]\) < 0/.test(src));
// 왜 이렇게 됐는지가 남아 있어야 다음 사람이 같은 실수를 안 한다.
check('사고 경위가 적혀 있다', /한 번도 효과가 없었다/.test(src));

console.log('\n[matcher에도 들어 있다]');
// config.matcher에 없으면 proxy 함수 자체가 안 불린다 — 플래그를 켜도 아무 일도 안 일어난다.
const matcher = src.slice(src.indexOf('export const config'));
for (const f of flagged) {
  // 동적 세그먼트가 없는 경로만 본다.
  if (f.path.indexOf(':') >= 0) continue;
  check(`${f.path} 이 matcher에 있다`, matcher.indexOf(`'${f.path}'`) >= 0);
}

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
