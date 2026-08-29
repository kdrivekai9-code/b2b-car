// 대기요금 · 취소요금 — 오더구분(탁송 / 프리미엄대리 / 일일기사)마다 따로 정한다.
//
// group_fare_extra_settings에 wait_fee / cancel_before_fee / cancel_after_fee가 예전부터
// 있었는데 어디서도 읽지 않았다. 설정한 사람은 청구되는 줄 알지만 한 푼도 안 나갔다.
// 그것을 채운 뒤 두 번째 문제가 드러났다: **한 벌을 모든 오더구분에 똑같이 적용**했다.
// 탁송은 거리 기반, 프리미엄/일일기사는 시간 기반이라 요금 구조가 아예 다르다 — 탁송 기준으로
// 정한 대기·취소요금이 시간제 오더에 그대로 붙으면 받지 말아야 할 돈을 받는다(사용자 지적).
//
// 이 금액은 fare_amount에 합치지 않는다. 정산서에서 구간요금·할증과 나란히 보여야 하고
// (사용자 지시), 합쳐두면 어느 것이 얼마인지 되짚을 수 없다.

// 오더구분별로 어느 설정 칸을 읽을지. 여기 없는 오더구분은 탁송 칸을 쓴다(기존 동작).
//
// 비어 있으면(NULL) 0원 — 즉 안 받는다. 0으로 미리 채우지 않은 이유는 마이그레이션 주석 참조:
// 지금 중요한 건 "탁송 값이 시간제 오더로 새어 들어오지 않는 것"이고 NULL로 충분하다.
const FEE_KEYS = {
  dispatch: {
    wait: 'wait_fee', threshold: 'wait_threshold_min',
    before: 'cancel_before_fee', after: 'cancel_after_fee',
    // 탁송은 기사 배정 여부로 가른다 — 배정되면 기사가 이미 그 오더에 묶인다.
    afterStatuses: new Set(['기사배정', '운행시작', '완료']),
    beforeNote: '배차 전 취소', afterNote: '배차 후 취소',
  },
  premium: {
    wait: 'premium_wait_fee', threshold: 'premium_wait_threshold_min',
    before: 'premium_cancel_before_fee', after: 'premium_cancel_after_fee',
    // 프리미엄/일일기사는 기사가 고객에게 **도착**했는지가 손실을 가른다(사용자 지시:
    // "도착전 취소요금과 도착후 취소요금"). 도착의 대용은 '운행시작'이다 — 기사가 도착해
    // 운행을 시작한 상태이고, 우리가 확실히 아는 사실 중 도착에 가장 가깝다.
    afterStatuses: new Set(['운행시작', '완료']),
    beforeNote: '도착 전 취소', afterNote: '도착 후 취소',
  },
  daily_driver: {
    wait: 'daily_wait_fee', threshold: 'daily_wait_threshold_min',
    before: 'daily_cancel_before_fee', after: 'daily_cancel_after_fee',
    afterStatuses: new Set(['운행시작', '완료']),
    beforeNote: '도착 전 취소', afterNote: '도착 후 취소',
  },
};

function keysFor(orderType) {
  return FEE_KEYS[String(orderType || '').trim()] || FEE_KEYS.dispatch;
}

function num(extra, key) {
  return Math.round(Number(extra && extra[key]) || 0);
}

// 대기요금: 대기시간이 기준을 넘으면 정액 1회.
//
// "분당 얼마"가 아니라 정액인 이유: 설정이 금액 한 칸뿐이다. 분당으로 읽으면 30분 대기에
// 두 배가 되는데, 그렇게 하려면 설정에 단위가 있어야 한다. 없는 단위를 지어내지 않는다.
// 화면에도 "기준 초과 시 1회"라고 밝힌다.
function waitFee(extra, waitMinutes, orderType) {
  const k = keysFor(orderType);
  const fee = num(extra, k.wait);
  const threshold = num(extra, k.threshold);
  const minutes = Math.round(Number(waitMinutes) || 0);
  if (fee <= 0 || minutes <= 0) return { amount: 0, note: null };
  // 기준이 0이면 "대기하면 무조건 받는다"는 뜻이 된다 — 그건 설정 실수일 가능성이 높아
  // 기준을 넘긴 것으로 보지 않는다(안 받는 쪽으로 기운다).
  if (threshold <= 0 || minutes <= threshold) return { amount: 0, note: null };
  return { amount: fee, note: `대기 ${minutes}분 (기준 ${threshold}분 초과)` };
}

// 오더구분마다 기준이 다르다(탁송=배차, 프리미엄/일일기사=도착) — 위 FEE_KEYS 참조.
function cancelFee(extra, options = {}) {
  const k = keysFor(options.orderType);
  const before = num(extra, k.before);
  const after = num(extra, k.after);
  // hadDriver는 탁송에서만 "배차됨"의 근거가 된다. 프리미엄/일일기사는 기사가 배정돼도
  // 아직 도착 전일 수 있어, 배정만으로 도착 후 요금을 받으면 과청구다.
  const passed = (k === FEE_KEYS.dispatch && !!options.hadDriver)
    || k.afterStatuses.has(String(options.previousStatus || ''));
  const amount = passed ? after : before;
  if (amount <= 0) return { amount: 0, note: null };
  return { amount, note: passed ? k.afterNote : k.beforeNote };
}

