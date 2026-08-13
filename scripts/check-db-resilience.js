// DB 커넥션이 죽었을 때 앱이 매달리지 않고 회복하는지 확인한다.
//
// 왜 이 검사가 있는가: 2026-08-13, 노트북이 슬립·웨이크를 반복한 뒤 2시간 떠 있던 개발서버의
// 모든 DB 요청이 응답하지 않았다. GET /login(DB 미사용)은 즉시 200인데 POST /login은 무응답,
// Next 대시보드는 30초 뒤 500. 같은 DB에 별도 프로세스로 붙으면 151ms였다. 원인은 풀에 캐시된
// TCP 소켓이 슬립 중 죽었는데 pg의 기본값이 전부 무한 대기였던 것이다.
//
// 실제 발신도 DB 쓰기도 하지 않는다 — 소켓을 끊고 SELECT만 돌린다.
//
//   node scripts/check-db-resilience.js
require('dotenv').config();
const db = require('../db');

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}`);
  if (!ok) console.log(`         기대: ${JSON.stringify(expected)}\n         실제: ${JSON.stringify(actual)}`);
}

// 죽은 소켓을 하나 만든다. release(err)로 넘겨서 풀이 그 클라이언트를 버리게 한다.
async function makeDeadClient(mode) {
  const client = await db.pool.connect();
  client.on('error', () => {}); // 체크아웃된 클라이언트의 error를 삼킨다(없으면 프로세스가 죽는다)
  await client.query('SELECT 1');
  if (mode === 'closed') client.connection.stream.destroy();
  else client.connection.stream.pause(); // 반쪽 끊김 — 보낸 쿼리의 답이 오지 않는다
  return client;
}

async function main() {
  console.log('[설정이 실제로 적용되어 있다]');
  const o = db.pool.options;
  check('keepAlive 켜짐', !!o.keepAlive, true);
  check('커넥션 획득 한도가 있다', Number.isFinite(o.connectionTimeoutMillis) && o.connectionTimeoutMillis > 0, true);
  check('쿼리 한도가 있다', Number.isFinite(o.query_timeout) && o.query_timeout > 0, true);
  check('커넥션 수명 상한이 있다', Number.isFinite(o.maxLifetimeSeconds) && o.maxLifetimeSeconds > 0, true);
  // 무한 대기(0/undefined)로 되돌아가면 이 검사가 바로 잡는다.
  console.log(`       (connectionTimeout=${o.connectionTimeoutMillis}ms, query_timeout=${o.query_timeout}ms, idle=${o.idleTimeoutMillis}ms, maxLifetime=${o.maxLifetimeSeconds}s, max=${o.max})`);

  console.log('\n[커넥션 수명 상한이 실제로 지켜진다]');
  // 설정값만 확인하면 "이 pg 버전이 그 옵션을 무시한다"는 경우를 놓친다. 수명 1초짜리 임시 풀로
  // 실제로 커넥션이 교체되는지 본다(운영 풀 300초를 기다릴 수는 없다).
  const { Pool } = require('pg');
  const shortLived = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 1,
    maxLifetimeSeconds: 1,
    idleTimeoutMillis: 30000,
  });
  // 교체를 pid로 판정할 수는 없다 — 트랜잭션 풀러를 지나면 백엔드 pid가 클라이언트 커넥션과
  // 1:1이 아니다(실측: 교체 전후 pid가 같게 나온다). 풀이 커넥션을 실제로 버릴 때 내는
  // 'remove' 이벤트를 본다. 이 이벤트가 안 오면 이 pg 버전이 옵션을 무시하는 것이다.
  let removed = 0;
  shortLived.on('remove', () => { removed += 1; });
  try {
    const first = await shortLived.connect();
    await first.query('SELECT 1');
    first.release();
    check('수명 안에서는 커넥션을 버리지 않는다', removed, 0);
    await new Promise((r) => setTimeout(r, 1500)); // 수명(1초)을 넘긴다
    const second = await shortLived.connect();
    await second.query('SELECT 1');
    second.release();
    check('수명을 넘긴 커넥션은 버려진다', removed >= 1, true);
    console.log(`       remove 이벤트 ${removed}회 — 설정값만이 아니라 실제로 교체된다`);
  } finally {
    await shortLived.end().catch(() => {});
  }

  console.log('\n[완전히 끊긴 소켓 — 즉시 실패하고 풀이 회복한다]');
  const c1 = await makeDeadClient('closed');
  let t = Date.now();
  let err = null;
  try { await c1.query('SELECT 1'); } catch (e) { err = e; }
  const closedMs = Date.now() - t;
  check('끊긴 소켓 쿼리는 실패한다', !!err, true);
  check('1초 안에 실패한다(무한 대기 아님)', closedMs < 1000, true);
  console.log(`       ${closedMs}ms — ${err && err.message}`);
  try { c1.release(err); } catch (e) { /* 이미 버려진 클라이언트 */ }
  t = Date.now();
  const after = await db.get('SELECT 1 AS ok');
  check('다음 쿼리는 정상이다', after && after.ok, 1);
  console.log(`       회복 ${Date.now() - t}ms`);

  console.log('\n[반쪽만 끊긴 소켓 — query_timeout이 끊어준다]');
  // 이것이 이번 사고의 형태다. 예전에는 여기서 영원히 매달렸다.
  const c2 = await makeDeadClient('halfopen');
  t = Date.now();
  err = null;
  try { await c2.query('SELECT 1'); } catch (e) { err = e; }
  const halfMs = Date.now() - t;
  check('반쪽 끊긴 소켓 쿼리도 결국 실패한다', !!err, true);
  check('query_timeout 한도 안에서 끝난다', halfMs < Number(o.query_timeout) + 3000, true);
  console.log(`       ${halfMs}ms — ${err && err.message}`);
  try { c2.release(err); } catch (e) { /* 무시 */ }

  console.log('\n[죽은 커넥션 판정 — 읽기만 재시도해야 한다]');
  // 쓰기를 재시도하면 같은 INSERT가 두 번 적용된다. all()/get()이 INSERT ... RETURNING을
  // 실어 나르는 곳이 있어서(통보 발송·세션 생성) 이 판정이 안전장치다.
  check('SELECT는 재시도 대상', db.isReadOnlySql('SELECT 1'), true);
  check('앞뒤 공백·대소문자 무관', db.isReadOnlySql('  select * from orders '), true);
  check('INSERT는 대상 아님', db.isReadOnlySql('INSERT INTO orders (oid) VALUES (?)'), false);
  check('UPDATE는 대상 아님', db.isReadOnlySql('UPDATE orders SET status = ?'), false);
  check('DELETE는 대상 아님', db.isReadOnlySql('DELETE FROM orders WHERE id = ?'), false);
  check('INSERT ... RETURNING도 대상 아님', db.isReadOnlySql('INSERT INTO t (a) VALUES (1) RETURNING *'), false);
  check('쓰기 CTE(WITH ... INSERT)도 대상 아님', db.isReadOnlySql('WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x'), false);
  check('커넥션 죽음 판정: 읽기 타임아웃', db.isDeadConnectionError(new Error('Query read timeout')), true);
  check('커넥션 죽음 판정: 연결 종료', db.isDeadConnectionError(new Error('Connection terminated unexpectedly')), true);
  const sqlError = new Error('column "nope" does not exist'); sqlError.code = '42703';
  check('SQL 오류는 커넥션 죽음이 아니다', db.isDeadConnectionError(sqlError), false);

  console.log('\n[읽기 재시도가 실제로 덮어준다]');
  // 죽은 소켓을 풀에 남긴 상태에서 db.get을 부르면, 첫 시도가 실패하고 재시도가 성공해야 한다.
  // (풀이 죽은 클라이언트를 먼저 집도록 idle로 되돌려 둔다 — release에 에러를 넘기지 않는다.)
  const c3 = await db.pool.connect();
  c3.on('error', () => {});
  await c3.query('SELECT 1');
  c3.connection.stream.destroy();
  c3.release(); // 일부러 "정상 반납" — 죽은 소켓이 풀에 남는 상황을 만든다
  t = Date.now();
  let retried = null;
  try { retried = await db.get('SELECT 1 AS ok'); } catch (e) { retried = { error: e.message }; }
  check('죽은 소켓이 섞여 있어도 조회가 성공한다', retried && retried.ok, 1);
  console.log(`       ${Date.now() - t}ms (첫 시도 실패 → 새 커넥션으로 재시도)`);

  console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => {
  console.error('\n확인 중 오류:', e.message);
  process.exit(1);
});
