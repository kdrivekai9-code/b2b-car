// 쓰기 부하를 건다 — INSERT/UPDATE가 섞였을 때 커넥션 풀이 어떻게 버티는지 본다.
//
// 조회 부하(load-test-read.js)와 나눈 이유: 쓰기는 성격이 다르다. 트랜잭션이 걸리고, WAL을
// 쓰고, 인덱스를 갱신하고, 같은 행을 여러 요청이 동시에 건드리면 잠금 경합이 생긴다. 조회가
// 130/s 나온다고 쓰기도 그렇다는 보장이 없다.
//
// ── 안전장치 ────────────────────────────────────────────────────────────────
// 이 DB는 프로덕션이다. 그래서 HTTP 경로(접수·통보 API)를 때리지 않는다 — 그 경로를 부르면
// 콜마너에 진짜 오더가 등록되고 고객에게 카카오가 나간다. 대신 **우리가 만든 표식 행에만**
// 직접 INSERT/UPDATE한다:
//
//   · 모든 행에 MARK가 박힌다. 정리는 MARK로만 지운다("최근 N건" 같은 정리는 하지 않는다).
//   · 건드리는 테이블은 부하용으로 만든 행뿐이다. 기존 오더·세션·메시지는 읽지도 쓰지도 않는다.
//   · 외부 호출(콜마너/카카오/Vertex)은 한 건도 하지 않는다.
//   · finally에서 반드시 정리하고, 정리 결과를 건수로 보여준다.
//
//   node scripts/load-test-write.js
//   node scripts/load-test-write.js --levels 10,50 --requests 200
require('dotenv').config();
const db = require('../db');

const MARK = 'load-test-write';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { levels: [5, 10, 25, 50, 100], requests: 100 };
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--levels') out.levels = args[i + 1].split(',').map(Number).filter((n) => n > 0);
    if (args[i] === '--requests') out.requests = Number(args[i + 1]) || 100;
  }
  return out;
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// 한 건의 "쓰기 작업" — 실제 접수가 하는 일과 같은 모양으로 맞춘다:
// 메시지 INSERT → 그 행 UPDATE → 세션 UPDATE. 단일 INSERT만 반복하면 잠금 경합이 안 생겨
// 실제보다 좋게 나온다(같은 세션 행을 여러 요청이 함께 건드리는 것이 현실이다).
async function writeUnit(sessionId) {
  const inserted = await db.get(
    `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'system', ?) RETURNING id`,
    [sessionId, `${MARK} ${Date.now()}`]
  );
  await db.run('UPDATE chat_messages SET message = ? WHERE id = ?', [`${MARK} updated`, inserted.id]);
  await db.run('UPDATE chat_sessions SET updated_at = now() WHERE id = ?', [sessionId]);
  return inserted.id;
}

async function runLevel(concurrency, total, sessionId) {
  const results = [];
  let issued = 0;
  const started = Date.now();
  async function worker() {
    while (issued < total) {
      issued += 1;
      const t = Date.now();
      try {
        await writeUnit(sessionId);
        results.push({ ok: true, ms: Date.now() - t });
      } catch (e) {
        results.push({ ok: false, ms: Date.now() - t, error: e.message });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = (Date.now() - started) / 1000;
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const errors = results.filter((r) => !r.ok);
  const errorKinds = errors.reduce((acc, r) => {
    const key = String(r.error).slice(0, 40);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return {
    concurrency, total, elapsed, rps: total / elapsed,
    p50: pct(times, 50), p95: pct(times, 95), max: times[times.length - 1] || 0,
    ok: results.length - errors.length, failed: errors.length, errorKinds,
  };
}

async function main() {
  const { levels, requests } = parseArgs();
  let sessionId = null;
  let created = 0;

  try {
    // 부하 전용 세션 하나. 웹 채널로 만들고 카카오 발신 키를 넣지 않는다 — 어떤 경로로도
    // 이 세션 때문에 고객에게 메시지가 나갈 수 없게 한다.
    const s = await db.get(
      `INSERT INTO chat_sessions (user_id, status, channel) VALUES (NULL, 'bot', 'web') RETURNING id`
    );
    sessionId = s.id;
    console.log(`부하 전용 세션 생성: ${sessionId} (채널 web, 발신 키 없음)\n`);
    console.log(`단계: 동시 ${levels.join(' → ')} / 각 단계 ${requests}건 (1건 = INSERT 1 + UPDATE 2)\n`);
    console.log('동시성   작업수    소요     처리량      p50      p95      최대    성공/실패');
    console.log('-'.repeat(88));

    for (const c of levels) {
      const r = await runLevel(c, requests, sessionId);
      created += r.ok;
      console.log(
        `${String(r.concurrency).padStart(5)}   ${String(r.total).padStart(6)}  ${r.elapsed.toFixed(1).padStart(6)}s  `
        + `${r.rps.toFixed(0).padStart(6)}/s  ${(r.p50 + 'ms').padStart(7)}  ${(r.p95 + 'ms').padStart(7)}  `
        + `${(r.max + 'ms').padStart(7)}   ${r.ok}/${r.failed}`
      );
      if (r.failed) console.log(`         실패 내역: ${JSON.stringify(r.errorKinds)}`);
    }
  } finally {
    // 표식으로만 지운다. 세션은 우리가 만든 id를 정확히 지목한다.
    let deletedMessages = 0;
    if (sessionId) {
      const d = await db.run('DELETE FROM chat_messages WHERE session_id = ?', [sessionId]);
      deletedMessages = (d && d.rowCount) || 0;
      await db.run('DELETE FROM chat_sessions WHERE id = ? AND channel = ?', [sessionId, 'web']);
    }
    // 혹시 이전 실행이 남긴 것이 있으면 함께 정리한다(표식이 있는 것만).
    const stray = await db.run('DELETE FROM chat_messages WHERE message LIKE ?', [`${MARK}%`]);
    console.log(`\n정리: 메시지 ${deletedMessages}건 + 잔여 ${(stray && stray.rowCount) || 0}건 삭제, 세션 ${sessionId ?? '-'} 삭제`);
    const left = await db.get('SELECT count(*)::int AS n FROM chat_messages WHERE message LIKE ?', [`${MARK}%`]);
    console.log(`남은 표식 행: ${left.n}건 ${left.n === 0 ? '(정상)' : '⚠️ 남았다 — 직접 확인 필요'}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error('오류:', e.message); process.exit(1); });
