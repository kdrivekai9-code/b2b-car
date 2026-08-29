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
const { recordActivity } = require('./groupActivityFeed');
const { isPostalRequested, generateReceiptToken } = require('./postalReceipt');
const vehicleModels = require('./vehicleModels');
const fareSurcharge = require('./fareSurcharge');

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
    // 요금 계산이 찾아낸 특수구간(민자 교량 등). 접수 경로가 넘겨주면 정산 항목으로 만든다.
    specialTolls: Array.isArray(input.specialTolls) ? input.specialTolls : [],
    // 카카오 경로의 총 통행료. 청구 규칙이 이 값으로 갈린다(fareSurcharge.tollChargeFor).
    tollFare: Number(input.tollFare) > 0 ? Math.round(Number(input.tollFare)) : null,
    // 이 오더에 적용된 요금설정(포함/제외). 호출부가 이미 읽어둔 것을 넘겨받는다.
    fareExtra: input.fareExtra || null,
    // 계산 시점의 할증 내역. 정산서가 "얼마가 왜 붙었는지" 밝히는 근거다.
    fareSurcharges: Array.isArray(input.fareSurcharges) ? input.fareSurcharges : [],
    // 대기요금 — 도착지 대기시간이 요금설정의 기준을 넘으면 붙는다(lib/tripFees.js).
    waitFee: input.waitFee || null,
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
    // 콜마너 적요1(기사메모)에 실을 100Byte 요약. 없으면 전송 시점에 memo_customer를 잘라 쓴다.
    memoDriverBrief: input.memoDriverBrief || null,
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

  // 콜마너 적요1(기사메모)에 실을 100Byte 요약(lib/intakeMemoSplit.js). INSERT에 같이 넣지
  // 않고 따로 쓰는 이유: 위 INSERT는 선택 컬럼이 하나라도 없으면 "최소 컬럼"으로 통째로
  // 재시도하는 구조라(OPTIONAL_COLUMN_RE), 여기에 새 컬럼을 끼우면 마이그레이션 적용 전
  // DB에서 차종·좌표·정산메모까지 한꺼번에 날아간다(실제로 그렇게 만들었다가 검사에서 잡았다).
  // 이 값은 없어도 콜마너가 memo_customer를 잘라 쓰므로, 저 위험을 감수할 이유가 없다.
  if (row.memoDriverBrief) {
    await exec.run('UPDATE orders SET memo_driver_brief = ? WHERE id = ?', [row.memoDriverBrief, orderId])
      .catch((e) => {
        if (e && e.code === '42703') return; // 마이그레이션 20260819010000 전 — 조용히 넘어간다
        console.error('기사메모 요약 저장 실패(무시):', e.message);
      });
  }

  // 차종 분석 결과(car_type / fuel_type)를 접수 시점 값으로 박아둔다.
  //
  // 왜 오더에 복사해 두나: 차종 판정은 나중에 바뀐다(판정 사전 보강, 관리자가 차종 관리에서
  // 체크 수정). 오더가 vehicle_models를 매번 조인해 보면 이미 청구를 끝낸 건의 근거까지
  // 따라 바뀌어, "왜 이 할증이 붙었나"를 되짚을 수 없다.
  //
  // 위 memo_driver_brief와 같은 이유로 INSERT에 끼우지 않고 따로 쓴다 — 선택 컬럼이 하나라도
  // 없으면 INSERT 전체가 최소 컬럼으로 퇴화해 차종·좌표·정산메모까지 날아간다.
  if (row.vehicleType) {
    try {
      const flags = await vehicleModels.flagsForVehicleType(row.vehicleType);
      // vehicle_class_source를 함께 남긴다. car_type만으로는 "확실히 국산"과 "아무것도 안
      // 걸려서 국산으로 떨어짐"이 구분되지 않는데, 뒤쪽은 할증이 통째로 빠진 상태다.
      await exec.run('UPDATE orders SET car_type = ?, fuel_type = ?, vehicle_class_source = ? WHERE id = ?',
        [flags.carType || null, flags.fuelType || null, flags.classSource || null, orderId])
        .catch(async (e) => {
          if (!e || e.code !== '42703') throw e;
          // 마이그레이션 20260828040000 전 — 분류값만이라도 남긴다.
          await exec.run('UPDATE orders SET car_type = ?, fuel_type = ? WHERE id = ?',
            [flags.carType || null, flags.fuelType || null, orderId]);
        });
    } catch (e) {
      if (!e || e.code !== '42703') console.error('차종 분류 저장 실패(무시):', e.message);
      // 마이그레이션 20260828020000 전 — 조용히 넘어간다. 요금 계산은 이 값을 쓰지 않는다.
    }
  }

  // 접수 경로가 안 넘겼으면 여기서 채운다.
  //
  // 왜 여기서: createOrder는 모든 접수 경로가 지나는 한 곳이다(웹 폼 · 카카오 상담톡 · 웹 AI ·
  // 문의 전환). 예전에는 웹 폼 라우트에서만 계산해 넘겨서, **나머지 경로로 접수된 오더는
  // 할증 근거도 특수구간 통행료도 대기요금도 없었다** — 특수구간·대기요금은 곧 청구 누락이다.
  // 경로마다 넘기게 하면 새 경로가 생길 때 또 빠진다.
  //
  // 이미 넘어온 값은 덮어쓰지 않는다 — 웹 폼은 요금소 목록까지 넣어 더 정확하게 판정한다.
  try {
    const needSurcharge = !row.fareSurcharges.length;
    const needTolls = !row.specialTolls.length;
    const needWait = !row.waitFee;
    if (needSurcharge || needTolls || needWait) {
      const branchPolicy = require('./branchPolicy');
      const extraSettings = await branchPolicy.findFareExtra(row.requesterGroupId, row.branchId);
      if (extraSettings) {
        if (needWait) {
          row.waitFee = require('./tripFees').waitFee(extraSettings, row.destinationWaitMinutes);
        }
        if (needTolls) {
          row.specialTolls = await branchPolicy.findSpecialTolls(
            row.requesterGroupId, row.branchId,
            [row.originAddress, row.destinationAddress]
          );
        }
        if (needSurcharge) {
          // 할증(수입·대형·전기·야간·오지·장소)은 거리를 쓰지 않는다 — 요금 전체를 다시
          // 계산하지 않고 설정과 차종·시각만으로 판정할 수 있다.
          const fareSurcharge = require('./fareSurcharge');
          const vehicleModels = require('./vehicleModels');
          const vehicle = row.vehicleType
            ? await vehicleModels.flagsForVehicleType(row.vehicleType)
            : {};
          const computed = fareSurcharge.computeSurcharges(extraSettings, {
            vehicle,
            originAddress: row.originAddress,
            destinationAddress: row.destinationAddress,
            reservedAt: `${row.reservedDate || ''} ${row.reservedTime || ''}`.trim() || null,
          });
          row.fareSurcharges = computed.items || [];
        }
      }
    }
  } catch (e) {
    // 근거를 못 채워도 접수는 진행한다 — 요금(fare_amount)은 이미 정해져 있다.
    console.error('요금 근거 보완 실패(접수는 진행):', e.message);
  }

  // 할증 내역을 접수 시점 값으로 박아둔다.
  //
  // 할증은 이미 fare_amount에 더해져 청구되고 있다(lib/branchPolicy.js). 여기 저장하는 것은
  // **금액이 아니라 근거**다 — 요금설정이나 차종 판정이 나중에 바뀌어도 이미 청구한 건의
  // 설명이 따라 바뀌면 안 된다(car_type을 박아두는 것과 같은 이유).
  if (row.fareSurcharges.length) {
    await exec.run('UPDATE orders SET fare_surcharges_json = ? WHERE id = ?',
      [JSON.stringify(row.fareSurcharges), orderId])
      .catch((e) => {
        if (e && e.code === '42703') return; // 마이그레이션 20260829020000 전
        console.error('할증 내역 저장 실패(무시):', e.message);
      });
  }

  // 대기요금을 접수 시점에 계산해 남긴다.
  //
  // fare_amount에 합치지 않는다 — 정산서에서 구간요금·할증과 나란히 보여야 하고(사용자 지시),
  // 합쳐두면 어느 것이 얼마인지 되짚을 수 없다. 근거(대기 몇 분, 기준 몇 분)도 함께 남긴다.
  if (row.waitFee && row.waitFee.amount > 0) {
    await exec.run('UPDATE orders SET wait_fee_amount = ?, wait_fee_note = ? WHERE id = ?',
      [row.waitFee.amount, row.waitFee.note || null, orderId])
      .catch((e) => {
        if (e && e.code === '42703') return; // 마이그레이션 20260829040000 전
        console.error('대기요금 저장 실패(무시):', e.message);
      });
  }

  // 특수구간 통행료(민자 교량 등)를 정산 항목으로 만들어 둔다.
  //
  // 왜 여기서: 지금까지 calculateFare가 특수구간을 찾아 돌려주기만 하고 **받는 쪽이 없었다.**
  // 등록된 규칙이 1건 있는데 정산 줄은 0건이었다 — 계산은 되는데 청구는 안 되던 상태다.
  //
  // 카카오는 요금소별 금액을 주지 않으므로(실측: summary.fare.toll 합계 하나뿐) 금액은 우리가
  // 등록한 표에서 온다. 그래서 여기 넣는 값은 "보통 이 금액"이고, 실제 영수증이 다르면
  // 오더상세에서 고친다(그래서 지우지 않고 덮어쓰지도 않는다 — 이미 있으면 손대지 않는다).
  //
  // 요금설정에서 "기본요금 포함"으로 둔 법인은 matchSpecialTolls가 빈 배열을 준다 — 이중
  // 청구가 되지 않는다.
  // 예전에는 특수구간을 **줄마다 하나씩** 넣었는데, 일반 통행료를 '실비'로 둔 법인에서는
  // 총 통행료에 그 교량이 이미 들어 있어 두 번 받는 상태가 된다. 어느 쪽이든 줄은 하나다.
  //
  // 호출부가 안 넘기면 여기서 직접 구한다. 접수 경로가 넷인데(웹 폼 · 문의 전환 · 카카오
  // 자동접수 · 웹 프리미엄) **웹 폼 하나만** 넘기고 있어서, 같은 법인이라도 어디로 접수했느냐에
  // 따라 통행료가 청구되거나 안 되는 상태였다. 청구 규칙이 접수 경로에 좌우되면 안 된다.
  //
  // 지연 require — branchPolicy는 orderCreate를 부르지 않아 순환이 아니지만(확인함), 이 함수가
  // 불릴 때만 필요한 의존이라 위로 올리지 않는다.
  const branchPolicy = require('./branchPolicy');
  const fareExtra = row.fareExtra
    || await branchPolicy.findFareExtra(row.requesterGroupId, row.branchId).catch(() => null);
  const specialTolls = (row.specialTolls && row.specialTolls.length)
    ? row.specialTolls
    // 카카오가 준 요금소 이름은 웹 폼 경로에만 있다 — 다른 경로는 주소로만 판정한다.
    // 경로 중간의 교량은 못 잡지만, 아예 안 잡는 것보다는 낫다.
    : await branchPolicy.findSpecialTolls(row.requesterGroupId, row.branchId,
      [row.originAddress, row.destinationAddress]).catch(() => []);

  const tollCharge = fareSurcharge.tollChargeFor(fareExtra || {}, {
    specialTolls,
    tollFare: row.tollFare,
  });
  if (tollCharge && tollCharge.amount > 0) {
    await exec.run(
      `INSERT INTO order_extra_charges (order_id, charge_type, amount, charged_on, billable, note)
       VALUES (?, ?, ?, ?, true, ?)`,
      [orderId, tollCharge.chargeType, tollCharge.amount, row.reservedDate || null, tollCharge.note || null]
    ).catch((e) => {
      if (e && e.code === '42P01') return; // 마이그레이션 전 — 조용히 넘어간다
      console.error('통행료 정산 항목 생성 실패(무시):', e.message);
    });
  }

  // 총 통행료는 청구 여부와 무관하게 남긴다 — 나중에 등록 금액이 맞는지 대조할 근거다.
  // INSERT에 끼우지 않는 이유는 memo_driver_brief와 같다(선택 컬럼 하나로 전체가 퇴화한다).
  if (row.tollFare != null) {
    await exec.run('UPDATE orders SET toll_fare = ? WHERE id = ?', [row.tollFare, orderId])
      .catch((e) => {
        if (e && e.code === '42703') return; // 마이그레이션 20260829040000 전
        console.error('통행료 저장 실패(무시):', e.message);
      });
  }

  // 우편발송(등기) 요청이면 인수증 업로드 링크를 만들어 둔다.
  //
  // 요청사항 어디에 적히든 잡아야 해서 기사 전달사항과 업체 전달사항을 함께 본다 — 고객이
  // "서울지점으로 등기발송부탁드립니다"를 요청사항 끝에 붙이는 일이 흔하다.
  //
  // 여기(오더 생성 한 곳)에서 하는 이유: 접수 경로가 웹 폼·카카오·웹 AI로 여럿인데, 경로마다
  // 판정을 두면 한쪽만 고쳐진다. 위 memo_driver_brief와 같은 이유로 INSERT에 끼우지 않고 따로
  // 쓴다(선택 컬럼이 없으면 INSERT 전체가 최소 컬럼으로 퇴화한다).
  const postalSource = [row.memoCustomer, row.memoBilling].filter(Boolean).join('\n');
  if (isPostalRequested(postalSource)) {
    await exec.run(
      'UPDATE orders SET postal_requested = true, receipt_upload_token = ? WHERE id = ?',
      [generateReceiptToken(), orderId]
    ).catch((e) => {
      if (e && e.code === '42703') return; // 마이그레이션 20260825010000 전 — 조용히 넘어간다
      console.error('우편발송 요청 표시 저장 실패(무시):', e.message);
    });
  }

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

  // 법인 공유 피드 — 네 경로(웹 오더등록·문의 전환·카카오 자동접수·웹 프리미엄 접수)가 전부
  // 이 함수 하나로 들어오므로 여기 한 곳에만 걸면 빠짐없이 잡힌다. db 모듈을 직접 쓰는
  // fire-and-forget 성격의 함수라(절대 throw 안 함) 트랜잭션 실행자(exec)와 무관하게 안전하다
  // — 문의 전환처럼 트랜잭션 중이어도 이 기록 실패가 본 저장을 되돌리지 않는다.
  const routeLine = [row.originAddress, (row.waypoints || waypoints)[0] ? '경유' : null, row.destinationAddress || '(도착지 미기재)']
    .filter(Boolean).join(' → ');
  const summary = [
    `${row.reservedDate || ''} ${row.reservedTime || ''}`.trim() || '즉시',
    [row.vehicleType, row.vehicleNumber].filter(Boolean).join(' '),
    routeLine,
    row.originContact ? `출발 ${row.originContact}` : null,
    row.destinationContact ? `도착 ${row.destinationContact}` : null,
    row.memoCustomer || null,
  ].filter(Boolean).join(' · ');
  recordActivity({
    groupId: row.requesterGroupId, orderId, oid, kind: 'created', summary,
    actorUserId: input.createdBy || null, actorLabel: input.actorLabel || null,
  });

  return { orderId, oid, vehicleNumber: split.vehicleNumber, vehicleType: split.vehicleType };
}

module.exports = { createOrder, makeClientExecutor };
