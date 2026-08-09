// 웹 등록 경로(POST /orders)도 접수 분리 규칙을 타는지 확인한다.
//
// 카카오 자동접수는 lib/kakaoIntakeService.js에서 나누는데, 웹은 라우트가 직접 createOrder를
// 부르는 구조라 별도로 붙여야 했다. 두 경로가 같은 규칙(lib/orderSplit.js)을 쓰는지 본다 —
// 갈라지면 같은 요청이 어디로 들어왔느냐에 따라 다른 오더가 된다.
//
// 실제 HTTP로 부른다. 라우트 안에 검증·콜마너 접수·자동승격이 함께 있어서, 함수만 떼어 부르면
// 정작 실사용 경로를 확인하지 못한다. 콜마너로는 나가지 않는 지사를 쓴다.
//
//   node scripts/check-order-split-web.js
require('dotenv').config();
const db = require('../db');

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const LOGIN_ID = process.env.E2E_LOGIN_ID || 'admin';
const PASSWORD = process.env.E2E_PASSWORD || 'Admin!2345';
const MARK = 'e2e-web-split-check';

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}`);
  if (!ok) console.log(`         기대: ${JSON.stringify(expected)}\n         실제: ${JSON.stringify(actual)}`);
}

async function login() {
  const res = await fetch(`${BASE_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ login_id: LOGIN_ID, password: PASSWORD }),
    redirect: 'manual',
  });
  const cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : [])
    .map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`로그인 실패 (${res.status})`);
  return cookie;
}

async function postOrder(cookie, form) {
  const res = await fetch(`${BASE_URL}/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'fetch',
      cookie,
    },
    body: new URLSearchParams(form),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  const createdIds = [];

  try {
    const branch = await db.get('SELECT id FROM branches WHERE callmaner_enabled = false ORDER BY id LIMIT 1');
    if (!branch) {
      console.log('콜마너 미사용 지사가 없어 건너뜁니다 — 실오더가 나갈 수 있어 진행하지 않습니다.');
      return;
    }
    const cookie = await login();

    const base = {
      branch_id: String(branch.id),
      origin_address: '서울 강서구 양천로53길 30',
      origin_contact: '010-1111-2222',
      destination_address: '부산 해운대구 우동 1413',
      destination_contact: '010-3333-4444',
      vehicle_number: '12가3456',
      vehicle_type: '토레스',
      reserved_date: '2026-08-20',
      reserved_time: '14:00',
      fare_amount: '0',
      memo_customer: MARK,
    };

    console.log('[경유지가 있어도 날짜가 같으면 한 건]');
    {
      const { status, body } = await postOrder(cookie, {
        ...base,
        waypoints: '대전 중구 중앙로 101',
        waypoint_contacts: '010-5555-6666',
      });
      check('등록된다', status, 200);
      if (body.orderId) createdIds.push(body.orderId);
      check('한 건만', body.split, undefined);
      // 경유지는 사라지면 안 된다 — 한 건으로 등록하되 order_waypoints에 남는다.
      const wps = await db.all('SELECT address FROM order_waypoints WHERE order_id = ?', [body.orderId]);
      check('경유지가 저장된다', wps.map((w) => w.address), ['대전 중구 중앙로 101']);
    }

    console.log('\n[경유지 날짜가 다르면 두 건]');
    {
      const { status, body } = await postOrder(cookie, {
        ...base,
        waypoints: '대전 중구 중앙로 101',
        waypoint_contacts: '010-5555-6666',
        waypoint_reserved_dates: '2026-08-22',
        waypoint_reserved_times: '10:00',
      });
      check('등록된다', status, 200);
      (body.split ? body.split.orders : [{ orderId: body.orderId }]).forEach((o) => createdIds.push(o.orderId));

      check('두 건으로 나뉜다', body.split && body.split.total, 2);
      check('이유를 밝힌다', body.split && body.split.reason, 'waypoint');

      const rows = await db.all(
        `SELECT origin_address, destination_address, reserved_date, reserved_time, split_group_id, split_seq, split_total
         FROM orders WHERE id = ANY(?) ORDER BY split_seq`,
        [body.split.orders.map((o) => o.orderId)]
      );
      check('1건: 출발지 → 경유지', [rows[0].origin_address, rows[0].destination_address], ['서울 강서구 양천로53길 30', '대전 중구 중앙로 101']);
      check('2건: 경유지 → 도착지', [rows[1].origin_address, rows[1].destination_address], ['대전 중구 중앙로 101', '부산 해운대구 우동 1413']);
      check('1건 일시', [rows[0].reserved_date, rows[0].reserved_time], ['2026-08-20', '14:00']);
      // 경유지에 적힌 일시로 접수돼야 한다 — 여기가 틀리면 기사가 엉뚱한 날 간다.
      check('2건 일시', [rows[1].reserved_date, rows[1].reserved_time], ['2026-08-22', '10:00']);
      check('같은 묶음', rows[0].split_group_id === rows[1].split_group_id && !!rows[0].split_group_id, true);
      check('순번', [rows[0].split_seq, rows[1].split_seq], [1, 2]);

      // 나뉜 건에는 경유지가 남지 않는다(각각 A→B다).
      const wps = await db.all('SELECT order_id FROM order_waypoints WHERE order_id = ANY(?)', [body.split.orders.map((o) => o.orderId)]);
      check('나뉜 건에는 경유지가 없다', wps.length, 0);
    }

    console.log('\n[경유지가 없으면 예전 그대로]');
    {
      const { status, body } = await postOrder(cookie, base);
      check('등록된다', status, 200);
      if (body.orderId) createdIds.push(body.orderId);
      check('묶음 정보 없음', body.split, undefined);
      const row = await db.get('SELECT split_group_id FROM orders WHERE id = ?', [body.orderId]);
      check('묶음 컬럼도 비어 있다', row.split_group_id, null);
    }
  } finally {
    if (createdIds.length) {
      await db.run('DELETE FROM order_waypoints WHERE order_id = ANY(?)', [createdIds]).catch(() => {});
      await db.run('DELETE FROM order_legs WHERE order_id = ANY(?)', [createdIds]).catch(() => {});
      await db.run('DELETE FROM order_status_history WHERE order_id = ANY(?)', [createdIds]).catch(() => {});
      await db.run('DELETE FROM orders WHERE id = ANY(?) AND memo_customer = ?', [createdIds, MARK]).catch(() => {});
    }
    const left = await db.all('SELECT id FROM orders WHERE memo_customer = ?', [MARK]).catch(() => []);
    console.log(`\n정리: 만든 오더 ${createdIds.length}건, 남은 행 ${left.length}`);
  }

  console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => {
  console.error('\n확인 중 오류:', e.message);
  process.exit(1);
});