// 취소요금을 실제로 붙인다 — 상태가 '취소'로 바뀌는 **모든** 지점에서 이 함수를 부른다.
//
// 왜 함수로 빼나: 예전에는 관리자 화면의 상태변경 라우트에만 계산이 있었다. 그런데 콜마너
// 동기화(routes/callmanerSync.js)도 상태를 직접 '취소'로 바꾼다 — 기사 배정 뒤 콜마너에서
// 취소되는 흔한 경로인데, 그쪽으로 취소되면 취소요금이 한 푼도 안 붙었다(청구 누락).
// 경로마다 계산을 두면 새 경로가 생길 때 또 빠진다.
//
// 이미 값이 있으면 덮어쓰지 않는다 — 취소를 되돌렸다 다시 취소해도 두 번 붙으면 안 되고,
// 관리자가 부대비용에서 손으로 넣은 금액을 자동 계산이 덮어써도 안 된다.
async function applyCancelFee(db, order, previousStatus) {
  if (!order || order.cancel_fee_amount != null) return null;
  try {
    const branchPolicy = require('./branchPolicy');
    const extra = await branchPolicy.findFareExtra(order.requester_group_id, order.branch_id);
    const fee = cancelFee(extra, { previousStatus, orderType: order.order_type });
    if (fee.amount <= 0) return null;
    await db.run('UPDATE orders SET cancel_fee_amount = ?, cancel_fee_note = ? WHERE id = ?',
      [fee.amount, fee.note, order.id]);
    return fee;
  } catch (e) {
    // 취소 자체는 막지 않는다 — 요금을 못 붙였을 뿐이다. 다만 조용히 넘기지 않는다:
    // 이건 청구 누락이라 나중에 되짚을 수 있어야 한다.
    if (e && e.code === '42703') return null; // 마이그레이션 20260829040000 전
    console.error('취소요금 계산 실패(취소는 진행 · 청구 누락 가능):', e.message);
    return null;
  }
}

// 화면(요금설정)이 쓰는 칸 목록. 화면에 필드명을 또 적으면 컬럼이 늘 때 한쪽만 바뀐다.
const ORDER_TYPE_FEE_GROUPS = [
  { orderType: 'premium', label: '프리미엄대리', keys: FEE_KEYS.premium },
  { orderType: 'daily_driver', label: '일일기사', keys: FEE_KEYS.daily_driver },
];

// 오더구분별 요금 칸 이름 전부. 저장·복사가 컬럼 목록을 손으로 적지 않게 한다.
function orderTypeFeeColumns() {
  const cols = [];
  ORDER_TYPE_FEE_GROUPS.forEach((g) => {
    ['threshold', 'wait', 'before', 'after'].forEach((k) => cols.push(g.keys[k]));
  });
  return cols;
}

// 요금설정 화면에서 올라온 값을 저장한다. source에는 폼 body를 넘기지만, 컬럼 이름이
// 그대로라 다른 설정 행을 넘기면 복사가 된다(지사 표 → 법인 표).
//
// 본 INSERT 문에 컬럼을 8개씩 끼워 넣지 않고 따로 UPDATE 하는 이유: 저장 지점이 셋이고
// (법인 저장, 지사 저장, 지사→지사 복사) 그때마다 컬럼 목록·바인딩 순서를 손으로 맞추면
// 하나만 어긋나도 엉뚱한 칸에 값이 들어간다 — 요금이라 그게 곧 오청구다.
//
// 빈 칸은 NULL로 둔다. 0으로 저장하면 "안 정함"과 "0원(안 받음)"이 구별되지 않는데,
// 화면이 빈 칸을 "받지 않음"으로 안내하고 있으므로 NULL이 곧 0원으로 읽힌다(num()이 0을 준다).
async function saveOrderTypeFees(db, table, keyCol, keyVal, source) {
  const cols = orderTypeFeeColumns();
  const sets = cols.map((c) => `${c} = ?`);
  const args = cols.map((c) => {
    const raw = source ? source[c] : undefined;
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    return Math.max(0, Math.round(Number(raw) || 0));
  });
  args.push(keyVal);
  await db.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${keyCol} = ?`, args);
}

module.exports = {
  waitFee, cancelFee, applyCancelFee, keysFor,
  orderTypeFeeColumns, saveOrderTypeFees,
  FEE_KEYS, ORDER_TYPE_FEE_GROUPS,
  // 예전 이름 — 탁송 기준 배차 상태. 다른 곳에서 쓰고 있어 남겨둔다.
  ASSIGNED_STATUSES: FEE_KEYS.dispatch.afterStatuses,
};
