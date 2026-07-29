// 지사별 정책(결제방식/운영시간/오더상태) 오버라이드 조회 헬퍼.
// 지사가 아직 설정하지 않은 항목은 기존(글로벌) 동작으로 자동 폴백한다.
const db = require('../db');
const { ORDER_STATUSES } = require('../config');
const { getGoldStellaFerryFareQuote } = require('./ferryFare');

function normalizeBranchId(branchId) {
  if (branchId == null) return null;
  const raw = String(branchId).trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

async function getEffectivePaymentMethods(branchId) {
  const normalizedBranchId = normalizeBranchId(branchId);
  if (!normalizedBranchId) {
    const all = await db.all('SELECT id, name FROM payment_methods WHERE is_active = 1 ORDER BY id');
    return all.map((pm) => ({ ...pm, is_default: 0 }));
  }
  const configured = await db.all(
    `SELECT pm.id, pm.name, bpm.is_default
     FROM branch_payment_methods bpm
     JOIN payment_methods pm ON pm.id = bpm.payment_method_id
     WHERE bpm.branch_id = ? AND pm.is_active = 1
     ORDER BY bpm.is_default DESC, pm.id`,
    [normalizedBranchId]
  );
  if (configured.length > 0) return configured;
  const all = await db.all('SELECT id, name FROM payment_methods WHERE is_active = 1 ORDER BY id');
  return all.map((pm) => ({ ...pm, is_default: 0 }));
}

async function getEffectiveStatuses(branchId) {
  const normalizedBranchId = normalizeBranchId(branchId);
  if (!normalizedBranchId) {
    return ORDER_STATUSES.map((s) => ({ status_code: s, is_customer_visible: 1, is_backoffice_only: 0 }));
  }
  const configured = await db.all(
    'SELECT status_code, is_customer_visible, is_backoffice_only FROM order_status_config WHERE branch_id = ? ORDER BY sort_order, id',
    [normalizedBranchId]
  );
  if (configured.length > 0) return configured;
  return ORDER_STATUSES.map((s) => ({ status_code: s, is_customer_visible: 1, is_backoffice_only: 0 }));
}

function dayType(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay(); // 0=Sun ... 6=Sat
  return day === 0 || day === 6 ? 'weekend' : 'weekday';
}

async function checkOperatingHours(branchId, dateStr, timeStr) {
  const normalizedBranchId = normalizeBranchId(branchId);
  if (!normalizedBranchId) return { allowed: true };

  const exception = await db.get(
    'SELECT * FROM operating_hour_exceptions WHERE branch_id = ? AND date = ?',
    [normalizedBranchId, dateStr]
  );
  if (exception) {
    if (exception.is_closed) return { allowed: false, reason: `${dateStr}는 임시 휴무일로 설정되어 있습니다.` };
    return checkRange(exception.open_time, exception.close_time, timeStr, '해당 일자 예외 운영시간');
  }

  const hours = await db.get(
    'SELECT * FROM operating_hours WHERE branch_id = ? AND day_type = ?',
    [normalizedBranchId, dayType(dateStr)]
  );
  if (!hours) return { allowed: true }; // 운영시간 미설정 지사는 기존처럼 제한 없음
  if (hours.is_closed) return { allowed: false, reason: '해당 요일은 휴무일로 설정되어 있습니다.' };
  return checkRange(hours.open_time, hours.close_time, timeStr, '운영시간');
}

function checkRange(openTime, closeTime, timeStr, label) {
  if (!openTime || !closeTime) return { allowed: true };

  const nowMinutes = parseTimeToMinutes(timeStr);
  const openMinutes = parseTimeToMinutes(openTime);
  const closeMinutes = parseTimeToMinutes(closeTime);

  // 레거시 데이터(예: "9:00")나 초 단위("18:00:00")도 안전하게 처리하기 위해
  // 문자열 비교 대신 분 단위 숫자 비교를 사용한다.
  if (nowMinutes == null || openMinutes == null || closeMinutes == null) {
    if (String(timeStr) < String(openTime) || String(timeStr) > String(closeTime)) {
      return { allowed: false, reason: `${label}(${openTime}~${closeTime}) 이외에는 오더를 등록할 수 없습니다.` };
    }
    return { allowed: true };
  }

  const isOvernightRange = closeMinutes < openMinutes;
  const inRange = isOvernightRange
    ? (nowMinutes >= openMinutes || nowMinutes <= closeMinutes)
    : (nowMinutes >= openMinutes && nowMinutes <= closeMinutes);

  if (!inRange) {
    return { allowed: false, reason: `${label}(${openTime}~${closeTime}) 이외에는 오더를 등록할 수 없습니다.` };
  }
  return { allowed: true };
}

function parseTimeToMinutes(value) {
  const text = String(value || '').trim();
  const m = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function applyRounding(amount, unit, method) {
  if (!unit) return Math.round(amount);
  const ratio = amount / unit;
  let rounded;
  if (method === 'up') rounded = Math.ceil(ratio);
  else if (method === 'down') rounded = Math.floor(ratio);
  else rounded = Math.round(ratio);
  return rounded * unit;
}

// 지사의 구간요금 설정(fare_rules)에 따라 거리(km) 기준 요금을 계산한다.
// 계산식: 기본요금 + max(0, 거리 - 기준거리) × (할증요금 ÷ 할증단위), 이후 최대요금 캡 + 반올림 적용.
// 요금표 미사용 지사는 { enabled: false } 를 반환하며, 이 경우 화면은 기존처럼 수동 입력을 유지한다.
async function calculateFare(branchId, distanceKm) {
  const normalizedBranchId = normalizeBranchId(branchId);
  if (!normalizedBranchId) return { enabled: false };
  const extra = await db.get('SELECT * FROM fare_extra_settings WHERE branch_id = ?', [normalizedBranchId]);
  if (!extra || !extra.fare_table_enabled) return { enabled: false };

  const tiers = await db.all('SELECT * FROM fare_rules WHERE branch_id = ? ORDER BY tier_seq', [normalizedBranchId]);
  if (tiers.length === 0) return { enabled: false };

  // tier_seq 순서가 반드시 기준거리 오름차순이라는 보장이 없으므로(구간을 등록한 순서일 뿐)
  // 구간 선택은 기준거리 기준으로 별도 정렬해서 판단한다.
  const sortedTiers = tiers.slice().sort((a, b) => Number(a.base_distance_km) - Number(b.base_distance_km));
  let tier = sortedTiers[0];
  for (const t of sortedTiers) {
    if (Number(t.base_distance_km) <= distanceKm) tier = t;
  }

  const extraDistance = Math.max(0, distanceKm - Number(tier.base_distance_km));
  let fare = Number(tier.base_fare) + extraDistance * (Number(tier.surcharge_fare) / Number(tier.surcharge_unit_km));
  if (tier.max_fare != null) fare = Math.min(fare, Number(tier.max_fare));
  fare = applyRounding(fare, Number(tier.round_unit) || 1000, tier.round_method);

  return {
    enabled: true,
    fare,
    tierSeq: tier.tier_seq,
    visibleToClient: !!extra.fare_visible_to_client,
    editableByClient: !!extra.fare_editable_by_client,
  };
}

async function findAnyFallbackFareBranch(preferredBranchId) {
  // preferredBranchId가 없으면(null) 제외 조건 자체가 필요 없다 — "? IS NULL OR ..." 형태로 매번
  // 값을 바인딩하면, null만 넘어올 때 Postgres가 해당 파라미터의 타입을 추론하지 못해
  // "could not determine data type of parameter $1" 에러가 난다. 조건절 자체를 안 넣어서 피한다.
  const normalizedPreferredBranchId = normalizeBranchId(preferredBranchId);
  const hasPreferred = normalizedPreferredBranchId != null;
  const withPreferredFilter = await db.get(
    `SELECT b.id, b.name
     FROM branches b
     JOIN fare_extra_settings fe ON fe.branch_id = b.id AND fe.fare_table_enabled = 1
     WHERE b.status = 'active'
       ${hasPreferred ? 'AND b.id <> ?' : ''}
       AND EXISTS (SELECT 1 FROM fare_rules fr WHERE fr.branch_id = b.id)
     ORDER BY b.id
     LIMIT 1`,
    hasPreferred ? [normalizedPreferredBranchId] : []
  );
  return withPreferredFilter || null;
}

async function findFallbackFareBranch(preferredBranchId) {
  try {
    const representative = await db.get(
      `SELECT b.id, b.name
       FROM branches b
       JOIN fare_extra_settings fe ON fe.branch_id = b.id
       WHERE b.status = 'active'
         AND fe.fare_table_enabled = 1
         AND fe.is_representative = 1
         AND EXISTS (SELECT 1 FROM fare_rules fr WHERE fr.branch_id = b.id)
       ORDER BY b.id
       LIMIT 1`
    );
    if (representative) return { branch: representative, representativeConfigMissing: false };

    const fallback = await findAnyFallbackFareBranch(preferredBranchId);
    return { branch: fallback, representativeConfigMissing: false };
  } catch (e) {
    // 구버전 DB(마이그레이션 미적용)에서는 is_representative 컬럼이 없어 42703 에러가 난다.
    if (e && e.code === '42703') {
      const fallback = await findAnyFallbackFareBranch(preferredBranchId);
      return { branch: fallback, representativeConfigMissing: true };
    }
    throw e;
  }
}

// 선택 지사의 요금표가 비활성/미등록이면, 활성 지사 중 기본 요금표를 찾아 계산한다.
async function calculateFareWithFallback(branchId, distanceKm) {
  const normalizedBranchId = normalizeBranchId(branchId);
  const primary = await calculateFare(normalizedBranchId, distanceKm);
  if (primary.enabled) {
    return {
      ...primary,
      fallbackUsed: false,
      sourceBranchId: normalizedBranchId,
      sourceBranchName: null,
      representativeConfigMissing: false,
    };
  }

  const fallbackInfo = await findFallbackFareBranch(normalizedBranchId);
  const fallbackBranch = fallbackInfo.branch;
  if (!fallbackBranch) {
    return {
      enabled: false,
      fallbackUsed: false,
      sourceBranchId: null,
      sourceBranchName: null,
      representativeConfigMissing: !!(fallbackInfo && fallbackInfo.representativeConfigMissing),
    };
  }

  const fallback = await calculateFare(fallbackBranch.id, distanceKm);
  if (!fallback.enabled) {
    return {
      enabled: false,
      fallbackUsed: false,
      sourceBranchId: null,
      sourceBranchName: null,
      representativeConfigMissing: !!(fallbackInfo && fallbackInfo.representativeConfigMissing),
    };
  }

  return {
    ...fallback,
    fallbackUsed: true,
    sourceBranchId: Number(fallbackBranch.id),
    sourceBranchName: fallbackBranch.name || null,
    representativeConfigMissing: !!(fallbackInfo && fallbackInfo.representativeConfigMissing),
  };
}

async function calculateFareWithFerry(branchId, distanceKm, options = {}) {
  const base = await calculateFareWithFallback(branchId, distanceKm);
  if (!base.enabled) return base;

  const ferry = await getGoldStellaFerryFareQuote(options);
  const ferryFare = ferry.ferryApplied && Number.isFinite(Number(ferry.ferryFare)) ? Number(ferry.ferryFare) : 0;
  const totalFare = Number(base.fare || 0) + ferryFare;

  return {
    ...base,
    fare: totalFare,
    totalFare,
    baseFare: Number(base.fare || 0),
    ferryFare: ferry.ferryApplied ? ferryFare : (ferry.ferryNeedVehicleType ? null : 0),
    ferryApplied: !!ferry.ferryApplied,
    ferryMatched: !!ferry.ferryMatched,
    ferryNeedVehicleType: !!ferry.ferryNeedVehicleType,
    ferryDayType: ferry.ferryDayType || null,
    ferryVehicleClass: ferry.ferryFareLabel || null,
    ferryMatchAlias: ferry.ferryMatchAlias || null,
    ferrySourceLabel: ferry.ferrySourceLabel || null,
    ferrySourceUrl: ferry.ferrySourceUrl || null,
    ferryNote: ferry.ferryNote || null,
    vehicleType: ferry.vehicleType || null,
  };
}

module.exports = {
  getEffectivePaymentMethods,
  getEffectiveStatuses,
  checkOperatingHours,
  calculateFare,
  calculateFareWithFallback,
  calculateFareWithFerry,
};
