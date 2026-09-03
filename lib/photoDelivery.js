// 사진 전송리스트 — 고객이 자기 오더의 탁송사진과 실비 영수증을 모아 보고 내려받는 화면의 데이터.
//
// 왜 별도 화면인가: 사진은 지금까지 두 경로로만 닿았다. 카카오 링크(/photos/:token)는 한 건씩
// 보내는 것이고, 오더상세의 사진 카드는 관리자 화면이다. 고객이 "지난달 넘긴 차 사진 좀"이라고
// 물으면 상담원이 오더를 찾아 링크를 다시 만들어 보내야 했다. 목록으로 두면 고객이 직접 찾는다.
//
// 이 모듈은 조회만 한다. 권한(어느 오더를 볼 수 있나)은 호출부가 정한 scope를 그대로 받는다 —
// 여기서 다시 판단하면 목록과 상세의 기준이 갈릴 수 있다(개인 딜러는 본인 접수분만).
const db = require('../db');
const callmanerPhotos = require('./callmanerPhotos');
const extraCharges = require('./extraCharges');
const tripFees = require('./tripFees');

// 사진 열람은 지사 설정을 따른다(branch_photo_settings.client_can_view). 화면·챗봇·토큰 링크가
// 모두 이 설정을 보고 있어 여기서도 같은 것을 본다 — 관리 화면에서 막아둔 것이 새 메뉴 하나로
// 뚫리면 그 설정이 의미가 없다.
//
// **행이 없으면 볼 수 없다.** 기본값을 "허용"으로 두면, 설정을 한 번도 만지지 않은 지사의
// 사진이 조용히 고객에게 열린다(/photos/:token이 이미 같은 규칙이다).
async function clientCanViewBranches() {
  const rows = await db.all('SELECT branch_id FROM branch_photo_settings WHERE client_can_view = 1')
    .catch(() => []);
  return new Set(rows.map((r) => Number(r.branch_id)));
}

// 목록에 올릴 오더. "사진 전송"리스트라 사진이 한 장이라도 있는 건만 올린다 —
// 사진이 없는 오더까지 늘어놓으면 정작 볼 것이 있는 건을 찾기 어렵다.
//
// scope: { groupId, createdBy } — createdBy가 있으면 그 사람이 접수한 건만(개인 딜러).
async function listForClient(scope, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 300);
  const params = [scope.groupId];
  let onlyMine = '';
  if (scope.createdBy) { onlyMine = 'AND o.created_by = ?'; params.push(scope.createdBy); }
  params.push(limit);

  const rows = await db.all(
    `SELECT o.id, o.oid, o.reserved_date, o.reserved_time, o.vehicle_number, o.vehicle_type,
            o.status, o.branch_id, o.fare_amount, o.wait_fee_amount, o.cancel_fee_amount,
            (SELECT COUNT(*) FROM order_callmaner_photos p WHERE p.order_id = o.id) AS photo_count
       FROM orders o
      WHERE o.requester_group_id = ?
        ${onlyMine}
        AND EXISTS (SELECT 1 FROM order_callmaner_photos p WHERE p.order_id = o.id)
      ORDER BY o.reserved_date DESC, o.reserved_time DESC, o.id DESC
      LIMIT ?`,
    params
  );
  if (!rows.length) return [];

  const viewable = await clientCanViewBranches();
  // 부대비용 합계는 오더마다 따로 조회하지 않고 한 번에 모은다 — 목록이 100건이면 쿼리도
  // 100번이 된다(N+1). 청구 대상(billable)만 더한다: '포함'으로 둔 항목은 이미 기본요금에
  // 들어 있어 또 더하면 고객 화면에서 두 번 청구된 것처럼 보인다.
  const ids = rows.map((r) => r.id);
  const extras = await db.all(
    `SELECT order_id, COALESCE(SUM(amount), 0)::int AS amount, COUNT(*)::int AS cnt
       FROM order_extra_charges
      WHERE order_id = ANY(?::int[]) AND billable = true
      GROUP BY order_id`,
    [ids]
  ).catch(() => []);
  const extraByOrder = new Map(extras.map((r) => [String(r.order_id), r]));

  return rows.map((r) => {
    const extra = extraByOrder.get(String(r.id)) || { amount: 0, cnt: 0 };
    return {
      id: r.id,
      oid: r.oid,
      reservedDate: r.reserved_date,
      reservedTime: r.reserved_time,
      vehicleNumber: r.vehicle_number,
      vehicleType: r.vehicle_type,
      status: r.status,
      photoCount: Number(r.photo_count) || 0,
      // 열람이 막힌 지사는 목록에는 두고 사진보기만 잠근다. 아예 숨기면 고객은 "사진을 안
      // 찍었나"로 읽고 상담원에게 묻는다 — 막혀 있다는 사실이 보이는 편이 낫다.
      canViewPhotos: viewable.has(Number(r.branch_id)),
      tripFare: tripFees.billableTripFare(r),
      extraAmount: Number(extra.amount) || 0,
      extraCount: Number(extra.cnt) || 0,
    };
  });
}

