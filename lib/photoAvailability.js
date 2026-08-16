// 콜마너 탁송사진이 실제로 열리기 시작한 시각을 잰다.
//
// 지금은 "재기만" 한다 — 이 값으로 통보를 보내지 않는다. 왜 그런지는 마이그레이션
// 20260816010000 주석에 적어뒀다: 지연이 몇 분인지 반나절인지에 따라 대응이 완전히 갈리는데
// 표본이 1건뿐이라 근거가 없다. 며칠 재본 뒤에 방식을 정한다.
//
// 설계에서 지킨 것 세 가지:
//
//  1. 묶음당 한 장만 확인한다. 한 오더에 26장인데 전부 두드리면 크론 한 번에 수십 요청이 되고,
//     알고 싶은 것은 "이 묶음이 열리기 시작했는가"이지 장별 가용성이 아니다. 콜마너가 묶음
//     단위로 올린다는 가정인데, 실측(OID1237)에서 26장이 같은 초에 저장되고 같은 시점에 전부
//     404였다가 전부 200이 된 것과 맞는다. 대표는 seq가 가장 작은 것으로 고정한다.
//
//  2. 오래된 것은 포기한다. 완료 후 MAX_TRACK_HOURS가 지나도 안 열리면 더 두드리지 않는다 —
//     영영 안 올라오는 사진을 며칠씩 확인하면 크론이 그 일만 하게 된다.
//
//  3. HEAD로 묻는다. 본문을 받을 이유가 없다. HEAD를 막는 서버가 있어서 405/501이 오면
//     GET으로 한 번 더 확인한다(실측: 콜마너 vault는 nginx라 HEAD를 받는다).
const db = require('../db');

const MAX_TRACK_HOURS = 48;   // 이 시간이 지난 오더는 추적을 멈춘다
const BATCH_LIMIT = 20;       // 크론 한 번에 확인할 묶음 수
const FETCH_TIMEOUT_MS = 8000;

async function headOrGet(url) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let res = await fetch(url, { method: 'HEAD', signal: controller.signal });
    // HEAD를 안 받는 서버 대비. 본문은 읽지 않고 상태만 본다.
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: 'GET', signal: controller.signal });
    }
    return { status: res.status, ms: Date.now() - started };
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// 아직 열린 것을 확인하지 못한 묶음들의 대표 사진을 고른다.
// (order_id, phase)별로 seq가 가장 작은 행 하나씩.
async function pickPending(limit) {
  return db.all(
    `SELECT DISTINCT ON (p.order_id, p.phase)
            p.id, p.order_id, p.phase, p.seq, p.url, p.created_at, o.oid
       FROM order_callmaner_photos p
       JOIN orders o ON o.id = p.order_id
      WHERE p.available_at IS NULL
        AND p.created_at > now() - (?::text || ' hours')::interval
      ORDER BY p.order_id, p.phase, p.seq ASC
      LIMIT ${Number(limit) || BATCH_LIMIT}`,
    [String(MAX_TRACK_HOURS)]
  );
}

async function checkPhotoAvailability(options = {}) {
  const limit = Number(options.limit) || BATCH_LIMIT;
  const probe = options.probe || headOrGet;

  let rows;
  try {
    rows = await pickPending(limit);
  } catch (e) {
    // 마이그레이션(20260816010000) 적용 전에는 컬럼이 없다. 크론이 매번 500으로 실패하는 것보다
    // 조용히 넘어가는 편이 낫다 — 적용되면 그날부터 잰다.
    if (e && e.code === '42703') return { skipped: 'column_missing', checked: 0, available: 0 };
    throw e;
  }
  if (!rows.length) return { checked: 0, available: 0, stillPending: 0 };

  let available = 0;
  const results = [];
  for (const row of rows) {
    const r = await probe(row.url);
    const ok = r.status >= 200 && r.status < 300;
    if (ok) {
      // 확인된 시각을 대표 행에만 남긴다. 나머지 장까지 확인한 것은 아니므로 그 행들은 건드리지
      // 않는다 — 나중에 "언제부터 열렸나"를 물으면 이 행 하나가 답이면 충분하다.
      await db.run('UPDATE order_callmaner_photos SET available_at = now() WHERE id = ?', [row.id]);
      available += 1;
    }
    results.push({ oid: row.oid, phase: row.phase, seq: row.seq, status: r.status, savedAt: row.created_at });
  }

  return { checked: rows.length, available, stillPending: rows.length - available, results };
}

module.exports = { checkPhotoAvailability, pickPending, MAX_TRACK_HOURS };
