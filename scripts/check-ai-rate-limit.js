// AI 엔드포인트 사용량 제한 검사.
//
// 왜 필요한가: 이 제한이 잘못 걸리면 두 방향으로 조용히 망가진다 —
//  (1) 너무 빡빡하거나 세는 단위가 잘못되면 정상 고객이 대화 중에 막힌다. 특히 IP로 세면 한
//      사무실에서 여러 명이 쓸 때 서로의 한도를 깎아먹는다.
//  (2) 아예 안 걸리면 만든 의미가 없다.
// 실제 Gemini를 부르지 않고 미들웨어만 떼어내 확인한다(비용·시간 없이 반복 가능).
//
// 카운터가 DB에 있어서(lib/aiUsageCounter.js) 실행 간에 값이 남는다 — 시작할 때 이 검사가 쓸
// 계정의 카운터를 지워야 결과가 매번 같다. 메모리 카운터일 때는 프로세스가 끝나면 저절로
// 사라져서 이 정리가 필요 없었고, 그대로 뒀다가 재실행이 깨졌다.
process.env.AI_RATE_LIMIT_PER_MINUTE = '3';
process.env.AI_RATE_LIMIT_PER_HOUR = '1000';
// 설정 캐시를 짧게 해서 저장 직후 반영을 확인할 수 있게 한다.
process.env.APP_SETTINGS_CACHE_MS = '50';
delete process.env.AI_RATE_LIMIT_DISABLED;
process.env.NODE_ENV = 'development'; // 테스트 모드면 미들웨어가 통과만 하므로 끈다

const express = require('express');
const db = require('../db');
const appSettings = require('../lib/appSettings');
const aiUsageCounter = require('../lib/aiUsageCounter');
const {
  aiRateLimit, BLOCK_EVENT_TYPE, KEY_PER_MINUTE, KEY_PER_HOUR,
} = require('../middleware/aiRateLimit');

// 실제 사용자와 겹치지 않는 id — 이 값들의 카운터만 지우므로 운영 사용량 집계를 건드리지 않는다.
// 이 id로 차단이 일어나면 "AI 차단 기록 실패 ... foreign key" 경고가 뜬다. access_logs.user_id가
// users를 참조하는데 이 id는 없는 계정이기 때문으로, 검사에서만 나오는 정상적인 잡음이다
// (실제 운영에서는 로그인한 계정이라 항상 존재한다). 기록 실패가 요청을 막지 않는 것도 함께 확인된다.
const FAKE = { a: 900001, b: 900002, changed: 900003, unlimited: 900004, usage: 900005 };

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

const app = express();
app.set('trust proxy', 1);
// 로그인 세션을 흉내 낸다 — 헤더로 사용자 id를 주입해 계정별 분리를 확인한다.
app.use((req, res, next) => {
  const id = req.get('x-test-user');
  req.session = id ? { user: { id: Number(id), login_id: `test${id}` } } : {};
  next();
});
app.post('/ai', aiRateLimit, (req, res) => res.json({ ok: true }));

async function clearCounters(subjects) {
  if (!subjects.length) return;
  const ph = subjects.map(() => '?').join(',');
  await db.run(`DELETE FROM ai_rate_usage WHERE subject IN (${ph})`, subjects).catch(() => {});
}

