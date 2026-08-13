// 오래된 감사 로그를 아카이브 테이블로 옮긴다.
//
// 설계에서 지킨 것 세 가지:
//
//  1. 지우지 않고 옮긴다. 감사 로그의 보관 의무를 우리가 단독으로 판단할 수 없다.
//     DELETE ... RETURNING을 INSERT의 입력으로 쓰는 한 문장이라 "옮기다 만" 상태가 없다 —
//     따로 INSERT하고 DELETE하면 그 사이에 죽었을 때 중복되거나 사라진다.
//
//  2. 나눠서 옮긴다. 32만 건을 한 문장으로 옮기면 그 트랜잭션이 오래 잠기고 WAL이 급증한다.
//     한 번에 BATCH_SIZE씩, 크론 한 번에 MAX_BATCHES까지만 한다. 남으면 다음 실행이 이어간다.
//
//  3. 기간은 환경변수로 바꾼다. 0이나 음수면 아무것도 하지 않는다 — 정책이 정해지지 않은
//     환경에서 조용히 옮기기 시작하는 것을 막는다.
const db = require('../db');

const DEFAULT_RETENTION_MONTHS = 12;
const BATCH_SIZE = 5000;
const MAX_BATCHES = 20; // 한 번 실행에 최대 10만 건

function retentionMonths() {
  const raw = process.env.ACCESS_LOG_RETENTION_MONTHS;
  if (raw === undefined || raw === '') return DEFAULT_RETENTION_MONTHS;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_RETENTION_MONTHS;
}

async function archiveOldAccessLogs(options = {}) {
  const months = options.months !== undefined ? Number(options.months) : retentionMonths();
  if (!Number.isFinite(months) || months <= 0) {
    return { skipped: 'retention_disabled', months, moved: 0 };
  }
  const batchSize = Number(options.batchSize) || BATCH_SIZE;
  const maxBatches = Number(options.maxBatches) || MAX_BATCHES;

  let moved = 0;
  let batches = 0;
  let tableMissing = false;
  for (let i = 0; i < maxBatches; i += 1) {
    // 한 문장으로 옮긴다(위 설계 1). 오래된 것부터 id 순으로 집는다.
    const result = await db.run(
      `WITH old AS (
         SELECT id FROM access_logs
          WHERE created_at < now() - (?::text || ' months')::interval
          ORDER BY id ASC
          LIMIT ${batchSize}
       ), moved AS (
         DELETE FROM access_logs a USING old
          WHERE a.id = old.id
          RETURNING a.*
       )
       INSERT INTO access_logs_archive
         (id, user_id, account, event_type, work_detail, subject_info, ip_address, user_agent, success, created_at)
       SELECT id, user_id, account, event_type, work_detail, subject_info, ip_address, user_agent, success, created_at
         FROM moved
       ON CONFLICT (id) DO NOTHING`,
      [String(months)]
    ).catch((e) => {
      // 마이그레이션(20260814050000) 적용 전에는 아카이브 테이블이 없다. 크론이 매일
      // 500으로 실패하는 것보다 조용히 넘어가는 편이 낫다 — 적용되면 그날부터 동작한다.
      if (e && e.code === '42P01') { tableMissing = true; return { rowCount: 0 }; }
      throw e;
    });
    if (tableMissing) break;
    const n = (result && result.rowCount) || 0;
    if (!n) break;
    moved += n;
    batches += 1;
  }

  if (tableMissing) return { skipped: 'archive_table_missing', months, moved: 0 };

  const remaining = await db.get(
    `SELECT count(*)::int AS n FROM access_logs WHERE created_at < now() - (?::text || ' months')::interval`,
    [String(months)]
  ).catch(() => ({ n: null }));

  return { months, moved, batches, remaining: remaining.n };
}

module.exports = { archiveOldAccessLogs, retentionMonths, DEFAULT_RETENTION_MONTHS };
