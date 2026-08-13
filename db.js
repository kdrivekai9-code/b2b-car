// db.js - PostgreSQL(Supabase) 데이터 계층 (node-postgres 사용)
require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL 환경변수가 설정되어 있지 않습니다. .env 파일을 확인하세요 (.env.example 참고).');
}

// Vercel 서버리스에서는 요청마다 여러 함수 인스턴스가 동시에 뜰 수 있어 인스턴스당
// 커넥션 풀을 작게 유지해야 Supabase(Supavisor pooler)의 커넥션 한도를 넘지 않는다.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: process.env.VERCEL ? 3 : 10,
  // 유휴 소켓을 오래 들고 있지 않는다. 이 값이 이번 사고의 노출 창을 그대로 결정한다 —
  // 풀에 캐시된 채 썩을 수 있는 소켓의 수명이기 때문이다. 재접속 비용은 실측 100~150ms라
  // 짧게 잡는 편이 훨씬 싸다(예전 로컬 값은 30초였다).
  idleTimeoutMillis: process.env.VERCEL ? 5000 : 10000,

  // 아래 설정들은 "영원히 매달리는 것"을 막기 위한 것이다. 설정하지 않으면 pg의 기본값이 전부
  // 무한 대기라서, 어딘가 한 번 막히면 그 뒤 모든 요청이 조용히 큐에 쌓인다 — 에러도 로그도
  // 없이 서버가 죽은 것처럼 보인다(2026-08-13 실제로 겪었다: 노트북이 슬립·웨이크를 반복한
  // 뒤 2시간 된 개발서버의 모든 DB 요청이 응답하지 않았고, 같은 DB에 별도 프로세스로는
  // 151ms에 붙었다. 세션 스토어가 같은 풀을 쓰므로 로그인부터 막혔다).
  //
  // 죽은 커넥션은 두 종류이고, 실측 결과가 전혀 다르다(scripts/check-db-resilience.js):
  //   · 완전히 끊김(FIN/RST)   → pg가 1ms에 'Connection terminated unexpectedly'로 실패.
  //                              풀이 그 클라이언트를 버리고 다음 쿼리는 100ms에 정상.
  //   · 반쪽만 끊김(응답 없음) → 보낸 쿼리의 답이 영원히 안 온다. 슬립·NAT 타임아웃이 이 경우다.
  //                              query_timeout이 없으면 무한 대기. 이번 사고가 정확히 이것이다.
  //
  // keepAlive는 이 문제의 해결책이 아니라 느린 뒷정리다 — Node는 SO_KEEPALIVE만 켜고, 실제
  // 프로브 간격은 OS가 정한다(macOS 실측: keepintvl 75초 × keepcnt 8 ≒ 10분). 그래서 반쪽
  // 끊긴 소켓을 실제로 끊어주는 것은 아래 query_timeout이다. keepAlive는 유휴 소켓을 결국
  // 정리해주는 값으로만 기대한다.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  // 새 연결을 얻기까지(풀이 꽉 찼거나 접속 자체가 지연될 때) 기다릴 한도. 넘으면 예외가 나서
  // 요청이 500으로 끝난다 — 매달려 있는 것보다 낫다. 원인이 로그에 남는다.
  connectionTimeoutMillis: 10000,
  // 반쪽 끊긴 소켓을 감지하는 실효 한도. 이 앱의 쿼리는 모두 OLTP 성격이라 실측 최댓값이
  // 0.3초 수준이고(대시보드 집계 0.1초, 오더목록 0.3초), 15초면 50배 여유다. 짧게 잡는 만큼
  // 죽은 소켓을 만난 요청이 빨리 실패하고, 아래 읽기 재시도가 그걸 곧바로 덮는다.
  //
  // statement_timeout은 남겨두지만 실효가 없다 — Supabase 트랜잭션 풀러(Supavisor)를 지나면
  // 무시된다(실측: 30초로 줘도 연결에서 SHOW statement_timeout이 '2min'(풀러 기본값)으로
  // 나온다). 직접 연결이나 세션 풀러로 바꿀 때를 위해 값만 남긴다. 그리고 이 사고에는 애초에
  // 도움이 안 된다 — 서버가 취소해줘도 우리 쪽은 그 응답조차 못 받는 상황이기 때문이다.
  statement_timeout: 30000,
  query_timeout: 15000,
});

// 풀이 막히기 시작하면 그 사실만이라도 남긴다. 2026-08-13 사고에서 가장 아팠던 것은 서버가
// 멈춘 것 자체가 아니라 로그에 아무 흔적이 없어 원인을 좁힐 수 없었던 점이다 — 대기 건수는
// "지금 커넥션을 못 얻고 줄 서 있다"는 뜻이므로, 이 줄이 찍히면 곧바로 풀 문제로 볼 수 있다.
// unref: 이 타이머 때문에 스크립트나 서버리스 함수가 끝나지 못하는 일은 없어야 한다.
const poolWatch = setInterval(() => {
  if (pool.waitingCount > 0) {
    console.warn(`DB 풀 대기 ${pool.waitingCount}건 (total=${pool.totalCount}, idle=${pool.idleCount}, max=${pool.options.max})`);
  }
}, 30000);
if (typeof poolWatch.unref === 'function') poolWatch.unref();

