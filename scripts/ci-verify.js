// 배포 전 검사 한 묶음 — CI와 로컬이 같은 명령을 쓴다.
//
// 왜 필요한가: main에 직푸시하면 Vercel이 곧바로 배포한다. PR을 안 거치니 Playwright E2E
// (.github/workflows/playwright-e2e.yml)는 pull_request 트리거라 한 번도 돌지 않고,
// scripts/check-*.js 97개도 사람이 손으로 돌리는 것뿐이다.
//
// 그 구멍으로 실제 사고가 났다: JSX 오류 하나가 Vercel 배포를 통째로 막았는데 Express는
// 로컬에서 멀쩡했고 검사도 다 통과해서 안 보였다. 프로덕션의 크론 하나가 302를 돌려주는 것을
// 보고서야 알았다.
//
// 세 겹으로 본다. 뒤로 갈수록 느리고 잡는 범위가 넓다.
//   1. 문법  — 모든 .js를 파싱해본다. Express가 뜨지도 못하는 실수를 즉시 잡는다.
//   2. 템플릿 — 모든 .ejs를 컴파일해본다. 이 저장소에서 반복해서 났던 종류다.
//   3. 검사  — 외부 서비스가 필요 없는 check-*.js 전부.
//
// 여기 넣지 않는 것:
//   · DB에 붙는 검사(46개) — CI가 매 푸시마다 **운영 DB**를 읽고 쓰게 된다. 일부는 시험용
//     행을 만들고 지우는데, 푸시가 겹치면 서로의 데이터를 건드린다.
//   · 모델·콜마너를 실제로 부르는 검사 — 푸시마다 비용이 들고, 외부 장애가 우리 배포를 막는다.
//   · 카카오 지오코딩이 필요한 검사, 로그인 검사 — 키와 뜬 서버가 필요하다.
//   그 셋은 사람이 필요할 때 돌린다. 이 묶음의 값어치는 "빠르고, 외부에 안 기대고, 항상 같은
//   답을 낸다"는 것이다 — 그래야 배포를 막는 근거로 쓸 수 있다.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.playwright-browsers', 'coverage']);

// 외부 서비스가 필요해 CI에서 제외하는 검사. 이유를 함께 적어둔다 — 나중에 "왜 빠졌지"를
// 되짚을 때 목록만 있으면 알 수 없다.
const EXCLUDED = {
  'check-login': '뜬 서버와 실제 계정 비밀번호가 필요하다',
  'check-login-all': '위와 같다',
  'check-kakao-intake-parser': '카카오 지오코딩 키가 필요하다',
  'check-kakao-intake-geocode': '위와 같다',
  'check-kakao-intake-preview': '위와 같다',
  // 실제 모델을 부르므로 회차마다 답이 갈린다(실측 8회 중 2회 실패 — 모델이 "배정"을
  // 기사 쪽에 두기도 한다). 결정적이지 않은 검사는 배포를 막는 근거로 쓸 수 없다.
  // 분류 자체가 틀린 게 아니라 경계에 있는 문장이라, 검사를 고치는 것으로 해결되지 않는다.
  'check-intake-memo-split': '실제 모델을 부르고 결과가 회차마다 갈린다',
  // 아래 둘은 .env 없이 + 더미 DATABASE_URL로도 실패한다 — 실제 모델을 부른다.
  'check-escalation-judge': '상담원 연결 판정에 실제 모델을 부른다',
  'check-intake-coverage': '요청사항 분석에 실제 모델을 부른다',
};

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

let failures = [];
function fail(stage, name, detail) {
  failures.push({ stage, name, detail });
  console.log(`  FAIL ${name}${detail ? `\n       ${String(detail).split('\n')[0].slice(0, 160)}` : ''}`);
}

const files = walk(ROOT);

// ── 1. 문법 ─────────────────────────────────────────────────────────────────
// src/app/** 은 JSX라 node --check가 못 읽는다 — 그쪽은 아래 next build가 본다.
console.log('[문법]');
const jsFiles = files.filter((f) => f.endsWith('.js') && !f.includes(`${path.sep}src${path.sep}`));
let jsOk = 0;
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    jsOk += 1;
  } catch (e) {
    fail('syntax', path.relative(ROOT, f), (e.stderr || e.stdout || e).toString());
  }
}
console.log(`  ${jsOk}/${jsFiles.length} 통과`);

// ── 2. 템플릿 ───────────────────────────────────────────────────────────────
console.log('\n[EJS 템플릿]');
const ejs = require('ejs');
const ejsFiles = files.filter((f) => f.endsWith('.ejs'));
let ejsOk = 0;
for (const f of ejsFiles) {
  try {
    ejs.compile(fs.readFileSync(f, 'utf8'), { filename: f });
    ejsOk += 1;
  } catch (e) {
    fail('ejs', path.relative(ROOT, f), e.message);
  }
}
console.log(`  ${ejsOk}/${ejsFiles.length} 통과`);

// ── 3. 검사 ─────────────────────────────────────────────────────────────────
console.log('\n[검사 스크립트]');
const scriptDir = path.join(ROOT, 'scripts');

