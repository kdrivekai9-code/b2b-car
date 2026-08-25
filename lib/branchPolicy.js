// 지사별 정책(결제방식/운영시간/오더상태) 오버라이드 조회 헬퍼.
// 지사가 아직 설정하지 않은 항목은 기존(글로벌) 동작으로 자동 폴백한다.
const db = require('../db');
const { ORDER_STATUSES } = require('../config');
const { getFerryFareQuote, estimateFerryArrival } = require('./ferryFare');
const { kstNow } = require('./period');

// 상담원 상태로 붙잡힌 세션을 봇 응대로 되돌리기까지의 기본 유휴 시간(분).
// 지사가 branches.agent_idle_release_minutes로 따로 정하면 그 값이 우선하고, 0이면 그 지사는
// 자동 복귀를 하지 않는다.
//
// 10분인 근거(상담 로그 2,353건 실측 — 고객 발화 → 상담원 첫 응답 지연):
//   중앙값 1분 / p75 3분 / p90 8분 / p95 16분
//   10분 안에 92.2%가 응답 완료 → 10분을 넘긴 7.8%는 실제로 방치된 대화로 본다.
// 예전 값은 30분이었는데, 그 시점엔 이미 97.5%가 답한 뒤라 사실상 발동하지 않는 값이었다.
//
// 더 낮추지 않는 이유: 5분으로 두면 아직 사람이 올 대화가 15.7%나 되어 봇과 상담원이 번갈아
// 답할 여지가 커진다. 카카오는 발송 취소가 안 되므로 그 겹침은 되돌릴 수 없다.
//
// 이 상수를 routes/chat.js(판정)와 routes/branches.js(설정 화면)가 함께 쓴다 — 예전에는 두
// 파일이 각자 30을 하드코딩해서, 한쪽만 바꾸면 화면에 안내되는 기본값과 실제 동작이 갈렸다.
const DEFAULT_AGENT_IDLE_RELEASE_MINUTES = 10;

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

// 구간요금 설정에 따라 거리(km) 기준 요금을 계산한다.
// 계산식: 기본요금 + max(0, 거리 - 기준거리) × (할증요금 ÷ 할증단위), 이후 최대요금 캡 + 반올림 적용.
// 요금표를 쓰지 않으면 { enabled: false } 를 반환하며, 이 경우 화면은 기존처럼 수동 입력을 유지한다.
//
// 표를 고르는 순서(정책): 법인 표 → 지사 표. 법인(groupId)에 표가 있고 "이 요금표 사용"이
// 켜져 있으면 그것을 쓰고, 없으면 지사 표로 내려간다. 법인 표가 생기기 전에 만들어 둔 지사
// 설정이 그대로 살아 있어야 하고, 법인마다 같은 내용을 다시 넣게 할 이유도 없다.
async function loadFareTable(groupId, branchId) {
  const normalizedGroupId = normalizeBranchId(groupId);
  if (normalizedGroupId) {
    const [groupExtra, groupTiers] = await Promise.all([
      db.get('SELECT * FROM group_fare_extra_settings WHERE group_id = ?', [normalizedGroupId]).catch(() => null),
      db.all('SELECT * FROM group_fare_rules WHERE group_id = ? ORDER BY tier_seq', [normalizedGroupId]).catch(() => []),
    ]);
    if (groupExtra && groupExtra.fare_table_enabled && groupTiers.length) {
      return { extra: groupExtra, tiers: groupTiers, source: 'group' };
    }
  }
  const normalizedBranchId = normalizeBranchId(branchId);
  if (!normalizedBranchId) return null;
  const extra = await db.get('SELECT * FROM fare_extra_settings WHERE branch_id = ?', [normalizedBranchId]);
  if (!extra || !extra.fare_table_enabled) return null;
  const tiers = await db.all('SELECT * FROM fare_rules WHERE branch_id = ? ORDER BY tier_seq', [normalizedBranchId]);
  if (!tiers.length) return null;
  return { extra, tiers, source: 'branch' };
}

// 거리구간표에서 금액을 뽑는 규칙. 계약 요금(fare_rules)과 배차 요금
// (branch_dispatch_fare_rules)이 같은 구조라 계산도 한 벌만 둔다 — 두 벌이면 한쪽만 고쳐
// 금액이 갈린다.
function fareFromTiers(tiers, distanceKm) {
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
  return { fare: applyRounding(fare, Number(tier.round_unit) || 1000, tier.round_method), tier };
}

// 배차 요금 — 고객 청구액(calculateFare)과 별개다. 콜마너에 거는 금액이라 기사를 붙이는 데
// 드는 값이고, 거래처와 무관해서 지사별로만 둔다.
// 요금표를 등록하지 않은 지사는 { enabled:false } — 없는 값을 지어내지 않는다.
async function calculateDispatchFare(branchId, distanceKm) {
  const normalizedBranchId = normalizeBranchId(branchId);
  if (!normalizedBranchId) return { enabled: false };
  const tiers = await db.all(
    'SELECT * FROM branch_dispatch_fare_rules WHERE branch_id = ? ORDER BY tier_seq',
    [normalizedBranchId]
  ).catch((e) => {
    // 마이그레이션 전이면 표가 없다 — 배차 요금만 비고 접수는 그대로 진행돼야 한다.
    console.error('배차 요금표 조회 실패(배차 요금 없이 진행):', e.message);
    return [];
  });
  if (!tiers.length) return { enabled: false };
  const { fare, tier } = fareFromTiers(tiers, distanceKm);
  return { enabled: true, fare, tierSeq: tier.tier_seq };
}