// 상세(사진보기) — 운행 전 / 운행 완료 후로 나누고, 각 사진에 항목 이름을 붙인다.
//
// 항목 이름은 callmanerPhotos.photoLabel이 정한다. 이름을 여기서 새로 지어붙이지 않는 이유는
// 그 파일 주석에 있다: 확인되지 않은 자리에 그럴듯한 이름을 넣으면 "운전석 휠"이라고 적힌
// 자리에 뒷범퍼가 뜨고, 사고 처리에서 그 이름을 근거로 다투게 된다.
async function detailForClient(orderId, scope) {
  const params = [orderId, scope.groupId];
  let onlyMine = '';
  if (scope.createdBy) { onlyMine = 'AND created_by = ?'; params.push(scope.createdBy); }

  const order = await db.get(
    `SELECT * FROM orders WHERE id = ? AND requester_group_id = ? ${onlyMine}`,
    params
  );
  if (!order) return { order: null, reason: 'not_found' };

  const viewable = await clientCanViewBranches();
  if (!viewable.has(Number(order.branch_id))) return { order, reason: 'not_allowed' };

  const [photos, branch, charges] = await Promise.all([
    callmanerPhotos.loadPhotos(order.id),
    db.get('SELECT * FROM branches WHERE id = ?', [order.branch_id]).catch(() => null),
    extraCharges.loadWithReceipts(order.id).catch(() => []),
  ]);

  const phases = [
    { phase: callmanerPhotos.PHASE_START, label: '운행 전' },
    { phase: callmanerPhotos.PHASE_END, label: '운행 완료 후' },
  ].map((g) => ({
    ...g,
    items: photos
      .filter((p) => p.phase === g.phase)
      .sort((a, b) => Number(a.seq) - Number(b.seq))
      .map((p) => ({ ...p, label: callmanerPhotos.photoLabel(p.seq) })),
  }));

  return {
    order,
    reason: photos.length ? null : 'no_photos',
    phases: phases.filter((g) => g.items.length),
    // 계기판이 몇 번째인지는 지사 설정을 따른다 — 그 자리에만 주행거리를 함께 보여준다.
    odometerIndex: callmanerPhotos.odometerPhotoIndex(branch),
    // 실비정산 영수증 — 부대비용 줄과 그 근거 사진. 사진이 아직 없는 줄도 남긴다(빠진 것이
    // 보여야 "영수증을 안 올렸다"를 알 수 있다).
    receipts: charges.filter((c) => c.billable !== false),
    tripFare: tripFees.billableTripFare(order),
  };
}

// 다운로드에 담을 파일 목록 — 실제 내려받기(fetch)는 라우트가 한다.
// 이름은 압축을 푼 뒤에도 무엇인지 알 수 있어야 한다. 오더번호를 폴더로 두고
// 운행전/운행후/실비영수증으로 나눈다.
function downloadPlan(detail) {
  const plan = [];
  (detail.phases || []).forEach((g) => {
    g.items.forEach((p) => {
      plan.push({ dir: g.label.replace(/\s/g, ''), name: `${p.label}${extOf(p.url)}`, url: p.url });
    });
  });
  (detail.receipts || []).forEach((c) => {
    const files = (c.receipt && c.receipt.files) || [];
    files.forEach((f, i) => {
      const url = typeof f === 'string' ? f : (f && f.url);
      if (!url) return;
      const suffix = files.length > 1 ? `-${i + 1}` : '';
      plan.push({ dir: '실비영수증', name: `${c.charge_type}${suffix}${extOf(url)}`, url });
    });
  });
  return plan;
}

// 확장자는 URL에서 딴다. 못 알아보면 .jpg로 둔다 — 콜마너·업로드 모두 이미지라 확장자가
// 틀려도 열리지만, 없으면 윈도에서 연결 프로그램을 못 찾는다.
function extOf(url) {
  const m = String(url || '').split('?')[0].match(/\.(jpe?g|png|webp|heic|heif|gif)$/i);
  return m ? `.${m[1].toLowerCase()}` : '.jpg';
}

module.exports = { listForClient, detailForClient, downloadPlan, clientCanViewBranches, extOf };
