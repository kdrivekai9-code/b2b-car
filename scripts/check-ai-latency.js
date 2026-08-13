// AI 호출이 실제로 얼마나 걸리는지 본다.
//
// 두 가지 방법이 있고 둘 다 여기 있다:
//
//   1) 실사용 기록 요약 (기본, 무료)
//      lib/aiCallLog.js가 남긴 ai_call_logs를 용도별로 집계한다. 진짜 고객 입력에 대한
//      진짜 소요 시간이라 가장 정확하다. 다만 기록이 쌓여야 볼 것이 생긴다.
//        node scripts/check-ai-latency.js
//        node scripts/check-ai-latency.js --hours 24
//
//   2) 능동 측정 (--probe, 실제 Vertex 호출 = 비용·쿼터 발생)
//      대표 입력 몇 개를 실제로 호출해 지금 이 순간의 지연을 잰다. 배포 직후처럼 기록이 없을
//      때, 또는 모델·설정을 바꾸고 전후를 비교할 때 쓴다.
//        node scripts/check-ai-latency.js --probe 3
//
// 능동 측정은 고객에게 아무것도 보내지 않는다 — 모델만 부르고 결과는 화면에 요약한다.
// DB에도 계측 행(ai_call_logs)만 남고 오더·메시지는 만들지 않는다.
require('dotenv').config();
const db = require('../db');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { hours: 168, probe: 0 };
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--hours') out.hours = Number(args[i + 1]) || 168;
    if (args[i] === '--probe') out.probe = Number(args[i + 1]) || 3;
  }
  return out;
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function summarize(hours) {
  const rows = await db.all(
    `SELECT op, duration_ms, ok, image_count, input_chars
       FROM ai_call_logs
      WHERE created_at >= now() - (?::text || ' hours')::interval
      ORDER BY id DESC`,
    [String(hours)]
  ).catch((e) => {
    if (e && e.code === '42P01') {
      console.log('ai_call_logs 테이블이 없습니다 — 마이그레이션 20260814040000을 먼저 실행하세요.');
      return null;
    }
    throw e;
  });
  if (rows === null) return false;
  if (!rows.length) {
    console.log(`최근 ${hours}시간 기록 없음. 실사용이 있어야 쌓입니다 — 지금 당장 숫자가 필요하면 --probe를 쓰세요.`);
    return true;
  }

  const byOp = new Map();
  for (const r of rows) {
    if (!byOp.has(r.op)) byOp.set(r.op, []);
    byOp.get(r.op).push(r);
  }

  console.log(`최근 ${hours}시간 / 총 ${rows.length}건\n`);
  console.log('용도                건수   실패    p50      p95      최대     평균입력');
  console.log('-'.repeat(74));
  const ordered = [...byOp.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [op, list] of ordered) {
    const times = list.map((r) => Number(r.duration_ms)).sort((a, b) => a - b);
    const fails = list.filter((r) => !r.ok).length;
    const avgIn = Math.round(list.reduce((s, r) => s + (Number(r.input_chars) || 0), 0) / list.length);
    console.log(
      `${op.padEnd(20)}${String(list.length).padStart(4)}  ${String(fails).padStart(4)}  `
      + `${(pct(times, 50) + 'ms').padStart(7)}  ${(pct(times, 95) + 'ms').padStart(7)}  `
      + `${(times[times.length - 1] + 'ms').padStart(7)}  ${String(avgIn).padStart(7)}자`
    );
  }

  const all = rows.map((r) => Number(r.duration_ms)).sort((a, b) => a - b);
  console.log('-'.repeat(74));
  console.log(`전체                ${String(rows.length).padStart(4)}  ${String(rows.filter((r) => !r.ok).length).padStart(4)}  `
    + `${(pct(all, 50) + 'ms').padStart(7)}  ${(pct(all, 95) + 'ms').padStart(7)}  ${(all[all.length - 1] + 'ms').padStart(7)}`);

  const slow = rows.filter((r) => Number(r.duration_ms) > 5000).length;
  if (slow) console.log(`\n5초를 넘긴 호출 ${slow}건 — 고객이 그 시간만큼 기다렸다는 뜻이다.`);
  return true;
}

// 대표 입력으로 실제 호출해 지금의 지연을 잰다.
async function probe(times) {
  const { generateJson } = require('../lib/vertexAi');
  // 실제 상담톡에 오는 접수 폼과 같은 형태(로그에서 가져온 전형적인 모양).
  const INTAKE_SAMPLE = [
    '[출발지] 서울 강서구 양천로53길 30',
    '[도착지] 경기 성남시 분당구 판교역로 160',
    '차량번호 : 12가3456',
    '일시 : 8월 20일 14시',
  ].join('\n');
  const SCHEMA = {
    type: 'OBJECT',
    properties: { intent: { type: 'STRING' }, summary: { type: 'STRING' } },
    required: ['intent'],
  };

  const cases = [
    { op: 'probe_intake', instruction: '탁송 접수 폼에서 의도를 분류하고 한 줄로 요약하세요.', text: INTAKE_SAMPLE, opts: {} },
    { op: 'probe_short', instruction: '고객 발화의 의도를 한 단어로 분류하세요.', text: '기사님 언제 오시나요?', opts: { thinking: false } },
  ];

  console.log(`능동 측정 — 각 ${times}회씩 실제 Vertex를 호출합니다(비용·쿼터 발생).\n`);
  for (const c of cases) {
    const durations = [];
    let failed = 0;
    for (let i = 0; i < times; i += 1) {
      const started = Date.now();
      try {
        await generateJson(c.instruction, c.text, SCHEMA, { ...c.opts, op: c.op });
        durations.push(Date.now() - started);
      } catch (e) {
        failed += 1;
        console.log(`  ${c.op} ${i + 1}회차 실패: ${e.message.slice(0, 80)}`);
      }
    }
    const sorted = durations.sort((a, b) => a - b);
    const avg = sorted.length ? Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length) : 0;
    console.log(`${c.op.padEnd(14)} 성공 ${sorted.length}/${times}  최소 ${sorted[0] || 0}ms  평균 ${avg}ms  최대 ${sorted[sorted.length - 1] || 0}ms${failed ? `  (실패 ${failed})` : ''}`);
  }
  console.log('\n※ thinking을 끈 호출(probe_short)이 훨씬 빠른 것이 정상이다 — vertexAi.js의 A/B 주석 참고.');
}

async function main() {
  const { hours, probe: probeCount } = parseArgs();
  if (probeCount > 0) {
    await probe(probeCount);
    console.log('');
  }
  await summarize(hours);
  process.exit(0);
}

main().catch((e) => { console.error('오류:', e.message); process.exit(1); });
