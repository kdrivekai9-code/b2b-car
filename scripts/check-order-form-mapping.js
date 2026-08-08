// 웹 오더등록 폼 → createOrder 입력 매핑 검사.
//
// 이 리팩터링의 실제 위험은 lib/orderCreate.js가 아니라 **매핑 한 줄**이다. 폼 필드명을 잘못
// 적어도(origin_detail_address ↔ origin_address_detail 처럼 비슷한 이름이 섞여 있다) 예외가
// 나지 않고 그 값만 조용히 null로 저장된다. Node에서 createOrder를 직접 부르는 검증은 이
// 매핑을 건너뛰기 때문에 그 실수를 잡지 못한다.
//
// 그래서 실제 라우트 핸들러를 그대로 실행한다 — Express 앱에 요청을 넣지 않고 핸들러 함수만
// 꺼내 가짜 req/res로 호출하고, DB에 저장된 행을 폼 값과 하나씩 비교한 뒤 지운다.
//
//   node scripts/check-order-form-mapping.js
require('dotenv').config();
const db = require('../db');

const MARK = '[검증] 폼 매핑 테스트';

// 실제 폼이 보내는 이름 그대로 — views/orders/form.ejs / public/js/order-form.js 기준.
function buildFormBody({ branchId, paymentMethodId }) {
  return {
    branch_id: String(branchId),
    origin_address: '경기 성남시 분당구 판교역로 160',
    origin_detail_address: '3층 301호',
    origin_contact: '010-1111-2222',
    destination_address: '서울 동작구 남부순환로 2089',
    destination_detail_address: '지하 1층',
    destination_contact: '010-3333-4444',
    vehicle_number: '12가3456',
    vehicle_type: '토레스',
    reserved_date: '2026-08-20',
    reserved_time: '14:00',
    payment_method_id: paymentMethodId ? String(paymentMethodId) : '',
    fare_amount: '20000',
    ferry_fare_amount: '3000',
    memo_customer: MARK,
    memo_billing: '정산메모 검증',
    order_type: 'dispatch',
    origin_lat: '37.3947', origin_lon: '127.1112',
    origin_sido: '경기', origin_sigugun: '성남시분당구', origin_dong: '백현동',
    destination_lat: '37.4765', destination_lon: '126.9816',
    destination_sido: '서울', destination_sigugun: '동작구', destination_dong: '사당동',
    waypoints: ['경기 성남시 중원구 성남대로 1'],
    waypoint_details: ['본관'],
    waypoint_contacts: ['010-5555-6666'],
    waypoint_vehicle_numbers: ['34나5678'],
    waypoint_lats: ['37.44'], waypoint_lons: ['127.13'],
  };
}

// 라우트에서 POST '/' 핸들러만 꺼낸다.
function findCreateHandler(router) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.post);
  if (!layer) throw new Error("POST '/' 핸들러를 찾지 못했습니다.");
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1]; // asyncHandler로 감싼 본체
}

