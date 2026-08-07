// 콜마너 오더접수 — 원래 routes/orders.js 안에만 있던 함수를 모듈로 뺐다.
// 카카오 상담톡 접수 자동화(lib/kakaoIntakeService.js)가 같은 등록 경로를 그대로 타야
// 하기 때문이다. 등록 규칙이 두 벌로 갈라지면 콜마너 쪽 상태(대기 5 고정, conf_slip 중복
// 방지, 실패 시 에러코드 기록)가 경로마다 달라져 운영 중 원인 추적이 불가능해진다.
const db = require('../db');
const callmaner = require('./callmaner');

// callmaner_last_error_code 컬럼은 20260805000000 마이그레이션에서 추가된다 — 아직 적용하지
// 않은 DB에서도(구버전 DB 호환) 접수번호/에러 메시지 저장은 그대로 되어야 하므로, 코드 컬럼을
// 쓰는 쿼리가 실패하면 그 컬럼 없는 쿼리로 한 번 더 시도한다. 둘 다 실패하면 조용히 넘어간다 —
// 이 경로는 전부 fire-and-forget이라 오더 처리를 막으면 안 된다.
async function tryUpdateWithErrorCodeColumn(sqlWithCode, paramsWithCode, sqlWithoutCode, paramsWithoutCode) {
  try {
    await db.run(sqlWithCode, paramsWithCode);
  } catch (e) {
    await db.run(sqlWithoutCode, paramsWithoutCode).catch(() => {});
  }
}

// 콜마너 오더접수 — 오더 등록(생성) 시점에 호출하고, 상태를 접수/대기로 바꿀 때도 다시
// 호출한다. 오더 row를 DB에서 다시 읽어서 쓰므로 호출 시점(생성 직후든, 한참 뒤 상태변경이든)과
// 무관하게 항상 최신 값을 보낸다. 이미 conf_slip이 있으면(중복 등록 방지) 조용히 넘어가고 —
// 그래서 상태변경 때의 재호출은 실제로는 "생성 시점에 실패했으면 재시도"로만 동작한다(지사캐시
// 부족 등). lib/callmaner.js가 콜마너 쪽 접수상태를 항상 대기(5)로 고정하므로, 등록 즉시 배차
// 대상이 되지는 않는다.
async function registerOrderWithCallmaner(orderId, branchId) {
  try {
    const branchRow = await db.get('SELECT * FROM branches WHERE id = ?', [branchId]);
    if (!branchRow || !branchRow.callmaner_enabled) return;
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order || order.callmaner_conf_slip) return;
    const paymentMethodRow = order.payment_method_id
      ? await db.get('SELECT name FROM payment_methods WHERE id = ?', [order.payment_method_id])
      : null;
    // 경유지는 콜마너 viaList로 함께 보낸다(정의서 오더접수 via/viaList/via_count).
    const waypointRows = await db.all(
      'SELECT address, address_detail, lat, lon FROM order_waypoints WHERE order_id = ? ORDER BY seq',
      [orderId]
    ).catch(() => []);
    // 콜마너 userHp(요청단말번호)는 출발지 연락처를 우선 쓰고 없으면 요청자(오더를 등록한
    // 사용자) 연락처를 쓴다 — lib/callmaner.js의 normalizeUserHp가 이 순서로 고른다.
    const requesterRow = order.created_by
      ? await db.get('SELECT phone FROM users WHERE id = ?', [order.created_by]).catch(() => null)
      : null;
    const orderForCallmaner = {
      origin_contact: order.origin_contact,
      requester_phone: requesterRow && requesterRow.phone,
      origin_lat: order.origin_lat, origin_lon: order.origin_lon,
      origin_sido: order.origin_sido, origin_sigugun: order.origin_sigugun, origin_dong: order.origin_dong,
      origin_address: order.origin_address, origin_address_detail: order.origin_address_detail,
      destination_lat: order.destination_lat, destination_lon: order.destination_lon,
      destination_sido: order.destination_sido, destination_sigugun: order.destination_sigugun, destination_dong: order.destination_dong,
      destination_address: order.destination_address, destination_address_detail: order.destination_address_detail,
      fare_amount: order.fare_amount || 0,
      memo_customer: order.memo_customer || '',
      order_type: order.order_type,
      reserved_date: order.reserved_date, reserved_time: order.reserved_time,
    };
    const result = await callmaner.orderReceipt(orderForCallmaner, branchRow, paymentMethodRow && paymentMethodRow.name, waypointRows);
    await tryUpdateWithErrorCodeColumn(
      `UPDATE orders SET callmaner_conf_slip = ?, callmaner_status = '접수', callmaner_status_code = '01',
       callmaner_synced_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
       callmaner_last_error = NULL, callmaner_last_error_code = NULL WHERE id = ?`,
      [result.confSlip || null, orderId],
      `UPDATE orders SET callmaner_conf_slip = ?, callmaner_status = '접수', callmaner_status_code = '01',
       callmaner_synced_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
       callmaner_last_error = NULL WHERE id = ?`,
      [result.confSlip || null, orderId]
    );
  } catch (e) {
    console.error('콜마너 오더접수 실패:', e.message, e.rc ? `(rc=${e.rc})` : '');
    // 콜마너가 응답한 에러코드(rc)는 별도 컬럼에 담아, 화면에서 코드만 따로 보여줄 수 있게 한다.
    // 좌표 누락 같은 우리 쪽 사전검증 실패는 요청이 나가지 않아 rc가 없다(NULL로 남는다).
    const msg = String(e.message || '').slice(0, 500);
    await tryUpdateWithErrorCodeColumn(
      'UPDATE orders SET callmaner_last_error = ?, callmaner_last_error_code = ? WHERE id = ?',
      [msg, e.rc ? String(e.rc).slice(0, 40) : null, orderId],
      'UPDATE orders SET callmaner_last_error = ? WHERE id = ?',
      [msg, orderId]
    );
  }
}

module.exports = { registerOrderWithCallmaner, tryUpdateWithErrorCodeColumn };