async function calculateFare(branchId, distanceKm, options = {}) {
  const table = await loadFareTable(options.groupId, branchId);
  if (!table) return { enabled: false };
  const { extra, tiers } = table;

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
    // 어느 표로 계산했는지 — 화면·검사에서 "법인 표가 실제로 적용됐는가"를 확인할 수 있게 한다.
    fareSource: table.source,
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
async function calculateFareWithFallback(branchId, distanceKm, options = {}) {
  const normalizedBranchId = normalizeBranchId(branchId);
  const primary = await calculateFare(normalizedBranchId, distanceKm, options);
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
  const ferry = await getFerryFareQuote(options);

  // 도선 구간이 있으면(출발지→항구, 항구→도착지) 거리요금을 구간별로 각각 계산해서 합산한다 —
  // 두 구간이 사실상 서로 다른 지역 배차라 기본요금(출동비)이 두 번 청구되는 게 맞다는 확인을 받았다.
  const beforeKm = Number(options.beforeKm);
  const afterKm = Number(options.afterKm);
  const hasSplitLegs = !!ferry.enabled && Number.isFinite(beforeKm) && Number.isFinite(afterKm);

  let base;
  if (hasSplitLegs) {
    const [beforeFare, afterFare] = await Promise.all([
      calculateFareWithFallback(branchId, beforeKm, { groupId: options.groupId }),
      calculateFareWithFallback(branchId, afterKm, { groupId: options.groupId }),
    ]);
    if (!beforeFare.enabled || !afterFare.enabled) {
      base = { enabled: false, fallbackUsed: false, sourceBranchId: null, sourceBranchName: null, representativeConfigMissing: false };
    } else {
      base = {
        ...beforeFare,
        fare: Number(beforeFare.fare || 0) + Number(afterFare.fare || 0),
        fareBeforeFerry: Number(beforeFare.fare || 0),
        fareAfterFerry: Number(afterFare.fare || 0),
        fallbackUsed: !!(beforeFare.fallbackUsed || afterFare.fallbackUsed),
      };
    }
  } else {
    base = await calculateFareWithFallback(branchId, distanceKm, { groupId: options.groupId });
  }
  if (!base.enabled) return base;

  const ferryFare = ferry.ferryApplied && Number.isFinite(Number(ferry.ferryFare)) ? Number(ferry.ferryFare) : 0;
  const totalFare = Number(base.fare || 0) + ferryFare;

  let ferryEstimate = null;
  if (ferry.ferryApplied && ferry.ferryRouteCode
    && Number.isFinite(Number(options.beforeMinutes)) && Number.isFinite(Number(options.afterMinutes))) {
    // 예약일시가 아직 확정되지 않은 순수 요금문의(챗봇 "지금 출발하면 얼마?" 케이스)는 지금
    // 이 순간 출발한다고 가정하고 다음 배편을 조회한다 — 예약이 있으면 그 시각을 그대로 쓴다.
    let reservedDate = options.reservedDate;
    let reservedTime = options.reservedTime;
    if (!reservedDate || !reservedTime) {
      const now = kstNow();
      reservedDate = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
      reservedTime = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
    }
    try {
      ferryEstimate = await estimateFerryArrival({
        routeCode: ferry.ferryRouteCode,
        reservedDate,
        reservedTime,
        beforeMinutes: options.beforeMinutes,
        afterMinutes: options.afterMinutes,
      });
    } catch (e) {
      ferryEstimate = null;
    }
  }

  return {
    ...base,
    fare: totalFare,
    totalFare,
    baseFare: Number(base.fare || 0),
    fareBeforeFerry: base.fareBeforeFerry != null ? base.fareBeforeFerry : null,
    fareAfterFerry: base.fareAfterFerry != null ? base.fareAfterFerry : null,
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
    ferryEstimate,
    vehicleType: ferry.vehicleType || null,
  };
}

// 프리미엄/일일기사 오더의 시간 구간 기반 요금 계산.
// calculateFare(거리 기반)와 동일한 패턴 — 구간표에서 hours 이상인 마지막 tier를 선택한다.
async function calculatePremiumFare(branchId, hours, options = {}) {
  // 표를 고르는 순서는 탁송과 같다: 법인 → 지사(loadFareTable 주석 참조).
  const normalizedGroupId = normalizeBranchId(options.groupId);
  let tiers = [];
  let source = 'branch';
  if (normalizedGroupId) {
    tiers = await db.all(
      'SELECT * FROM group_daily_driver_fare_rules WHERE group_id = ? ORDER BY tier_seq',
      [normalizedGroupId]
    ).catch(() => []);
    if (tiers.length) source = 'group';
  }
  if (!tiers.length) {
    const normalizedBranchId = normalizeBranchId(branchId);
    if (!normalizedBranchId) return { enabled: false };
    tiers = await db.all(
      'SELECT * FROM premium_fare_rules WHERE branch_id = ? ORDER BY tier_seq',
      [normalizedBranchId]
    );
  }
  if (tiers.length === 0) return { enabled: false };

  const sortedTiers = tiers.slice().sort((a, b) => Number(a.base_hours) - Number(b.base_hours));
  let tier = sortedTiers[0];
  for (const t of sortedTiers) {
    if (Number(t.base_hours) <= hours) tier = t;
  }

  const extraHours = Math.max(0, hours - Number(tier.base_hours));
  let fare = Number(tier.fare_amount) + extraHours * Number(tier.extra_per_hour || 0);
  fare = applyRounding(fare, 1000, 'round');

  return {
    enabled: true,
    fare,
    tierSeq: tier.tier_seq,
    fareSource: source,
  };
}

module.exports = {
  DEFAULT_AGENT_IDLE_RELEASE_MINUTES,
  getEffectivePaymentMethods,
  getEffectiveStatuses,
  checkOperatingHours,
  calculateFare,
  calculateFareWithFallback,
  calculateFareWithFerry,
  calculatePremiumFare,
  calculateDispatchFare,
};