pool.on('error', (err) => {
  console.error('예기치 못한 DB 커넥션 에러:', err);
});

// 기존 코드베이스가 SQLite 스타일 '?' 위치 파라미터로 작성되어 있으므로
// PostgreSQL의 '$1, $2 ...' 형식으로 변환해준다.
function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// 커넥션이 죽어서 실패한 것인지(=쿼리가 실행되지 못했거나 응답을 못 받은 것인지) 판정한다.
// SQL 오류·제약 위반 같은 "정상적인 실패"와 구분해야 한다 — 그건 재시도해도 같은 결과다.
const DEAD_CONNECTION_PATTERNS = [
  'Connection terminated unexpectedly', // 소켓이 완전히 끊긴 경우(실측 1ms)
  'Query read timeout',                 // 반쪽만 끊겨 응답이 안 온 경우(query_timeout)
  'Client has encountered a connection error',
  'connection terminated',
  'server closed the connection unexpectedly',
  'timeout exceeded when trying to connect',
];
const DEAD_CONNECTION_CODES = ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', '57P01'];

function isDeadConnectionError(e) {
  if (!e) return false;
  if (e.code && DEAD_CONNECTION_CODES.includes(e.code)) return true;
  const msg = String(e.message || '');
  return DEAD_CONNECTION_PATTERNS.some((p) => msg.toLowerCase().includes(p.toLowerCase()));
}

// 읽기는 죽은 커넥션 때문에 실패했을 때 한 번 다시 시도한다.
//
// 왜 읽기만인가: 반쪽 끊긴 소켓은 "쿼리가 서버에서 실행됐는지"를 우리가 알 수 없다. 보내긴
// 했고 답을 못 받은 것이라, 쓰기를 재시도하면 같은 INSERT/UPDATE가 두 번 적용될 수 있다 —
// 통보를 두 번 보내거나 오더를 두 건 만드는 사고가 그것이다. SELECT는 두 번 돌아도 안전하므로
// 읽기만 덮고, 쓰기는 실패를 그대로 올려서 호출부(와 사용자)가 알게 둔다.
//
// 이 재시도가 이번 사고의 실질적 해소책이다. 슬립에서 깨어난 직후 풀에 남은 죽은 소켓을 만난
// 조회가, 예전에는 무한 대기 → 지금은 15초 실패 → 이 재시도로 15.1초 만에 정상 응답이 된다.
// 새 커넥션을 쓰게 하려고 실패한 클라이언트가 버려진 뒤(pg가 알아서 버린다) 다시 부른다.
// all()/get()은 이름이 조회처럼 보이지만 실제로는 쓰기도 실어 나른다 —
// db.get("INSERT INTO chat_messages ... RETURNING *")처럼 쓰는 곳이 여럿 있다(통보 발송,
// 세션 생성 등). 그래서 "SELECT로 시작하고 쓰기 키워드가 없는 문장"만 재시도 대상으로 본다.
// 보수적으로 판정해서 재시도를 놓치는 것은 괜찮지만, 쓰기를 재시도하는 것은 사고다.
function isReadOnlySql(sql) {
  const s = String(sql || '').trim();
  if (!/^select\b/i.test(s)) return false;
  return !/\b(insert|update|delete|merge)\b/i.test(s);
}

async function queryWithReadRetry(sql, params) {
  try {
    return await pool.query(sql, params);
  } catch (e) {
    if (!isDeadConnectionError(e) || !isReadOnlySql(sql)) throw e;
    console.warn(`DB 커넥션이 죽어 읽기를 한 번 재시도한다: ${e.message}`);
    return pool.query(sql, params);
  }
}

async function all(sql, params = []) {
  const { rows } = await queryWithReadRetry(toPgSql(sql), params);
  return rows;
}

async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0];
}

// INSERT/UPDATE 문에 'RETURNING id'가 포함되어 있으면 lastInsertRowid로 매핑해준다
// (SQLite의 info.lastInsertRowid를 사용하던 기존 호출부와의 호환을 위함).
async function run(sql, params = []) {
  const { rows, rowCount } = await pool.query(toPgSql(sql), params);
  return { rowCount, lastInsertRowid: rows[0] ? rows[0].id : undefined };
}

// isReadOnlySql / isDeadConnectionError는 scripts/check-db-resilience.js가 판정 규칙을 그대로
// 검사하려고 쓴다 — 재시도해도 되는 문장인지를 가르는 규칙이라, 흉내내면 규칙이 갈라진다.
module.exports = { pool, all, get, run, isReadOnlySql, isDeadConnectionError };
