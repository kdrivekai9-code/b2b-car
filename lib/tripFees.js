// 대기요금 · 취소요금 — 설정만 있고 계산·저장이 없던 것을 채운다.
//
// group_fare_extra_settings에 wait_fee / cancel_before_fee / cancel_after_fee가 예전부터
// 있었는데 어디서도 읽지 않았다. 설정한 사람은 청구되는 줄 알지만 한 푼도 안 나갔다.
//
// 이 금액은 fare_amount에 합치지 않는다. 정산서에서 구간요금·할증과 나란히 보여야 하고
// (사용자 지시), 합쳐두면 어느 것이 얼마인지 되짚을 수 없다.

// 대기요금: 도착지 대기시간이 기준을 넘으면 정액 1회.
//
// "분당 얼마"가 아니라 정액인 이유: 설정이 wait_fee 하나뿐이다. 분당으로 읽으면 30분 대기에
// 두 배가 되는데, 그렇게 하려면 설정에 단위가 있어야 한다. 없는 단위를 지어내지 않는다.
// 화면에도 "기준 초과 시 1회"라고 밝힌다.
function waitFee(extra, waitMinutes) {
  const fee = Math.round(Number(extra && extra.wait_fee) || 0);
  const threshold = Math.round(Number(extra && extra.wait_threshold_min) || 0);
  const minutes = Math.round(Number(waitMinutes) || 0);
  if (fee <= 0 || minutes <= 0) return { amount: 0, note: null };
  // 기준이 0이면 "대기하면 무조건 받는다"는 뜻이 된다 — 그건 설정 실수일 가능성이 높아
  // 기준을 넘긴 것으로 보지 않는다(안 받는 쪽으로 기운다).
  if (threshold <= 0 || minutes <= threshold) return { amount: 0, note: null };
  return { amount: fee, note: `대기 ${minutes}분 (기준 ${threshold}분 초과)` };
}

// 취소요금: 기사 배정 뒤에 취소하면 더 받는다.
//
// 배정 여부로 가른다 — 기사가 이미 움직였는지가 실제 손실을 가른다. 시각(예약 몇 시간 전)이
// 아니라 배정 상태를 보는 이유는 그것이 우리가 확실히 아는 사실이기 때문이다.
const ASSIGNED_STATUSES = new Set(['기사배정', '운행시작', '완료']);

function cancelFee(extra, options = {}) {
  const before = Math.round(Number(extra && extra.cancel_before_fee) || 0);
  const after = Math.round(Number(extra && extra.cancel_after_fee) || 0);
  const assigned = !!options.hadDriver || ASSIGNED_STATUSES.has(String(options.previousStatus || ''));
  const amount = assigned ? after : before;
  if (amount <= 0) return { amount: 0, note: null };
  return { amount, note: assigned ? '배차 후 취소' : '배차 전 취소' };
}

module.exports = { waitFee, cancelFee, ASSIGNED_STATUSES };
