// 오더 생성 공용 모듈 검증 — lib/orderCreate.js로 만든 오더가 웹 경로가 만들던 것과 같은
// 컬럼을 채우는지 실제 DB에 넣어 확인하고, 확인 후 지운다.
//
// 콜마너 접수는 호출부(routes/orders.js)에 남아 있어 이 스크립트에서는 나가지 않는다 —
// 여기서 만드는 건 DB 행 하나뿐이다.
//
//   node scripts/check-order-create.js
require('dotenv').config();
const db = require('../db');
const { pool } = require('../db');
const { createOrder } = require('../lib/orderCreate');

// 실사용 데이터를 건드리지 않도록 검증용 값만 쓴다.
const MARK = '[검증] orderCreate 공용모듈 테스트';

async function pickContext() {
  const branch = await db.get("SELECT id FROM branches WHERE status = 'active' ORDER BY id LIMIT 1");
  const user = await db.get("SELECT id FROM users WHERE status = 'active' ORDER BY id LIMIT 1");
  if (!branch || !user) throw new Error('활성 지사/사용자가 없어 검증할 수 없습니다.');
  return { branchId: branch.id, userId: user.id };
}

async function main() {
  const { branchId, userId } = await pickContext();
  const created = [];

  // 1) 웹 경로 모양 — 좌표·행정구역·경유지·요금까지 전부 채운 경우
  const web = await createOrder({
    branchId,
    originAddress: '경기 성남시 분당구 판교역로 160',
    originAddressDetail: '3층',
    originContact: '010-1111-2222',
    destinationAddress: '서울 동작구 남부순환로 2089',
    destinationContact: '010-3333-4444',
    vehicleNumber: '12가3456',
    vehicleType: '토레스',
    reservedDate: '2026-08-09',
    reservedTime: '14:00',
    fareAmount: 20000,
    ferryFareAmount: 0,
    orderType: 'dispatch',
    originLat: 37.3947, originLon: 127.1112, originSido: '경기', originSigugun: '성남시분당구', originDong: '백현동',
    destinationLat: 37.4765, destinationLon: 126.9816, destinationSido: '서울', destinationSigugun: '동작구', destinationDong: '사당동',
    memoCustomer: MARK,
    createdBy: userId,
    waypoints: [{ address: '경기 성남시 중원구 성남대로 1', contact: '010-5555-6666', lat: 37.44, lon: 127.13 }],
    sourceChannel: 'web',
  });
  created.push(web.orderId);

  // 2) 카카오 경로 모양 — 요금 0, 세션 연결, 경유지 없음
  const kakao = await createOrder({
    branchId,
    originAddress: '경기도 군포시 농심로59번길 4',
    originContact: '010-7274-4312',
    destinationAddress: '서울 양천로 53길 30',
    destinationContact: '010-8230-1240',
    vehicleNumber: '313오2108',
    vehicleType: '토레스',
    reservedDate: '2026-08-09',
    reservedTime: '09:00',
    fareAmount: 0,
    memoCustomer: MARK,
    createdBy: userId,
    sourceChannel: 'kakao',
    historyNote: '카카오 상담톡 자동 접수',
  });
  created.push(kakao.orderId);

  // 3) 문의 전환 모양 — 트랜잭션 안에서
  const client = await pool.connect();
  let inquiryOrderId = null;
  try {
    await client.query('BEGIN');
    const conv = await createOrder({
      branchId,
      originAddress: '서울 강서구 양천로 400',
      originContact: '미정',
      destinationAddress: '인천 중구 공항로 271',
      destinationContact: '미정',
      vehicleType: '렉스턴',
      reservedDate: '2026-08-09',
      reservedTime: '10:00',
      fareAmount: 55000,
      memoCustomer: MARK,
      createdBy: userId,
      sourceChannel: 'inquiry',
      historyNote: '문의에서 오더로 전환',
    }, { client });
    inquiryOrderId = conv.orderId;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  created.push(inquiryOrderId);

  // 검증 — 컬럼이 실제로 채워졌는지, 부속 레코드가 만들어졌는지
  const rows = await db.all(
    `SELECT o.id, o.oid, o.status, o.source_channel, o.vehicle_number, o.vehicle_type, o.fare_amount,
       o.origin_sido, o.destination_sido, o.chat_session_id,
       (SELECT COUNT(*)::int FROM order_waypoints w WHERE w.order_id = o.id) AS waypoints,
       (SELECT COUNT(*)::int FROM order_legs l WHERE l.order_id = o.id) AS legs,
       (SELECT COUNT(*)::int FROM order_status_history h WHERE h.order_id = o.id) AS history
     FROM orders o WHERE o.id = ANY(?) ORDER BY o.id`,
    [created]
  );
  console.table(rows);

  const checks = [
    ['oid 부여', rows.every((r) => /^OID\d+$/.test(r.oid))],
    ['상태 오더등록', rows.every((r) => r.status === '오더등록')],
    ['차종/번호 분리', rows[0].vehicle_number === '12가3456' && rows[0].vehicle_type === '토레스'],
    ['경유지 저장', rows[0].waypoints === 1],
    ['구간 수 = 경유지+1', rows[0].legs === 2 && rows[1].legs === 1],
    ['상태 이력 1건씩', rows.every((r) => r.history === 1)],
    ['채널 기록', rows.map((r) => r.source_channel).join(',') === 'web,kakao,inquiry'],
    ['좌표/행정구역', rows[0].origin_sido === '경기' && rows[0].destination_sido === '서울'],
  ];
  let ok = true;
  checks.forEach(([label, pass]) => {
    if (!pass) ok = false;
    console.log((pass ? '  OK   ' : '  실패 ') + label);
  });

  // 정리 — 만든 것만 지운다(부속 레코드는 FK cascade가 없을 수 있어 명시적으로)
  for (const id of created) {
    await db.run('DELETE FROM order_status_history WHERE order_id = ?', [id]).catch(() => {});
    await db.run('DELETE FROM order_legs WHERE order_id = ?', [id]).catch(() => {});
    await db.run('DELETE FROM order_waypoints WHERE order_id = ?', [id]).catch(() => {});
    await db.run('DELETE FROM orders WHERE id = ?', [id]);
  }
  const left = await db.get('SELECT COUNT(*)::int AS c FROM orders WHERE id = ANY(?)', [created]);
  console.log(`\n검증용 오더 ${created.length}건 정리 — 남은 행: ${left.c}`);
  console.log(ok ? '세 경로 모두 동일한 결과로 저장됨' : '불일치 항목이 있습니다');
  process.exitCode = ok && left.c === 0 ? 0 : 1;
}

main().catch((e) => { console.error('검증 실패:', e.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(), 300));
