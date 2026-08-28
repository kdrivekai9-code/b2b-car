// 커넥션을 못 얻어 요청이 죽으면 그 사실이 DB에 남는지.
//
// 왜 필요한가: 풀 압박을 알 방법이 사실상 없었다. db.js의 30초 타이머(poolWatch)는 오래 사는
// 로컬 서버에서만 쓸모가 있다 — Vercel 함수는 응답 후 이벤트 루프가 얼어붙고 unref된 타이머가
// 프로세스를 붙잡지도 못해서 프로덕션 로그에는 거의 안 찍히고, 찍혀도 런타임 로그 보존 기간이
// 짧아 지나간 사고를 되짚을 수 없다.
//
// 그래서 타이머가 아니라 **실제로 커넥션을 못 얻어 요청이 죽은 순간**을 integration_errors에
// 남기게 했다. 이 검사는 그게 정말 남는지, 그리고 남기는 행위 자체가 사고를 키우지 않는지를 본다
// (풀이 고갈되면 모든 요청이 동시에 기록하러 몰려온다 — 그게 그대로 INSERT 폭주가 되면 안 된다).
//
// 실제로 풀을 고갈시켜서 확인한다. 흉내내지 않는다 — 판정 함수만 호출해서는 "요청 경로에
// 연결돼 있는지"를 확인할 수 없다.
require('dotenv').config();

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

// 고갈을 만들려면 풀이 아주 작아야 한다. 앱의 기본 풀(로컬 10)로 하면 이 검사가 실사용
// 트래픽과 경합해 느려지므로, 이 프로세스에서만 max=1로 좁혀 쓴다.
process.env.DB_POOL_MAX = '1';
const db = require('../db');

// 이 실행이 만든 기록만 골라 지우기 위한 기준 시각(KST 문자열 — integration_errors.created_at과 같은 형식).
const startedAt = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

(async () => {
  try {
    console.log('[판정 규칙]');
    // pg가 이 문구로 던진다. 문구가 바뀌면 기록이 통째로 조용해지므로 여기서 잡는다.
    check('커넥션 획득 실패를 알아본다',
      db.isPoolExhaustionError(new Error('timeout exceeded when trying to connect')), true);
    // SQL 오류·제약 위반은 풀 문제가 아니다 — 여기까지 기록하면 노이즈가 된다.
    check('일반 SQL 오류는 아니다',
      db.isPoolExhaustionError(new Error('duplicate key value violates unique constraint')), false);
    check('빈 값도 안전하다', db.isPoolExhaustionError(null), false);

    const before = await db.get(
      "SELECT COUNT(*) AS n FROM integration_errors WHERE source = 'db_pool'"
    );
    const beforeCount = Number(before.n);

    console.log('[풀을 실제로 고갈시킨다]');
    check('이 검사의 풀 크기', db.pool.options.max, 1);

    // 하나뿐인 커넥션을 붙잡고 놓지 않는다 — 그 사이에 들어온 요청은 획득 대기에 걸리고,
    // connectionTimeoutMillis(10초)를 넘기면 실패한다.
    const hog = await db.pool.connect();
    let caught = null;
    try {
      // 이 조회는 커넥션을 얻지 못해 죽는다.
      await db.all('SELECT 1');
    } catch (e) {
      caught = e;
    } finally {
      hog.release();
    }

    check('커넥션을 못 얻어 실패했다', db.isPoolExhaustionError(caught), true);
    // 실패를 삼키면 안 된다 — 호출부가 500으로 끝내고 사용자가 알아야 한다.
    check('실패는 그대로 호출부로 던진다', !!caught, true);

    // 기록은 비동기(fire-and-forget)라 잠깐 기다린다.
    await new Promise((r) => setTimeout(r, 1500));

    console.log('[그 사실이 DB에 남는다]');
    const rows = await db.all(
      "SELECT error_code, message, context_json FROM integration_errors WHERE source = 'db_pool' ORDER BY id DESC LIMIT 1"
    );
    const after = await db.get("SELECT COUNT(*) AS n FROM integration_errors WHERE source = 'db_pool'");
    check('새 기록이 생겼다', Number(after.n) > beforeCount, true);
    check('원인 문구가 남는다', /timeout exceeded/i.test(String(rows[0] && rows[0].message)), true);

    const ctx = JSON.parse((rows[0] && rows[0].context_json) || '{}');
    // 규모를 알 수 있어야 한다 — 한 건만 남아도 "얼마나 밀렸는지"가 보여야 조치가 가능하다.
    check('풀 크기를 남긴다', ctx.max, 1);
    check('대기 최고수위를 남긴다', typeof ctx.waitingHighWater, 'number');
    check('어느 쿼리였는지 남긴다', /SELECT 1/.test(String(ctx.sql)), true);
    // 파라미터에는 개인정보(연락처·주소)가 들어 있다 — 오류 로그로 새면 안 된다.
    check('쿼리 파라미터는 남기지 않는다', 'params' in ctx, false);

    console.log('[기록이 사고를 키우지 않는다]');
    // 풀이 고갈되면 모든 요청이 동시에 여기로 온다. 매번 INSERT하면 그 폭주가 고갈을 더
    // 악화시킨다 — 1분에 한 번으로 묶여 있어야 한다.
    const beforeBurst = Number((await db.get(
      "SELECT COUNT(*) AS n FROM integration_errors WHERE source = 'db_pool'"
    )).n);
    const hog2 = await db.pool.connect();
    await Promise.all([1, 2, 3].map(() => db.all('SELECT 2').catch(() => null)));
    hog2.release();
    await new Promise((r) => setTimeout(r, 1500));
    const afterBurst = Number((await db.get(
      "SELECT COUNT(*) AS n FROM integration_errors WHERE source = 'db_pool'"
    )).n);
    check('연달아 실패해도 기록은 늘지 않는다(1분 간격)', afterBurst - beforeBurst, 0);
  } finally {
    // 검사가 만든 기록을 지운다 — 안 지우면 시스템 상태 패널의 "연동 오류 N건"이 검사 때문에
    // 올라가서, 진짜 사고와 구분이 안 된다.
    await db.run(
      "DELETE FROM integration_errors WHERE source = 'db_pool' AND created_at >= ?",
      [startedAt]
    ).catch((e) => console.error('검사 기록 정리 실패:', e.message));
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
