// 오더 생성 — 세 경로(웹 오더등록 / 문의 전환 / 카카오 자동접수)가 공유하는 단 하나의 구현.
//
// 왜 모았나: 같은 INSERT가 네 벌로 흩어져 있었다(routes/orders.js 2벌·routes/inquiries.js·
// lib/kakaoIntakeService.js). 컬럼이 하나 추가되면 네 곳을 다 고쳐야 하고, 하나를 빠뜨리면
// 그 경로로 들어온 오더만 조용히 값이 비어 나중에 원인을 찾기 어렵다.
//
// 여기서 하는 일은 "오더 한 건을 DB에 앉히는 것"까지다 — 폼 검증, 운영시간 확인, 요금 계산,
// 콜마너 접수, 자동 승격 판정은 경로마다 규칙이 달라 호출부에 남긴다. 저장 자체만 한 벌로 만드는
// 것이 목적이고, 그 이상을 끌어오면 경로별 분기가 이 안으로 밀려들어와 오히려 읽기 어려워진다.
//
// 트랜잭션 경로(문의 전환)도 쓸 수 있도록 실행자를 주입받는다 — 기본은 db 모듈,
// 트랜잭션 중이면 그 client를 감싼 실행자를 넘긴다(makeClientExecutor).
const db = require('../db');
const { splitTypeAndPlate } = require('./vehicleInfo');

// 기본 실행자 — db 모듈은 '?' 위치 파라미터를 쓴다(db.js toPgSql).
const defaultExecutor = {
  run: (sql, params) => db.run(sql, params),
  get: (sql, params) => db.get(sql, params),
};

// 트랜잭션용 실행자. pool.connect()로 얻은 client를 넘기면 같은 '?' 문법을 쓸 수 있게 감싼다.
function makeClientExecutor(client) {
  const toPg = (sql) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };
  return {
    run: async (sql, params = []) => {
      const { rows, rowCount } = await client.query(toPg(sql), params);
      return { rowCount, lastInsertRowid: rows[0] ? rows[0].id : undefined };
    },
    get: async (sql, params = []) => {
      const { rows } = await client.query(toPg(sql), params);
      return rows[0];
    },
  };
}

const VALID_ORDER_TYPES = ['dispatch', 'premium', 'daily_driver'];
const VALID_HOURS_BRACKETS = ['within_4h', 'within_8h', 'over_8h'];

function toNumOrNull(v) {
  return v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
}

// 구버전 DB(마이그레이션 미적용)에서 없을 수 있는 컬럼들. 여기 있는 이름이 42703으로 걸리면
// 최소 컬럼만으로 한 번 더 시도한다 — 기존 routes/orders.js가 하던 방어를 그대로 옮겼다.
const OPTIONAL_COLUMN_RE = /(vehicle_type|ferry_fare_amount|memo_billing|order_type|trip_type|final_destination|destination_wait|reservation_hours|origin_lat|origin_lon|origin_sido|origin_sigugun|origin_dong|destination_lat|destination_lon|destination_sido|destination_sigugun|destination_dong|chat_session_id|source_channel|split_group_id|split_seq|split_total)/;

