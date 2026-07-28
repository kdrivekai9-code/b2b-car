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
});

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
