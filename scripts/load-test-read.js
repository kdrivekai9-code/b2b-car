// 조회 경로에 동시 부하를 걸어 커넥션 풀이 어떻게 버티는지 본다.
//
// 왜 필요한가: 2026-08-13에 커넥션 풀에 한도를 넣었다(connectionTimeoutMillis 10초,
// query_timeout 15초, max 10). 한도를 넣으면 "무한 대기"는 사라지지만 대신 부하가 몰릴 때
// 어디서부터 실패하는지가 새로 생긴다 — 그 지점을 숫자로 알아두려는 것이다.
//
// ── 안전장치 (이 스크립트가 지키는 것) ─────────────────────────────────────────
// 1) GET 조회만 부른다. 화이트리스트에 없는 경로는 아예 못 넣는다 — 이 개발서버는 프로덕션
//    Supabase DB와 실제 카카오 발신 자격증명에 붙어 있어서, 접수·통보 경로를 때리면 진짜
//    고객에게 메시지가 나가고 prod DB에 오더가 쌓인다.
// 2) Sec-Fetch-Mode 헤더를 붙인다. 이게 없으면 lib/accessLog.js가 "페이지 탐색"으로 보고
//    요청마다 access_logs에 감사 행을 쓴다(curl·Node는 이 헤더를 안 보낸다). 부하 테스트
//    1,000건이 감사 테이블에 1,000건으로 남는 것을 막는다. 실행 전후 건수를 비교해 증명한다.
// 3) 로그인은 한 번만 한다. 단일 세션 강제 때문에 매번 로그인하면 서로를 밀어낸다.
// 4) SSE(/stream)는 대상이 아니다 — 오래 붙잡는 연결이라 동시성 측정이 왜곡된다.
//
// DB 커넥션 자체는 풀 max(로컬 10)가 상한이라, HTTP 동시성을 100으로 올려도 Supabase에
// 10개를 넘겨 쓰지 않는다. 그래서 프로덕션 DB의 커넥션 한도(실측 max_connections 60)를
// 위협하지 않는다.
//
//   node scripts/load-test-read.js
//   node scripts/load-test-read.js --path /orders --levels 10,50 --requests 100
require('dotenv').config();
const http = require('http');
const db = require('../db');

const BASE = process.env.LOAD_TEST_BASE || 'http://127.0.0.1:3000';
// 로그인만 다른 곳에 할 수 있게 분리한다 — Next(3001)에는 POST /login 핸들러가 없어서
// 로그인은 Express(3000)로 하고 부하만 3001에 걸어야 한다. 같은 호스트면 쿠키는 포트와
// 무관하게 공유되므로 그대로 쓸 수 있다.
const LOGIN_BASE = process.env.LOAD_TEST_LOGIN_BASE || 'http://127.0.0.1:3000';
const LOGIN_ID = process.env.E2E_LOGIN_ID || 'qa_test_bot';
const PASSWORD = process.env.E2E_PASSWORD || '';

// 읽기 전용이고 부작용이 없는 경로만. 늘릴 때는 "이 경로가 쓰기를 하지 않는가"를 먼저 확인한다.
const ALLOWED_PATHS = [
  '/dashboard/data.json',            // 대시보드 집계 — 여러 테이블을 읽는 가장 무거운 조회
  '/chat/sessions/card-data.json',   // 상담 세션 목록 — 변경이 있을 때만 부른다
  '/chat/sessions/card-version.json',// 변경 여부만 묻는 경량 확인 — 폴링이 실제로 부르는 경로
  '/orders',                         // 오더 목록 화면
  '/',                               // Next 대시보드 페이지(3001에서 측정할 때)
  '/login',                          // DB를 타지 않는 대조군(순수 렌더링 비용)
];

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { path: '/dashboard/data.json', levels: [5, 10, 25, 50, 100], requests: 100 };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const val = args[i + 1];
    if (key === '--path') out.path = val;
    if (key === '--levels') out.levels = val.split(',').map(Number).filter((n) => n > 0);
    if (key === '--requests') out.requests = Number(val);
  }
  return out;
}

function request(method, path, { cookie, body, base } = {}) {
  return new Promise((resolve) => {
    const url = new URL(path, base || BASE);
    const payload = body ? new URLSearchParams(body).toString() : null;
    const started = process.hrtime.bigint();
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          // 감사 로그를 남기지 않게 하는 헤더(위 안전장치 2번). 브라우저의 fetch/폴링과 같은 값이다.
          'Sec-Fetch-Mode': 'cors',
          'X-Requested-With': 'fetch',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(payload ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        res.resume(); // 본문은 버린다 — 지연만 본다
        res.on('end', () => resolve({
          status: res.statusCode,
          ms: Number(process.hrtime.bigint() - started) / 1e6,
          setCookie: res.headers['set-cookie'],
        }));
      }
    );
    req.on('error', (e) => resolve({
      status: 0, error: e.code || e.message, ms: Number(process.hrtime.bigint() - started) / 1e6,
    }));
    if (payload) req.write(payload);
    req.end();
  });
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

