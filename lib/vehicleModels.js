// 차종 마스터 조회·등록. 할증 판정(수입/대형·화물/전기)의 근거가 되는 값을 여기서 읽는다.
const db = require('../db');
const { normalizeModelName, classifyVehicleModel } = require('./vehicleClass');

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
    return {
      isImported: !!row.is_imported,
      isLarge: !!row.is_large,
      isEv: !!row.is_ev,
      source: 'registered',
      modelId: row.id,
      modelName: row.name,
    };
  }
  const auto = classifyVehicleModel(vehicleType);
  return { ...auto, source: 'auto', modelId: null, modelName: null };
}

// 차종 등록. 자동 판정 결과를 auto_* 에 그대로 남기고 확정값(is_*)의 초기값으로도 쓴다.
// 나중에 사람이 is_* 를 고쳐도 auto_* 는 그대로라, 둘이 갈리는 차종만 뽑으면 사전의 구멍이 보인다.
async function createModel(name, overrides = {}) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('차종명을 입력해주세요.');
  const norm = normalizeModelName(trimmed);
  const auto = classifyVehicleModel(trimmed);
  const pick = (key) => (overrides[key] === undefined ? auto[key] : !!overrides[key]);
  await db.run(
    `INSERT INTO vehicle_models (name, norm_name, is_imported, is_large, is_ev, auto_imported, auto_large, auto_ev, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (norm_name) DO UPDATE SET
       name = excluded.name,
       updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')`,
    [trimmed, norm, pick('isImported'), pick('isLarge'), pick('isEv'),
      auto.isImported, auto.isLarge, auto.isEv, auto.reasons.join(', ') || null]
  );
  return db.get('SELECT * FROM vehicle_models WHERE norm_name = ?', [norm]);
}

async function updateFlags(id, flags) {
  await db.run(
    `UPDATE vehicle_models SET is_imported = ?, is_large = ?, is_ev = ?,
       updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
     WHERE id = ?`,
    [!!flags.isImported, !!flags.isLarge, !!flags.isEv, id]
  );
}

module.exports = { findByVehicleType, flagsForVehicleType, createModel, updateFlags };
