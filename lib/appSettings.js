// 화면에서 바꾸는 전역 설정(app_settings)을 읽고 쓴다.
//
// 캐시를 두는 이유: 이 값을 읽는 쪽이 AI 사용량 제한 미들웨어라 **모든 요청마다** 호출된다.
// 매번 DB를 때리면 제한을 걸어 아끼려던 것보다 더 큰 비용이 든다. 짧게(기본 30초) 들고 있다가
// 다시 읽는다 — 설정을 바꾸면 최대 그 시간만큼 늦게 반영되고, 화면에도 그렇게 안내한다.
//
// 서버리스에서는 인스턴스마다 캐시가 따로 산다(lib/vertexAi.js의 토큰 캐시와 같은 한계).
// 그래서 "30초 뒤에는 반드시 반영"이 아니라 "30초쯤 지나면 반영"이다. 설정값 성격상 그 정도
// 지연은 문제가 되지 않는다.
const db = require('../db');

const CACHE_TTL_MS = Number(process.env.APP_SETTINGS_CACHE_MS) || 30000;
const UNDEFINED_TABLE = '42P01';

let cache = null;         // Map(key → value)
let cachedAt = 0;
let loading = null;

async function loadAll() {
  // 마이그레이션 전이면 테이블이 없다 — 설정이 하나도 없는 것으로 보고 호출부의 기본값을 쓴다.
  const rows = await db.all('SELECT key, value FROM app_settings').catch((e) => {
    if (e && e.code === UNDEFINED_TABLE) return [];
    throw e;
  });
  return new Map(rows.map((r) => [r.key, r.value]));
}

async function ensureCache() {
  if (cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache;
  // 동시에 여러 요청이 들어와도 조회는 한 번만 한다.
  if (!loading) {
    loading = loadAll()
      .then((map) => { cache = map; cachedAt = Date.now(); return map; })
      .catch((e) => {
        console.error('전역 설정 조회 실패(기본값으로 진행):', e.message);
        // 실패했다고 캐시를 비우지 않는다 — 직전 값이 있으면 그걸 계속 쓰는 편이 안전하다.
        return cache || new Map();
      })
      .finally(() => { loading = null; });
  }
  return loading;
}

// 숫자 설정 하나를 읽는다. 값이 없거나 숫자가 아니면 fallback.
// min/max를 주면 그 범위를 벗어난 저장값도 fallback으로 되돌린다 — 화면 검증을 우회해 이상한
// 값이 들어가더라도 서비스가 이상하게 동작하지 않게 한다.
async function getNumber(key, fallback, { min, max } = {}) {
  const map = await ensureCache();
  const raw = map.get(key);
  const n = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(n)) return fallback;
  if (min != null && n < min) return fallback;
  if (max != null && n > max) return fallback;
  return n;
}

async function getAll() {
  const map = await ensureCache();
  return Object.fromEntries(map);
}

async function set(key, value, userId) {
  await db.run(
    `INSERT INTO app_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, now(), ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
    [key, value == null ? null : String(value), userId || null]
  );
  invalidate();
}

// 저장 직후에는 방금 바꾼 관리자가 바로 확인할 수 있어야 한다(같은 인스턴스 한정).
function invalidate() {
  cache = null;
  cachedAt = 0;
}

module.exports = { getNumber, getAll, set, invalidate, CACHE_TTL_MS };