// 동시성 N을 유지하면서 total건을 처리한다(고정 워커 방식 — 한꺼번에 total개를 띄우지 않는다).
async function runLevel(concurrency, total, path, cookie) {
  const results = [];
  let issued = 0;
  const started = Date.now();
  async function worker() {
    while (issued < total) {
      issued += 1;
      results.push(await request('GET', path, { cookie }));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = (Date.now() - started) / 1000;
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const byStatus = results.reduce((acc, r) => {
    const key = r.error ? `err:${r.error}` : String(r.status);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return {
    concurrency,
    total,
    elapsed,
    rps: total / elapsed,
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    p99: percentile(times, 99),
    max: times[times.length - 1] || 0,
    byStatus,
  };
}

async function main() {
  const { path, levels, requests } = parseArgs();
  if (!ALLOWED_PATHS.includes(path)) {
    console.error(`허용되지 않은 경로: ${path}\n조회 전용 경로만 됩니다: ${ALLOWED_PATHS.join(', ')}`);
    process.exit(1);
  }
  if (!PASSWORD) {
    console.error('E2E_PASSWORD가 없습니다(.env). 로그인 없이는 인증 경로를 측정할 수 없습니다.');
    process.exit(1);
  }

  console.log(`대상: ${BASE}${path}`);
  console.log(`단계: 동시 ${levels.join(' → ')} / 각 단계 ${requests}건\n`);

  const login = await request('POST', '/login', { base: LOGIN_BASE, body: { login_id: LOGIN_ID, password: PASSWORD } });
  const cookie = (login.setCookie || []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) {
    console.error(`로그인 실패(status=${login.status}) — 세션 쿠키를 받지 못했습니다.`);
    process.exit(1);
  }
  console.log(`로그인 OK (${login.ms.toFixed(0)}ms)\n`);

  // 감사 로그 스냅샷은 로그인 '뒤'에 뜬다. 로그인 자체는 LOGIN_BLOCKED(기존 세션 자동 로그아웃)
  // + LOGIN_SUCCESS 두 건을 남기는 게 정상 동작이라, 그걸 포함하면 부하가 남긴 것과 구분이 안 된다.
  // 여기서 재는 것은 "조회 부하가 감사 테이블에 몇 건을 남겼는가"이고 답은 0이어야 한다.
  const before = await db.get('SELECT count(*)::int AS n FROM access_logs');

  console.log('동시성   건수    소요     처리량      p50      p95      p99      최대   응답 분포');
  console.log('-'.repeat(96));
  const rows = [];
  for (const c of levels) {
    const r = await runLevel(c, requests, path, cookie);
    rows.push(r);
    console.log(
      `${String(r.concurrency).padStart(5)}   ${String(r.total).padStart(5)}  ${r.elapsed.toFixed(1).padStart(6)}s  `
      + `${r.rps.toFixed(0).padStart(6)}/s  ${r.p50.toFixed(0).padStart(6)}ms  ${r.p95.toFixed(0).padStart(6)}ms  `
      + `${r.p99.toFixed(0).padStart(6)}ms  ${r.max.toFixed(0).padStart(6)}ms   ${JSON.stringify(r.byStatus)}`
    );
  }

  const after = await db.get('SELECT count(*)::int AS n FROM access_logs');
  const added = after.n - before.n;
  console.log(`\n조회 부하가 남긴 감사 로그: ${added}건 ${added === 0 ? '(정상 — Sec-Fetch-Mode 헤더로 걸러진다)' : '⚠️ 0이어야 한다 — 감사 테이블이 오염되고 있다'}`);

  const failed = rows.filter((r) => Object.keys(r.byStatus).some((k) => k !== '200' && k !== '302'));
  if (failed.length) {
    console.log('\n실패가 섞인 단계:');
    failed.forEach((r) => console.log(`  동시 ${r.concurrency}: ${JSON.stringify(r.byStatus)}`));
    console.log('  풀 대기/획득 타임아웃이면 서버 로그에 "DB 풀 대기" 또는 "timeout exceeded"가 함께 찍힌다.');
  }
  process.exit(0);
}

main().catch((e) => { console.error('오류:', e.message); process.exit(1); });
