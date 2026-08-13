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
  idleTimeoutMillis: process.env.VERCEL ? 5000 : 30000,

  // 아래 셋은 "영원히 매달리는 것"을 막기 위한 것이다. 설정하지 않으면 pg의 기본값이 전부
  // 무한 대기라서, 어딘가 한 번 막히면 그 뒤 모든 요청이 조용히 큐에 쌓인다 — 에러도 로그도
  // 없이 서버가 죽은 것처럼 보인다(2026-08-13 실제로 겪었다: 노트북이 슬립·웨이크를 반복한
  // 뒤 2시간 된 개발서버의 모든 DB 요청이 응답하지 않았고, 같은 DB에 별도 프로세스로는
  // 151ms에 붙었다. 세션 스토어가 같은 풀을 쓰므로 로그인부터 막혔다).
  //
  // keepAlive: TCP 유휴 소켓에 keepalive를 보내 죽은 연결을 감지한다. 이것이 없으면 슬립이나
  // 네트워크 전환으로 반쪽만 끊긴 소켓이 풀에 그대로 남아, 그 소켓을 집은 쿼리가 무한히 기다린다.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  // 새 연결을 얻기까지(풀이 꽉 찼거나 접속 자체가 지연될 때) 기다릴 한도. 넘으면 예외가 나서
  // 요청이 500으로 끝난다 — 매달려 있는 것보다 낫다. 원인이 로그에 남는다.
  connectionTimeoutMillis: 10000,
  // 개별 SQL 한 문장의 한도. 이 앱의 쿼리는 모두 OLTP 성격이라(대시보드 집계도 0.2초 미만)
  // 35초면 충분히 넉넉하고, 배치성 작업도 문장 단위는 짧고 반복 횟수가 많은 구조다.
  //
  // 실제로 듣는 것은 query_timeout(클라이언트 쪽)이다. statement_timeout은 남겨두지만
  // Supabase 트랜잭션 풀러(Supavisor)를 지나면 무시된다 — 실측: 아래 값을 30초로 줘도
  // 연결에서 SHOW statement_timeout이 '2min'(풀러 기본값)으로 나온다. 직접 연결이나 세션
  // 풀러로 바꿀 때를 위해 남긴 값이고, 지금 실효 한도는 query_timeout 35초와 풀러의 2분이다.
  statement_timeout: 30000,
  query_timeout: 35000,
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

async function all(sql, params = []) {
  const { rows } = await pool.query(toPgSql(sql), params);
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

module.exports = { pool, all, get, run };