async function main() {
  // ⚠ 반드시 콜마너 연동이 꺼진 지사로 검증한다. 이 스크립트는 라우트 핸들러를 그대로 실행하고,
  // 그 핸들러는 registerOrderWithCallmaner를 await한다 — 연동이 켜진 지사로 돌리면 콜마너에
  // 실제 오더가 접수된다. 첫 실행에서 그렇게 되어(conf_slip 179422464) 수동으로 취소해야 했다.
  // 우리 DB 행만 지워도 콜마너 쪽 접수는 남으므로, 애초에 나가지 않게 하는 것이 유일한 예방이다.
  const branch = await db.get(
    "SELECT id, name FROM branches WHERE status = 'active' AND callmaner_enabled = false ORDER BY id LIMIT 1"
  );
  if (!branch) {
    throw new Error('콜마너 연동이 꺼진 활성 지사가 없습니다 — 이 검증은 실제 접수를 발생시키므로 중단합니다.');
  }
  console.log(`검증 지사: ${branch.name}(id ${branch.id}) — 콜마너 연동 꺼짐 확인\n`);
  const user = await db.get("SELECT id, role, branch_id, group_id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1");
  if (!user) throw new Error('활성 관리자 계정이 없어 검증할 수 없습니다.');
  const pm = await db.get('SELECT id FROM payment_methods WHERE is_active = 1 ORDER BY id LIMIT 1');

  const body = buildFormBody({ branchId: branch.id, paymentMethodId: pm && pm.id });

  const before = await db.get('SELECT COALESCE(MAX(id), 0)::int AS m FROM orders');
  const handler = findCreateHandler(require('../routes/orders'));

  // 가짜 req/res — 세션 사용자는 실제 관리자 행을 쓰고, 응답은 리다이렉트만 받아 확인한다.
  const req = {
    body,
    session: { user },
    get: (name) => (String(name).toLowerCase() === 'x-requested-with' ? 'fetch' : undefined),
    query: {},
    params: {},
  };
  let captured = null;
  const res = {
    status(code) { this._code = code; return this; },
    json(payload) { captured = { code: this._code || 200, payload }; return this; },
    redirect(url) { captured = { code: 302, url }; return this; },
    render(view, locals) { captured = { code: this._code || 200, view, error: locals && locals.error }; return this; },
    set() { return this; },
  };

  await handler(req, res, (e) => { if (e) throw e; });

  if (!captured || (captured.code !== 200 && captured.code !== 302)) {
    console.error('핸들러 응답:', JSON.stringify(captured));
    throw new Error('오더 등록이 성공 응답을 주지 않았습니다(폼 검증 실패 가능).');
  }

  const created = await db.get(
    `SELECT * FROM orders WHERE id > ? AND memo_customer = ? ORDER BY id DESC LIMIT 1`,
    [before.m, MARK]
  );
  if (!created) throw new Error('오더가 저장되지 않았습니다.');

  const wp = await db.all('SELECT * FROM order_waypoints WHERE order_id = ? ORDER BY seq', [created.id]);
  const legs = await db.all('SELECT * FROM order_legs WHERE order_id = ?', [created.id]);

  // 폼 값 → 저장값이 실제로 이어졌는지. combineAddress는 상세주소를 본주소에 붙인다.
  const checks = [
    ['출발지 주소(상세 결합)', created.origin_address === '경기 성남시 분당구 판교역로 160 3층 301호'],
    ['출발지 상세 별도 저장', created.origin_address_detail === '3층 301호'],
    ['출발지 연락처', created.origin_contact === '010-1111-2222'],
    ['도착지 주소(상세 결합)', created.destination_address === '서울 동작구 남부순환로 2089 지하 1층'],
    ['도착지 상세 별도 저장', created.destination_address_detail === '지하 1층'],
    ['도착지 연락처', created.destination_contact === '010-3333-4444'],
    ['차량번호', created.vehicle_number === '12가3456'],
    ['차종', created.vehicle_type === '토레스'],
    ['예약일', created.reserved_date === '2026-08-20'],
    ['예약시각', String(created.reserved_time).startsWith('14:00')],
    ['요금', Number(created.fare_amount) === 20000],
    ['도선요금', Number(created.ferry_fare_amount) === 3000],
    ['정산메모', created.memo_billing === '정산메모 검증'],
    ['출발 좌표', Number(created.origin_lat) === 37.3947 && Number(created.origin_lon) === 127.1112],
    ['출발 행정구역', created.origin_sido === '경기' && created.origin_sigugun === '성남시분당구' && created.origin_dong === '백현동'],
    ['도착 좌표', Number(created.destination_lat) === 37.4765],
    ['도착 행정구역', created.destination_sido === '서울' && created.destination_dong === '사당동'],
    ['채널 web', created.source_channel === 'web'],
    ['경유지 1건', wp.length === 1],
    ['경유지 주소(상세 결합)', wp.length === 1 && wp[0].address === '경기 성남시 중원구 성남대로 1 본관'],
    ['경유지 연락처', wp.length === 1 && wp[0].contact_phone === '010-5555-6666'],
    ['경유지 차량번호', wp.length === 1 && wp[0].vehicle_number === '34나5678'],
    ['경유지 좌표', wp.length === 1 && Number(wp[0].lat) === 37.44],
    ['구간 2개(경유지+1)', legs.length === 2],
  ];

  let ok = true;
  checks.forEach(([label, pass]) => {
    if (!pass) ok = false;
    console.log((pass ? '  OK   ' : '  실패 ') + label);
  });
  if (!ok) {
    console.log('\n저장된 행:');
    console.log(JSON.stringify(created, null, 1));
  }

  // 정리
  await db.run('DELETE FROM order_status_history WHERE order_id = ?', [created.id]).catch(() => {});
  await db.run('DELETE FROM order_legs WHERE order_id = ?', [created.id]).catch(() => {});
  await db.run('DELETE FROM order_waypoints WHERE order_id = ?', [created.id]).catch(() => {});
  await db.run('DELETE FROM orders WHERE id = ?', [created.id]);
  const left = await db.get('SELECT COUNT(*)::int AS c FROM orders WHERE id = ?', [created.id]);
  console.log(`\n검증용 오더(id ${created.id}) 정리 — 남은 행: ${left.c}`);
  console.log(ok ? '폼 → 저장 매핑 전부 일치' : '매핑 불일치가 있습니다');
  process.exitCode = ok && left.c === 0 ? 0 : 1;
}

main().catch((e) => { console.error('검증 실패:', e.message); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(), 300));
