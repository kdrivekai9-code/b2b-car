// 차종 마스터 조회·등록. 할증 판정(수입/대형·화물/전기)의 근거가 되는 값을 여기서 읽는다.
const db = require('../db');
const {
  normalizeModelName, classifyVehicleModel, carTypeOf, fuelTypeOf, isUnclassified, KEYWORD_KINDS,
} = require('./vehicleClass');

// ── 운영자가 더한 판정 낱말 ────────────────────────────────────────────────
// 요금 계산 경로에서 매번 읽으므로 잠깐 캐시한다. 사전은 거의 안 바뀌는데(브랜드 추가는 연
// 몇 회) 캐시가 없으면 요금 조회마다 표를 통째로 읽는다 — 지금 findByVehicleType이
// 'SELECT * FROM vehicle_models'를 캐시 없이 부르고 있어서, 여기까지 같은 방식이면 부담이 두 배가 된다.
//
// 60초로 짧게 잡은 이유: 운영자가 낱말을 추가하고 바로 접수해보는 흐름이 자연스러워야 한다.
// 1분 뒤부터 반영되는 건 참을 만하고, 그보다 길면 "추가했는데 왜 안 붙지"가 된다.
const KEYWORD_CACHE_MS = 60000;
let keywordCache = null;
let keywordCacheAt = 0;

async function loadExtraKeywords() {
  if (keywordCache && Date.now() - keywordCacheAt < KEYWORD_CACHE_MS) return keywordCache;
  const rows = await db.all('SELECT kind, word FROM vehicle_class_keywords').catch((e) => {
    // 마이그레이션 전이면 표가 없다 — 코드 사전만으로 그대로 동작해야 한다.
    if (!e || e.code !== '42P01') console.error('판정 낱말 조회 실패(코드 사전만 사용):', e.message);
    return [];
  });
  const grouped = {};
  KEYWORD_KINDS.forEach((k) => { grouped[k] = []; });
  (rows || []).forEach((r) => {
    if (grouped[r.kind]) grouped[r.kind].push(r.word);
  });
  keywordCache = grouped;
  keywordCacheAt = Date.now();
  return grouped;
}

// 낱말을 추가·삭제한 직후에는 캐시를 버린다 — 화면에서 저장하고 바로 확인할 수 있어야 한다.
function clearKeywordCache() {
  keywordCache = null;
  keywordCacheAt = 0;
}

// 접수 화면의 차종은 자유 입력이라 "제네시스 G80 2.5T"처럼 등록명보다 길게 들어온다.
// 정확히 같은 이름 → 등록명이 입력에 포함 → 입력이 등록명에 포함 순으로 찾는다.
// 긴 등록명을 먼저 보는 이유: "봉고3 1톤"과 "봉고3"이 둘 다 등록돼 있으면 더 구체적인 쪽이 맞다.
async function findByVehicleType(vehicleType) {
  const norm = normalizeModelName(vehicleType);
  if (!norm) return null;

  const exact = await db.get('SELECT * FROM vehicle_models WHERE norm_name = ?', [norm]).catch(() => null);
  if (exact) return exact;

  const rows = await db.all('SELECT * FROM vehicle_models').catch(() => []);
  const contained = (rows || [])
    .filter((r) => r.norm_name && norm.includes(r.norm_name))
    .sort((a, b) => b.norm_name.length - a.norm_name.length);
  if (contained.length) return contained[0];

  const reverse = (rows || [])
    .filter((r) => r.norm_name && r.norm_name.includes(norm))
    .sort((a, b) => a.norm_name.length - b.norm_name.length);
  return reverse[0] || null;
}

