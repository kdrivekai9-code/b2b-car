// Vertex가 일시적으로 거절(429/503)했을 때 다시 부르는지 본다.
//
// 왜 필요한가(실측 2026-09-14): 09-09부터 429가 나기 시작해 그날 180건 중 90건(50%)이
// 429로 떨어졌다. 그런데 우리가 한도를 넘긴 게 아니다 — 분당 최대 27회인데 자체 한도는
// 분당 60회고 차단 기록(AI_RATE_LIMITED)은 0건이며, 호출량이 오히려 줄어든 날 429가
// 시작됐다(09-08 487건 0건 → 09-09 410건 43건). gemini-2.5-flash는 이 프로젝트 쿼터
// 목록에 항목 자체가 없고 과금은 정상이라, 전용 쿼터 없이 공유 용량을 쓰는 상태다.
//
// 그래서 429는 "우리 한도 초과"가 아니라 "그 순간 자리가 없다"는 뜻이고, 올릴 쿼터가 없으니
// **다시 부르는 것**이 올바른 대응이다. 그런데 재시도는 조용히 사라지기 쉽다 — 지우거나
// 조건을 좁혀도 화면은 멀쩡히 돌고, 폴백이 받아주기 때문에 오류도 안 난다.
//
// fetch를 주입해서 확인한다 — 네트워크도 DB도 안 쓰고 회차마다 답이 갈리지 않는다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const vertex = require('../lib/vertexAi');

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

// 응답 흉내. headers.get만 쓴다.
const resp = (status, body = '{}', headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
  json: async () => JSON.parse(body),
  headers: { get: (k) => headers[String(k).toLowerCase()] || null },
});

// 정해진 순서대로 응답을 돌려주는 가짜 fetch. 몇 번 불렸는지 남긴다.
function fakeFetch(sequence) {
  const calls = [];
  const fn = async () => { calls.push(Date.now()); return sequence[Math.min(calls.length - 1, sequence.length - 1)]; };
  fn.calls = calls;
  return fn;
}

const waits = [];
const noSleep = async (ms) => { waits.push(ms); };
const call = (seq, opts = {}) => vertex.callVertex('https://x', {}, 1000, '시험 호출 실패',
  { doFetch: fakeFetch(seq), sleepFn: noSleep, random: () => 1, ...opts });

async function main() {
  console.log('[429면 다시 부른다]');
  {
    waits.length = 0;
    const f = fakeFetch([resp(429, '{"error":{"code":429}}'), resp(200, '{"ok":true}')]);
    const res = await vertex.callVertex('https://x', {}, 1000, '시험 호출 실패',
      { doFetch: f, sleepFn: noSleep, random: () => 1 });
    check('두 번째 시도로 성공한다', res.status === 200);
    check('실제로 두 번 불렀다', f.calls.length === 2, `호출 ${f.calls.length}회`);
    check('사이에 기다린다', waits.length === 1 && waits[0] > 0, `대기 ${JSON.stringify(waits)}`);
  }
  {
    waits.length = 0;
    const f = fakeFetch([resp(503), resp(200, '{"ok":true}')]);
    const res = await vertex.callVertex('https://x', {}, 1000, '시험 호출 실패',
      { doFetch: f, sleepFn: noSleep, random: () => 1 });
    check('503도 다시 부른다', res.status === 200 && f.calls.length === 2);
  }

  console.log('\n[끝없이 부르지는 않는다]');
  {
    const f = fakeFetch([resp(429, '{"error":{"code":429}}')]);
    let err = null;
    await vertex.callVertex('https://x', {}, 1000, '시험 호출 실패',
      { doFetch: f, sleepFn: noSleep, random: () => 1 }).catch((e) => { err = e; });
    check('계속 429면 포기한다', !!err);
    check(`최대 ${vertex.RETRY_MAX_ATTEMPTS}번만 부른다`, f.calls.length === vertex.RETRY_MAX_ATTEMPTS,
      `호출 ${f.calls.length}회`);
    // 메시지 모양은 예전 그대로여야 한다 — ai_call_logs에 쌓인 과거 기록과 대조할 수 있어야 한다.
    check('에러 메시지 모양이 그대로다', !!err && /^시험 호출 실패 \(429\): /.test(err.message), err && err.message);
  }

  console.log('\n[잘못된 요청은 다시 부르지 않는다]');
  for (const status of [400, 401, 403, 404, 500]) {
    const f = fakeFetch([resp(status, '{"error":{}}')]);
    let err = null;
    await vertex.callVertex('https://x', {}, 1000, '시험 호출 실패',
      { doFetch: f, sleepFn: noSleep, random: () => 1 }).catch((e) => { err = e; });
    // 다시 불러도 같은 답이 오고, 그동안 고객만 기다린다.
    check(`${status}는 한 번만 부른다`, !!err && f.calls.length === 1, `호출 ${f.calls.length}회`);
  }

  console.log('\n[기다리는 시간]');
  check('지수로 늘어난다', vertex.retryDelayMs(1, null, () => 1) < vertex.retryDelayMs(2, null, () => 1));
  // 지터가 없으면 같은 순간에 밀린 요청들이 같은 순간에 다시 몰려와 두 번째도 함께 밀린다.
  check('지터가 걸린다', vertex.retryDelayMs(2, null, () => 0) === 0
    && vertex.retryDelayMs(2, null, () => 1) > 0);
  check('Retry-After를 따른다', vertex.retryDelayMs(1, '2', () => 1) === 2000);
  check('Retry-After가 길어도 상한이 있다', vertex.retryDelayMs(1, '600', () => 1) <= 4000);

  console.log('\n[호출부가 모두 거친다]');
  const src = read('lib/vertexAi.js');
  check('fetchWithTimeout을 직접 쓰지 않는다(OAuth 제외)',
    (src.match(/await fetchWithTimeout\(url,/g) || []).length === 0,
    'Vertex 호출은 전부 callVertex를 거쳐야 재시도가 붙는다');
  check('임베딩·생성·이미지·도구 네 곳이 거친다',
    (src.match(/await callVertex\(url,/g) || []).length === 4);
  // 예산이 없으면 한 번 25초 타임아웃 × 3회로 75초를 기다리게 된다 — 실패보다 나쁘다.
  check('전체 예산이 있다', vertex.RETRY_BUDGET_MS > 0 && vertex.RETRY_BUDGET_MS <= 20000);

  console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('검사 실패:', e.message); process.exit(1); });
