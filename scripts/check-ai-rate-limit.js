// AI 엔드포인트 사용량 제한 검사.
//
// 왜 필요한가: 이 제한이 잘못 걸리면 두 방향으로 조용히 망가진다 —
//  (1) 너무 빡빡하거나 키가 잘못되면 정상 고객이 대화 중에 막힌다. 특히 IP로 세면 한 사무실에서
//      여러 명이 쓸 때 서로의 한도를 깎아먹는다.
//  (2) 아예 안 걸리면 만든 의미가 없다.
// 실제 Gemini를 부르지 않고 미들웨어만 떼어내 확인한다(비용·시간 없이 반복 가능).
process.env.AI_RATE_LIMIT_PER_MINUTE = '3';
process.env.AI_RATE_LIMIT_PER_HOUR = '100';
delete process.env.AI_RATE_LIMIT_DISABLED;
process.env.NODE_ENV = 'development'; // 테스트 모드면 미들웨어가 통과만 하므로 끈다

const express = require('express');
const { aiRateLimit } = require('../middleware/aiRateLimit');

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
  req.session = id ? { user: { id: Number(id) } } : {};
  next();
});
app.post('/ai', aiRateLimit, (req, res) => res.json({ ok: true }));

const server = app.listen(0, async () => {
  const port = server.address().port;
  const call = async (userId) => {
    const res = await fetch(`http://127.0.0.1:${port}/ai`, {
      method: 'POST',
      headers: userId ? { 'x-test-user': String(userId) } : {},
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  try {
    console.log('[한도 안에서는 통과한다]');
    for (let i = 1; i <= 3; i += 1) {
      const r = await call(1);
      check(`${i}번째 요청`, r.status, 200);
    }

    console.log('[한도를 넘기면 막는다]');
    const blocked = await call(1);
    check('4번째는 429', blocked.status, 429);
    // 챗봇 클라이언트는 JSON을 기대한다 — HTML 오류 페이지가 오면 화면이 깨진다.
    check('JSON으로 답한다', !!(blocked.body && blocked.body.reason === 'ai_rate_limited'), true);
    check('내부 수치를 노출하지 않는다', /\d+회|분당|한도/.test(String(blocked.body.error)), false);

    console.log('[계정이 다르면 한도를 나눠 쓰지 않는다]');
    // 같은 IP(127.0.0.1)지만 다른 로그인 계정 — 한 사무실에서 여럿이 쓰는 상황이다.
    for (let i = 1; i <= 3; i += 1) {
      const r = await call(2);
      check(`다른 계정 ${i}번째`, r.status, 200);
    }

    console.log('[로그인 전이면 IP로 센다]');
    const anon1 = await call(null);
    check('익명 첫 요청은 통과', anon1.status, 200);
  } finally {
    server.close();
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
});