// 이 차종에 어떤 할증이 붙는지. 등록된 차종이 있으면 **그 값이 우선**한다 — 관리자가 손으로
// 고친 판정을 자동 판정이 덮으면 고쳐도 소용이 없다.
//
// 등록이 없으면 그 자리에서 자동 판정한다. 아무 할증도 안 붙이는 편이 안전해 보이지만, 그러면
// 차종을 등록하지 않은 지사에서는 할증 설정이 조용히 무시된다 — 설정한 사람은 적용되는 줄 안다.
// source를 함께 돌려주니 화면에서 "미등록 차종(자동 판정)"이라고 밝힐 수 있다.
async function flagsForVehicleType(vehicleType) {
  const row = await findByVehicleType(vehicleType);
  if (row) {
    const flags = { isImported: !!row.is_imported, isLarge: !!row.is_large, isEv: !!row.is_ev };
    return {
      ...flags,
      // 저장된 분류값을 그대로 쓰되, 마이그레이션 전 행은 비어 있어 boolean에서 만든다.
      carType: row.car_type || carTypeOf(flags),
      fuelType: row.fuel_type || fuelTypeOf(flags),
      source: 'registered',
      // 사람이 확인해 등록한 값이라, 플래그가 하나도 없어도 미확인이 아니다
      // ("이 차는 아무 할증도 안 받는다"를 명시한 것이다).
      classSource: 'registered',
      unclassified: false,
      modelId: row.id,
      modelName: row.name,
    };
  }
  const auto = classifyVehicleModel(vehicleType, await loadExtraKeywords());
  return {
    ...auto,
    carType: carTypeOf(auto),
    fuelType: fuelTypeOf(auto),
    source: 'auto',
    // 사전에 걸린 게 하나도 없으면 '모름'이다 — 할증이 통째로 빠졌을 수 있어 화면에 드러내야 한다.
    classSource: isUnclassified(auto) ? 'unknown' : 'auto',
    unclassified: isUnclassified(auto),
    modelId: null,
    modelName: null,
  };
}

// 차종 등록. 자동 판정 결과를 auto_* 에 그대로 남기고 확정값(is_*)의 초기값으로도 쓴다.
// 나중에 사람이 is_* 를 고쳐도 auto_* 는 그대로라, 둘이 갈리는 차종만 뽑으면 사전의 구멍이 보인다.
async function createModel(name, overrides = {}) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('차종명을 입력해주세요.');
  const norm = normalizeModelName(trimmed);
  const auto = classifyVehicleModel(trimmed);
  const pick = (key) => (overrides[key] === undefined ? auto[key] : !!overrides[key]);
  const chosen = { isImported: pick('isImported'), isLarge: pick('isLarge'), isEv: pick('isEv') };
  await db.run(
    `INSERT INTO vehicle_models (name, norm_name, is_imported, is_large, is_ev, auto_imported, auto_large, auto_ev, note, car_type, fuel_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (norm_name) DO UPDATE SET
       name = excluded.name,
       car_type = excluded.car_type,
       fuel_type = excluded.fuel_type,
       updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')`,
    [trimmed, norm, chosen.isImported, chosen.isLarge, chosen.isEv,
      auto.isImported, auto.isLarge, auto.isEv, auto.reasons.join(', ') || null,
      carTypeOf(chosen), fuelTypeOf(chosen)]
  ).catch(async (e) => {
    // 마이그레이션(20260828020000) 전이면 분류 컬럼이 없다 — 판정 자체는 boolean으로 남겨둔다.
    if (!e || e.code !== '42703') throw e;
    console.error('차종 분류값 저장 실패(마이그레이션 미적용):', e.message);
    await db.run(
      `INSERT INTO vehicle_models (name, norm_name, is_imported, is_large, is_ev, auto_imported, auto_large, auto_ev, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (norm_name) DO UPDATE SET
         name = excluded.name,
         updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')`,
      [trimmed, norm, chosen.isImported, chosen.isLarge, chosen.isEv,
        auto.isImported, auto.isLarge, auto.isEv, auto.reasons.join(', ') || null]
    );
  });
  return db.get('SELECT * FROM vehicle_models WHERE norm_name = ?', [norm]);
}

// 관리자가 체크를 고치면 분류값도 같이 따라가야 한다 — 따로 두면 목록에는 '국산'인데
// 요금은 수입 할증이 붙는 상태가 생긴다.
async function updateFlags(id, flags) {
  const f = { isImported: !!flags.isImported, isLarge: !!flags.isLarge, isEv: !!flags.isEv };
  await db.run(
    `UPDATE vehicle_models SET is_imported = ?, is_large = ?, is_ev = ?, car_type = ?, fuel_type = ?,
       updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
     WHERE id = ?`,
    [f.isImported, f.isLarge, f.isEv, carTypeOf(f), fuelTypeOf(f), id]
  ).catch(async (e) => {
    if (!e || e.code !== '42703') throw e;
    await db.run(
      `UPDATE vehicle_models SET is_imported = ?, is_large = ?, is_ev = ?,
         updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
       WHERE id = ?`,
      [f.isImported, f.isLarge, f.isEv, id]
    );
  });
}

module.exports = { findByVehicleType, flagsForVehicleType, createModel, updateFlags, loadExtraKeywords, clearKeywordCache };