const server = app.listen(0, async () => {
  const port = server.address().port;
  const subjects = Object.values(FAKE).map((id) => `u:${id}`);

  // access_logs.user_id가 users를 참조하므로, 차단 기록 검사에는 실제 계정 id가 필요하다 —
  // 가짜 id로 하면 기록이 FK에 막혀서 "차단이 남는가"를 확인하지 못한다(실제로 헛통과했다).
  const anyUser = await db.get('SELECT id FROM users ORDER BY id LIMIT 1');
  const realUserId = anyUser ? Number(anyUser.id) : null;
  if (realUserId) subjects.push(`u:${realUserId}`);

  const call = async (userId) => {
    const res = await fetch(`http://127.0.0.1:${port}/ai`, {
      method: 'POST',
      headers: userId ? { 'x-test-user': String(userId) } : {},
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  try {
    await clearCounters(subjects);
    await db.run('DELETE FROM app_settings WHERE key IN (?, ?)', [KEY_PER_MINUTE, KEY_PER_HOUR]).catch(() => {});
    appSettings.invalidate();

    console.log('[한도 안에서는 통과한다]');
    for (let i = 1; i <= 3; i += 1) check(`${i}번째 요청`, (await call(FAKE.a)).status, 200);

    console.log('[한도를 넘기면 막는다]');
    const blocked = await call(FAKE.a);
    check('4번째는 429', blocked.status, 429);
    // 챗봇 클라이언트는 JSON을 기대한다 — HTML 오류 페이지가 오면 화면이 깨진다.
    check('JSON으로 답한다', !!(blocked.body && blocked.body.reason === 'ai_rate_limited'), true);
    check('내부 수치를 노출하지 않는다', /\d+회|분당|한도/.test(String(blocked.body.error)), false);

    console.log('[계정이 다르면 한도를 나눠 쓰지 않는다]');
    // 같은 IP(127.0.0.1)지만 다른 로그인 계정 — 한 사무실에서 여럿이 쓰는 상황이다.
    for (let i = 1; i <= 3; i += 1) check(`다른 계정 ${i}번째`, (await call(FAKE.b)).status, 200);

    console.log('[로그인 전이면 IP로 센다]');
    check('익명 첫 요청은 통과', (await call(null)).status, 200);

    // 화면(접속기록)에서 바꾼 값이 실제로 적용되는지 — 여기가 이번 변경의 핵심이다.
    // 저장해도 반영이 안 되면 관리자는 바꿨다고 믿는데 실제로는 옛 한도로 도는 상태가 된다.
    console.log('[화면에서 바꾼 한도가 적용된다]');
    await appSettings.set(KEY_PER_MINUTE, '1', null);
    check('바뀐 한도 안에서 1건 통과', (await call(FAKE.changed)).status, 200);
    check('2건째는 막힌다(한도 1)', (await call(FAKE.changed)).status, 429);

    // 0은 "제한 없음" — 사고가 났을 때 배포 없이 즉시 풀 수 있어야 한다.
    console.log('[0으로 두면 제한이 풀린다]');
    await appSettings.set(KEY_PER_MINUTE, '0', null);
    await appSettings.set(KEY_PER_HOUR, '0', null);
    let allOk = true;
    for (let i = 0; i < 8; i += 1) { if ((await call(FAKE.unlimited)).status !== 200) allOk = false; }
    check('연속 8건 모두 통과', allOk, true);

    // 관리자가 "지금 얼마나 쓰고 있는지" 보는 값이다. 세기만 하고 못 보여주면 절반이 없는 것이다.
    console.log('[현재 사용량이 조회된다]');
    await appSettings.set(KEY_PER_MINUTE, '5', null);
    await appSettings.set(KEY_PER_HOUR, '1000', null);
    await call(FAKE.usage);
    await call(FAKE.usage);
    const usage = await aiUsageCounter.currentUsage({ limit: 100 });
    const mine = usage.find((r) => r.subject === `u:${FAKE.usage}`);
    check('이번 분 사용량이 잡힌다', mine && mine.minute, 2);
    check('이번 시간 사용량도 잡힌다', !!(mine && mine.hour >= 2), true);

    // 차단이 접속기록에 남아야 관리자가 "막힌 적이 있는지"를 확인할 수 있다.
    console.log('[차단이 접속기록에 남는다]');
    if (realUserId) {
      await appSettings.set(KEY_PER_MINUTE, '1', null);
      await call(realUserId);                       // 1회 — 통과
      check('차단된다', (await call(realUserId)).status, 429);
      // 기록은 await하지 않고 남긴다(응답을 늦추지 않으려고) — 잠깐 기다렸다 확인한다.
      await new Promise((r) => setTimeout(r, 500));
      const logged = await db.get(
        `SELECT work_detail FROM access_logs
          WHERE event_type = ? AND created_at > now() - interval '1 minute'
          ORDER BY id DESC LIMIT 1`,
        [BLOCK_EVENT_TYPE]
      );
      check('접속기록에 차단이 남는다', !!logged, true);
      check('무엇 때문에 막혔는지 적힌다', /한도 초과/.test(String(logged && logged.work_detail)), true);
    } else {
      console.log('  (건너뜀 — 계정이 없습니다)');
    }
  } finally {
    server.close();
    // 검사가 만든 흔적만 지운다 — 운영 값·기록은 건드리지 않는다.
    await clearCounters(subjects);
    await db.run('DELETE FROM app_settings WHERE key IN (?, ?)', [KEY_PER_MINUTE, KEY_PER_HOUR]).catch(() => {});
    await db.run(
      `DELETE FROM access_logs WHERE event_type = ? AND created_at > now() - interval '5 minutes'`,
      [BLOCK_EVENT_TYPE]
    ).catch(() => {});
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
});