// CI가 돌릴 검사는 **목록으로 못 박는다.** 추론으로 가리려다 세 번 틀렸다 —
//   1. 검사 파일만 grep해서 간접 의존을 놓쳤다. check-intake-memo-split이 lib/intakeMemoSplit을
//      통해 실제 모델을 부르는데 파일에는 vertexAi가 안 적혀 있었고, CI에 넣자 회차마다 결과가
//      갈렸다(8회 중 2회 실패 — 모델이 "배정"을 기사 쪽에 두기도 한다).
//   2. require를 한 겹 따라가게 하니 이번엔 22개를 과하게 뺐다.
//   3. 로컬에서 3회 돌려 "안정"이라고 판단했는데, 로컬에는 .env가 있었다. CI에서 24개가
//      한꺼번에 죽었다 — db.js가 DATABASE_URL 없이 **모듈 로드 시점에** 던지기 때문에,
//      질의를 한 줄도 안 하는 검사까지 같이 죽었다.
//
// 3번은 워크플로에서 닿지 않는 더미 DATABASE_URL을 주어 풀었다. pg 풀은 첫 질의 때 연결하므로,
// 모듈만 로드하고 끝나는 검사는 통과하고 실제로 질의하는 검사는 그대로 실패한다 — 즉 더미
// URL이 "정말 DB가 필요한가"를 가려주는 체가 된다. 그래서 목록이 16개에서 38개로 늘었다.
//
// 아래는 **.env 없이 + 더미 URL로** 실제로 통과한 것만 남긴 것이다. 로컬에서 잰 값을 그대로
// 쓰면 또 같은 실수를 한다.
const CI_CHECKS = [
  'check-address-candidates',
  'check-automation-accounts',
  'check-address-spacing-geocode',
  'check-agent-request',
  'check-agent-idle-release',
  'check-callmaner-drive-started',
  'check-callmaner-photos',
  'check-callmaner-reserved-dispatch',
  'check-callmaner-memo',
  'check-delivery-reservation',
  'check-client-scope',
  'check-dispatch-lookup-tool',
  'check-driver-chat',
  'check-driver-trip-steps',
  'check-driver-push',
  'check-driver-token',
  'check-driver-location',
  'check-form-parity',
  'check-fare-surcharge',
  'check-intake-correction',
  'check-intake-fields-shared',
  'check-intake-summary',
  'check-intake-expiry-notice',
  'check-intake-restart',
  'check-kakao-order-notify',
  'check-kakao-repeat-guard',
  'check-mcp-followup-guard',
  'check-memo-extra-costs',
  'check-memo-budget',
  'check-next-build',
  'check-offer-agent-answer',
  'check-odometer-ocr',
  'check-order-detail-photos',
  'check-order-history-basis',
  'check-order-list-columns',
  'check-order-split',
  'check-plate-check',
  'check-premium-immediate',
  'check-premium-step-questions',
  'check-receipt-ocr',
  'check-postal-receipt',
  'check-remote-area-fee',
  'check-reserved-date-reask',
  'check-reserved-year-guess',
  'check-shared-tabs',
  'check-sync-live-window',
  'check-system-alert',
  'check-test-data-sweep'
];

let checkOk = 0;
for (const name of CI_CHECKS) {
  try {
    // 한 검사가 매달리면 CI 전체가 멈춘다. 넉넉하되 상한을 둔다.
    execFileSync(process.execPath, [path.join(scriptDir, `${name}.js`)], { stdio: 'pipe', timeout: 60000 });
    checkOk += 1;
  } catch (e) {
    fail('check', name, (e.stdout || e.stderr || e).toString().split('\n').filter((l) => /FAIL|실패|Error/.test(l))[0] || e.message);
  }
}
console.log(`  ${checkOk}/${CI_CHECKS.length} 통과`);

// 목록에 없는 검사가 몇 개인지 보여준다. 새로 만든 검사를 목록에 안 더하면 CI가 안 돌리는데,
// 그게 조용히 지나가면 "검사를 만들었으니 안전하다"는 착각이 생긴다.
const allChecks = fs.readdirSync(scriptDir).filter((n) => /^check-.*\.js$/.test(n))
  .map((n) => n.replace(/\.js$/, ''));
const outside = allChecks.filter((n) => !CI_CHECKS.includes(n) && !EXCLUDED[n]);
console.log(`  (목록 밖 ${outside.length}개는 사람이 필요할 때 돌린다 — DB·모델·외부 API가 필요하거나`);
console.log('   회차마다 답이 달라져 배포를 막는 근거로 쓸 수 없는 것들이다)');

// ── 결과 ────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.log(`\n${failures.length}건 실패`);
  const byStage = {};
  failures.forEach((f) => { byStage[f.stage] = (byStage[f.stage] || 0) + 1; });
  console.log(Object.entries(byStage).map(([k, v]) => `${k} ${v}건`).join(' / '));
  process.exit(1);
}
console.log('\n모두 통과');
