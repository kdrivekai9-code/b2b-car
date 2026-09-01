// 세션 저장소 설정 검사.
//
// 왜 검사로 고정하나: connect-pg-simple의 createTableIfMissing은 표 존재 확인 결과를 약속
// 하나에 캐시하는데 **실패한 약속을 지우지 않는다**(index.js:197). 부팅 순간 DB가 잠깐 안
// 닿으면 그 거부가 프로세스 수명 내내 재사용되어, DB가 회복돼도 세션을 쓰는 모든 요청이
// 영구히 500이 된다. 2026-09-01에 실제로 그렇게 됐고, 재기동 전까지 풀리지 않았다.
//
// 그래서 표는 마이그레이션이 만들고 그 옵션은 끈다. 다만 끈 상태에서 표가 없으면 이번엔
// 로그인이 통째로 안 되므로, 옵션과 표를 **함께** 확인해야 의미가 있다.
require('dotenv').config();

const fs = require('fs');
const path = require('path');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

console.log('[server.js 설정]');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const store = server.match(/new pgSession\(\{[^}]*\}\)/);
check('세션 저장소 설정을 찾았다', !!store);
if (store) {
  check('createTableIfMissing이 꺼져 있다', /createTableIfMissing:\s*false/.test(store[0]), store[0]);
  check('표 이름은 session', /tableName:\s*'session'/.test(store[0]));
}

console.log('\n[마이그레이션]');
const migDir = path.join(__dirname, '..', 'supabase', 'migrations');
const migs = fs.readdirSync(migDir).filter((f) => /session_table/.test(f));
check('세션 표 마이그레이션이 있다', migs.length > 0, '옵션을 껐으므로 표를 만들 곳이 필요하다');
if (migs.length) {
  const sql = fs.readFileSync(path.join(migDir, migs[0]), 'utf8');
  // 라이브러리가 읽고 쓰는 표라 모양이 갈리면 세션이 깨진다.
  ['sid', 'sess', 'expire'].forEach((col) => check(`${col} 컬럼을 만든다`, sql.includes(`"${col}"`)));
  check('여러 번 실행해도 안전하다', /create table if not exists/i.test(sql));
}

(async () => {
  console.log('\n[실제 DB]');
  if (!process.env.DATABASE_URL) {
    console.log('  건너뜀 — DATABASE_URL 없음');
  } else {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
    try {
      const { rows } = await pool.query(`
        select to_regclass('session') as tbl,
               (select count(*) from pg_constraint where conname = 'session_pkey') as pkey,
               (select count(*) from pg_indexes where indexname = 'IDX_session_expire') as idx`);
      const r = rows[0];
      check('session 표이 있다', r.tbl === 'session', '없으면 로그인이 전부 실패한다');
      check('기본키가 있다', Number(r.pkey) === 1);
      // 만료 세션 정리(prune)가 이 인덱스로 돈다. 없으면 세션이 쌓일수록 느려진다.
      check('expire 인덱스가 있다', Number(r.idx) === 1);
    } catch (e) {
      check('DB 조회', false, e.message);
    } finally {
      await pool.end();
    }
  }
  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})();