async function insertOrderRow(exec, o) {
  const tempOid = 'PENDING-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  try {
    return await exec.run(`
      INSERT INTO orders (oid, branch_id, requester_group_id, origin_address, origin_address_detail, origin_contact,
        destination_address, destination_address_detail, destination_contact, vehicle_number,
        vehicle_type, reserved_date, reserved_time, payment_method_id, fare_amount, ferry_fare_amount,
        order_type, trip_type, final_destination_address, final_destination_address_detail,
        destination_wait_minutes, reservation_hours_bracket,
        origin_lat, origin_lon, origin_sido, origin_sigugun, origin_dong,
        destination_lat, destination_lon, destination_sido, destination_sigugun, destination_dong,
        status, memo_customer, memo_billing, created_by, chat_session_id, source_channel,
        split_group_id, split_seq, split_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '오더등록', ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [
      tempOid, o.branchId, o.requesterGroupId, o.originAddress, o.originAddressDetail, o.originContact,
      o.destinationAddress, o.destinationAddressDetail, o.destinationContact, o.vehicleNumber,
      o.vehicleType, o.reservedDate, o.reservedTime, o.paymentMethodId, o.fareAmount, o.ferryFareAmount,
      o.orderType, o.tripType, o.finalDestinationAddress, o.finalDestinationAddressDetail,
      o.destinationWaitMinutes, o.reservationHoursBracket,
      o.originLat, o.originLon, o.originSido, o.originSigugun, o.originDong,
      o.destinationLat, o.destinationLon, o.destinationSido, o.destinationSigugun, o.destinationDong,
      o.memoCustomer, o.memoBilling, o.createdBy, o.chatSessionId, o.sourceChannel,
      o.splitGroupId || null, o.splitSeq || null, o.splitTotal || null,
    ]);
  } catch (e) {
    if (!(e && e.code === '42703' && OPTIONAL_COLUMN_RE.test(String(e.message || '')))) throw e;
    console.error('오더 생성: 선택 컬럼 없음 — 최소 컬럼으로 재시도:', e.message);
    return exec.run(`
      INSERT INTO orders (oid, branch_id, requester_group_id, origin_address, origin_address_detail, origin_contact,
        destination_address, destination_address_detail, destination_contact, vehicle_number,
        reserved_date, reserved_time, payment_method_id, fare_amount, status, memo_customer, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '오더등록', ?, ?)
      RETURNING id
    `, [
      tempOid, o.branchId, o.requesterGroupId, o.originAddress, o.originAddressDetail, o.originContact,
      o.destinationAddress, o.destinationAddressDetail, o.destinationContact, o.vehicleNumber,
      o.reservedDate, o.reservedTime, o.paymentMethodId, o.fareAmount, o.memoCustomer, o.createdBy,
    ]);
  }
}

// 오더 한 건 생성. 반환: { orderId, oid, vehicleNumber, vehicleType }
//
// input은 화면 폼 이름이 아니라 도메인 이름으로 받는다 — 폼 필드명(origin_detail_address 등)은
// 경로마다 다르고, 그 차이를 이 안으로 들이면 다시 갈라지기 때문이다.
async function createOrder(input, options = {}) {
  const exec = options.client ? makeClientExecutor(options.client) : (options.executor || defaultExecutor);
  const split = splitTypeAndPlate(input.vehicleType || null, input.vehicleNumber || null);

  const row = {
    branchId: input.branchId,
    requesterGroupId: input.requesterGroupId || null,
    originAddress: input.originAddress,
    originAddressDetail: input.originAddressDetail || null,
    originContact: input.originContact || null,
    destinationAddress: input.destinationAddress || null,
    destinationAddressDetail: input.destinationAddressDetail || null,
    destinationContact: input.destinationContact || null,
    vehicleNumber: split.vehicleNumber,
    vehicleType: split.vehicleType,
    reservedDate: input.reservedDate,
    reservedTime: input.reservedTime,
    paymentMethodId: input.paymentMethodId || null,
    fareAmount: Number(input.fareAmount) || 0,
    ferryFareAmount: Number(input.ferryFareAmount) || 0,
    orderType: VALID_ORDER_TYPES.includes(input.orderType) ? input.orderType : 'dispatch',
    tripType: input.tripType || null,
    finalDestinationAddress: input.finalDestinationAddress || null,
    finalDestinationAddressDetail: input.finalDestinationAddressDetail || null,
    destinationWaitMinutes: input.destinationWaitMinutes ? Number(input.destinationWaitMinutes) : null,
    reservationHoursBracket: VALID_HOURS_BRACKETS.includes(input.reservationHoursBracket) ? input.reservationHoursBracket : null,
    originLat: toNumOrNull(input.originLat),
    originLon: toNumOrNull(input.originLon),
    originSido: input.originSido || null,
    originSigugun: input.originSigugun || null,
    originDong: input.originDong || null,
    destinationLat: toNumOrNull(input.destinationLat),
    destinationLon: toNumOrNull(input.destinationLon),
    destinationSido: input.destinationSido || null,
    destinationSigugun: input.destinationSigugun || null,
    destinationDong: input.destinationDong || null,
    memoCustomer: input.memoCustomer || null,
    memoBilling: input.memoBilling || null,
    createdBy: input.createdBy || null,
    chatSessionId: input.chatSessionId || null,
    sourceChannel: input.sourceChannel || null,
    // 같은 요청을 여러 건으로 나눠 접수했을 때의 묶음(lib/orderSplit.js). 한 건짜리 접수는 전부 null이다.
    splitGroupId: input.splitGroupId || null,
    splitSeq: input.splitSeq || null,
    splitTotal: input.splitTotal || null,
  };

  const inserted = await insertOrderRow(exec, row);
  const orderId = Number(inserted.lastInsertRowid);
  const oid = 'OID' + (1000 + orderId);
  await exec.run('UPDATE orders SET oid = ? WHERE id = ?', [oid, orderId]);

  const waypoints = Array.isArray(input.waypoints) ? input.waypoints : [];
  for (let i = 0; i < waypoints.length; i += 1) {
    const w = waypoints[i];
    await exec.run(
      // reserved_date/time은 "이 경유지에서 다른 날 다시 출발한다"를 담는다(마이그레이션
      // 20260809060000). 같은 날 이어서 도는 평범한 경유는 비어 있는 게 정상이다.
      'INSERT INTO order_waypoints (order_id, seq, address, address_detail, contact_phone, vehicle_number, lat, lon, reserved_date, reserved_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [orderId, i + 1, w.address, w.addressDetail || null, w.contact || null, w.vehicleNumber || null,
        toNumOrNull(w.lat), toNumOrNull(w.lon), w.reservedDate || null, w.reservedTime || null]
    ).catch(async (e) => {
      // 마이그레이션 전 DB에서도 경유지 저장 자체는 되어야 한다.
      if (!e || e.code !== '42703') throw e;
      await exec.run(
        'INSERT INTO order_waypoints (order_id, seq, address, address_detail, contact_phone, vehicle_number, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [orderId, i + 1, w.address, w.addressDetail || null, w.contact || null, w.vehicleNumber || null,
          toNumOrNull(w.lat), toNumOrNull(w.lon)]
      );
    });
  }

  // 구간 릴레이: 경유지 N개 = 구간 N+1개. driver_id는 전부 NULL로 시작한다(생성 시점엔 배정 안 함).
  // order_legs 마이그레이션이 안 된 DB에서도 오더 생성 자체는 성공해야 하므로 실패는 무시한다.
  // ⚠ 트랜잭션 중에는 무시할 수 없다 — 실패한 문장이 트랜잭션 전체를 abort시켜 이후 쿼리가
  // 모두 25P02로 죽기 때문에, 그 경우는 그대로 던져 호출부가 롤백하게 한다.
  try {
    for (let i = 0; i < waypoints.length + 1; i += 1) {
      await exec.run('INSERT INTO order_legs (order_id, seq, driver_id) VALUES (?, ?, NULL)', [orderId, i + 1]);
    }
  } catch (e) {
    if (options.client) throw e;
    console.error('order_legs 생성 실패(마이그레이션 미적용 가능성, 무시하고 진행):', e.message);
  }

  await exec.run(
    `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note)
     VALUES (?, ?, NULL, '오더등록', ?)`,
    [orderId, input.createdBy || null, input.historyNote || '최초 등록']
  );

  return { orderId, oid, vehicleNumber: split.vehicleNumber, vehicleType: split.vehicleType };
}

module.exports = { createOrder, makeClientExecutor };
