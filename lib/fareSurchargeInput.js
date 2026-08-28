// 요금설정 화면(지사/법인)에서 올라온 할증·부대비용 입력의 검증과 저장.
//
// 지사와 법인이 같은 화면 부품(views/partials/fare_surcharge_settings.ejs)을 쓰므로 파싱도
// 한 벌만 둔다 — 두 벌이면 한쪽 화면에서 저장할 때만 값이 틀리는 버그가 생기고, 그건 화면을
// 열어보기 전에는 드러나지 않는다.
const db = require('../db');
const fareSurcharge = require('./fareSurcharge');

const { SURCHARGE_FEE_MIN, SURCHARGE_FEE_MAX, EXTRA_COST_ITEMS } = fareSurcharge;

// 금액 칸과 화면에 보이는 이름. 오류 문구가 "어느 칸"인지 짚어야 관리자가 고칠 수 있다.
const FEE_FIELDS = [
  ['imported_car_fee', '수입차 할증'],
  ['large_car_fee', '대형/화물 할증'],
  ['ev_fee', '전기차 할증'],
  ['night_fee', '야간/조조 할증'],
  ['remote_area_fee', '오지 지역 할증'],
  ['document_fee', '서류 회수/전달'],
  ['predelivery_wash_fee', '인도 전 세차'],
];

const TIME_FIELDS = [
  ['night_start_hm', '22:00'],
  ['night_end_hm', '01:00'],
  ['early_start_hm', '06:00'],
  ['early_end_hm', '09:00'],
];

const RANGE_TEXT = `0(안 받음) 또는 ${SURCHARGE_FEE_MIN.toLocaleString('ko-KR')}~${SURCHARGE_FEE_MAX.toLocaleString('ko-KR')}원`;

function feeOutOfRange(raw) {
  const fee = Number(raw) || 0;
  return fee !== 0 && (fee < SURCHARGE_FEE_MIN || fee > SURCHARGE_FEE_MAX);
}

// 범위를 벗어난 첫 칸을 찾아 안내 문구를 만든다. null이면 통과.
function findBadFee(body) {
  for (const [field, label] of FEE_FIELDS) {
    if (feeOutOfRange(body[field])) return `${label} 금액은 ${RANGE_TEXT} 사이로 입력해주세요.`;
  }
  const placeFees = [].concat(body.place_fee || []);
  const placeKeywords = [].concat(body.place_keyword || []);
  for (let i = 0; i < placeFees.length; i++) {
    // 낱말이 비어 있는 줄은 저장할 때 버리므로 금액도 따지지 않는다.
    if (!String(placeKeywords[i] || '').trim()) continue;
    if (feeOutOfRange(placeFees[i])) return `목적지 장소 할증은 ${RANGE_TEXT} 사이로 입력해주세요.`;
  }
  const largeIds = [].concat(body.large_model_id || []);
  const largeFees = [].concat(body.large_model_fee || []);
  for (let i = 0; i < largeIds.length; i++) {
    if (!String(largeIds[i] || '').trim()) continue;
    // 빈 칸은 "기본 금액을 쓴다"는 뜻이라 검사 대상이 아니다(0과 다르다).
    if (String(largeFees[i] === undefined || largeFees[i] === null ? '' : largeFees[i]).trim() === '') continue;
    if (feeOutOfRange(largeFees[i])) return `차종별 대형/화물 할증은 ${RANGE_TEXT} 사이로 입력해주세요.`;
  }
  return null;
}

// 차종별 대형/화물 할증.
//
// 화면은 등록된 대형 차종을 **전부** 한 줄씩 깔고 금액만 받는다. 그래서 빈 칸이 정상이고,
// 빈 칸과 0을 반드시 구분해야 한다:
//   빈 칸 → 행을 만들지 않는다 = 기본 금액(large_car_fee)을 쓴다
//   0     → 행을 만든다        = 이 차종만 대형 할증을 안 받는다
// 빈 문자열을 Number()에 그대로 넘기면 0이 되므로, 여기서 먼저 걸러야 한다 — 안 그러면
// 관리자가 아무것도 안 건드리고 저장만 눌러도 모든 대형 차종의 할증이 0원이 된다.
//
// 같은 차종이 두 번 오면 어느 금액이 맞는지 알 수 없어 첫 줄만 남긴다(DB에도 유니크 인덱스가
// 있지만, 화면에서 걸러야 저장 실패 대신 조용히 정리된다).
function parseLargeCarRows(body) {
  const ids = [].concat(body.large_model_id || []);
  const fees = [].concat(body.large_model_fee || []);
  const rows = [];
  const seen = new Set();
  for (let i = 0; i < ids.length; i++) {
    const id = Number(ids[i]);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
    const raw = String(fees[i] === undefined || fees[i] === null ? '' : fees[i]).trim();
    if (raw === '') continue; // 기본 금액을 쓴다
    const fee = Number(raw);
    if (!Number.isFinite(fee)) continue;
    seen.add(id);
    rows.push({ vehicleModelId: id, fee: Math.max(0, Math.round(fee)), seq: rows.length + 1 });
  }
  return rows;
}

function normalizeHm(raw, fallback) {
  const v = String(raw || '').trim();
  return /^\d{1,2}:\d{2}$/.test(v) ? v : fallback;
}

