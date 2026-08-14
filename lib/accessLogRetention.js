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
// 아카이브에서 완전히 지우는 시점. 기본 24개월 = hot 12개월 + 아카이브 12개월.
// 아카이브가 무한히 쌓이면 "옮기기만 하고 아무도 안 지워서 비용만 느는" 상태가 된다 —
// 관리자가 잊어버리는 것을 전제로 상한을 코드에 박아둔다.
const DEFAULT_PURGE_MONTHS = 24;
const BATCH_SIZE = 5000;
const MAX_BATCHES = 20; // 한 번 실행에 최대 10만 건

function envMonths(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function retentionMonths() {
  return envMonths('ACCESS_LOG_RETENTION_MONTHS', DEFAULT_RETENTION_MONTHS);
}

function purgeMonths() {
  return envMonths('ACCESS_LOG_PURGE_MONTHS', DEFAULT_PURGE_MONTHS);
}

// 아카이브에서 보관 상한을 넘긴 행을 영구 삭제한다.
//
// 되돌릴 수 없는 작업이라 지키는 것 세 가지:
//  1. 지우는 대상은 access_logs_archive 뿐이다. hot 테이블(access_logs)은 절대 건드리지 않는다 —
//     아직 아카이브로 옮겨지지도 않은 최근 기록을 지우는 사고를 구조적으로 막는다.
//  2. 삭제 자체를 감사 기록으로 남긴다. "언제 몇 건이 지워졌는지"가 없으면 나중에 데이터가
//     비어 있는 이유를 설명할 수 없다. 이 기록은 hot 테이블에 한 줄만 들어간다.
//  3. 상한(purgeMonths)이 보관 기간(retentionMonths)보다 짧으면 아무것도 하지 않는다 —
//     설정 실수로 아카이브에 막 들어온 행이 곧바로 지워지는 것을 막는다.
async function purgeArchivedAccessLogs(options = {}) {
  const months = options.months !== undefined ? Number(options.months) : purgeMonths();
  const keepMonths = options.retentionMonths !== undefined ? Number(options.retentionMonths) : retentionMonths();
  if (!Number.isFinite(months) || months <= 0) return { skipped: 'purge_disabled', months, deleted: 0 };
  if (Number.isFinite(keepMonths) && keepMonths > 0 && months < keepMonths) {
    return { skipped: 'purge_shorter_than_retention', months, keepMonths, deleted: 0 };
  }

  const batchSize = Number(options.batchSize) || BATCH_SIZE;
  const maxBatches = Number(options.maxBatches) || MAX_BATCHES;
  let deleted = 0;
  let missing = false;

  // 지우기 전에 무엇을 지우는지 확인한다(감사 기록에 남길 범위).
  const target = await db.get(
    `SELECT count(*)::int AS n, min(created_at) AS oldest, max(created_at) AS newest
       FROM access_logs_archive
      WHERE created_at < now() - (?::text || ' months')::interval`,
    [String(months)]
  ).catch((e) => {
    if (e && e.code === '42P01') { missing = true; return { n: 0 }; }
    throw e;
  });
  if (missing) return { skipped: 'archive_table_missing', months, deleted: 0 };
  if (!target || !target.n) return { months, deleted: 0, remaining: 0 };

  for (let i = 0; i < maxBatches; i += 1) {
    const result = await db.run(
      `DELETE FROM access_logs_archive
        WHERE id IN (
          SELECT id FROM access_logs_archive
           WHERE created_at < now() - (?::text || ' months')::interval
           ORDER BY id ASC LIMIT ${batchSize}
        )`,
      [String(months)]
    );
    const n = (result && result.rowCount) || 0;
    if (!n) break;
    deleted += n;
  }

  if (deleted) {
    // 삭제 사실 자체를 감사 기록으로 남긴다(위 설계 2).
    await db.run(
      `INSERT INTO access_logs (user_id, account, event_type, work_detail, subject_info, ip_address, success)
       VALUES (NULL, ?, 'ACCESS_LOG_PURGE', ?, ?, 'system', true)`,
      [
        '(system)',
        `감사 로그 아카이브 ${deleted}건 영구 삭제 (보관 상한 ${months}개월)`,
        `${target.oldest} ~ ${target.newest}`,
      ]
    ).catch((e) => console.error('감사 로그 삭제 기록 실패:', e.message));
  }

  const remaining = await db.get(
    `SELECT count(*)::int AS n FROM access_logs_archive WHERE created_at < now() - (?::text || ' months')::interval`,
    [String(months)]
  ).catch(() => ({ n: null }));

  return { months, deleted, remaining: remaining.n };
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

module.exports = {
  archiveOldAccessLogs,
  purgeArchivedAccessLogs,
  retentionMonths,
  purgeMonths,
  DEFAULT_RETENTION_MONTHS,
  DEFAULT_PURGE_MONTHS,
};