// UPDATE에 넣을 컬럼 값. 화면에 없는 값은 기본값으로 채운다 — undefined를 그대로 바인딩하면
// 컬럼이 NULL이 되어 "설정 안 함"과 "0원"이 구분되지 않는다.
function settingsColumns(body) {
  const cols = {};
  FEE_FIELDS.forEach(([field]) => { cols[field] = Number(body[field]) || 0; });
  TIME_FIELDS.forEach(([field, fallback]) => { cols[field] = normalizeHm(body[field], fallback); });
  cols.remote_area_scope = fareSurcharge.normalizeRemoteScope(body.remote_area_scope);
  EXTRA_COST_ITEMS.forEach((item) => {
    // 화면은 select라 값이 반드시 온다. 안 오면(구버전 화면 등) 단가표 기본값을 유지한다.
    const raw = body[item.settingKey];
    cols[item.settingKey] = raw === undefined ? (item.defaultIncluded ? 1 : 0) : (Number(raw) === 1 ? 1 : 0);
  });
  return cols;
}

// 새 컬럼은 **별도 UPDATE**로 저장한다.
//
// 기존 INSERT ... ON CONFLICT 문에 컬럼을 더 붙이면, 마이그레이션 전 DB에서 문 전체가 실패해
// 폴백 경로로 떨어지면서 함께 넣으려던 다른 값까지 조용히 날아간다(예전 memo_driver_brief에서
// 같은 사고를 냈다). 새 컬럼만 따로 쓰면 실패해도 나머지 설정은 이미 저장된 뒤다.
async function saveSettings(scope, id, body) {
  const cols = settingsColumns(body);
  const table = scope === 'group' ? 'group_fare_extra_settings' : 'fare_extra_settings';
  const keyCol = scope === 'group' ? 'group_id' : 'branch_id';
  const names = Object.keys(cols);
  const setSql = names.map((n) => `${n} = ?`).join(', ');
  try {
    await db.run(`UPDATE ${table} SET ${setSql} WHERE ${keyCol} = ?`, [...names.map((n) => cols[n]), id]);
    return { ok: true };
  } catch (e) {
    // 42703 = undefined_column. 마이그레이션(20260828010000) 전이면 여기로 온다.
    if (!e || e.code !== '42703') throw e;
    console.error('할증/부대비용 설정 저장 실패(마이그레이션 미적용):', e.message);
    return { ok: false, reason: 'migration' };
  }
}

function parseRows(body, nameKey, feeKey) {
  const names = [].concat(body[nameKey] || []);
  const fees = [].concat(body[feeKey] || []);
  const rows = [];
  const seen = new Set();
  for (let i = 0; i < names.length; i++) {
    const name = String(names[i] || '').trim();
    if (!name) continue;
    // 같은 낱말을 두 번 넣으면 판정이 중복되니 먼저 넣은 줄만 남긴다.
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ name, fee: Math.max(0, Math.round(Number(fees[i]) || 0)), seq: rows.length + 1 });
  }
  return rows;
}

// 목록형 설정(목적지 장소 / 특수 구간)은 지우고 다시 넣는다 — 화면이 보내는 것이 곧 전체 목록이다.
async function saveScopedRules(scope, id, body) {
  const keyCol = scope === 'group' ? 'group_id' : 'branch_id';
  const places = parseRows(body, 'place_keyword', 'place_fee');
  const tolls = parseRows(body, 'toll_name', 'toll_fee');
  try {
    await db.run(`DELETE FROM fare_place_surcharges WHERE ${keyCol} = ?`, [id]);
    for (const p of places) {
      await db.run(
        `INSERT INTO fare_place_surcharges (${keyCol}, keyword, fee, seq) VALUES (?, ?, ?, ?)`,
        [id, p.name, fareSurcharge.clampFee(p.fee), p.seq]
      );
    }
    await db.run(`DELETE FROM fare_special_tolls WHERE ${keyCol} = ?`, [id]);
    for (const t of tolls) {
      // 특수 구간 통행료는 실비라 할증 상·하한을 적용하지 않는다 — 교량 요금은 1,000원 미만도 있다.
      await db.run(
        `INSERT INTO fare_special_tolls (${keyCol}, name, fee, seq) VALUES (?, ?, ?, ?)`,
        [id, t.name, t.fee, t.seq]
      );
    }
    await db.run(`DELETE FROM fare_large_car_fees WHERE ${keyCol} = ?`, [id]);
    for (const r of parseLargeCarRows(body)) {
      await db.run(
        `INSERT INTO fare_large_car_fees (${keyCol}, vehicle_model_id, fee, seq) VALUES (?, ?, ?, ?)`,
        [id, r.vehicleModelId, fareSurcharge.clampFee(r.fee), r.seq]
      );
    }
    return { ok: true };
  } catch (e) {
    // 42P01 = undefined_table. 마이그레이션 전이면 목록 테이블 자체가 없다.
    if (!e || (e.code !== '42P01' && e.code !== '42703')) throw e;
    console.error('할증 목록 저장 실패(마이그레이션 미적용):', e.message);
    return { ok: false, reason: 'migration' };
  }
}

module.exports = {
  FEE_FIELDS, TIME_FIELDS, RANGE_TEXT,
  feeOutOfRange, findBadFee, normalizeHm, settingsColumns, parseLargeCarRows,
  saveSettings, parseRows, saveScopedRules,
};
