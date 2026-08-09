// 구간별 사진 업로드 링크를 확인한다 — 토큰이 어느 구간을 가리키는지, 올린 사진에 구간이 남는지.
//
// 이 링크는 로그인 없이 열리는 통로다. 토큰이 엉뚱한 오더를 가리키면 남의 차 사진을 올리거나
// 보게 되므로, "토큰 → 오더·구간" 해석이 이 기능에서 가장 중요한 판단이다.
//
// 실제 파일 업로드는 하지 않는다(스토리지에 쓰레기가 남는다). 토큰 해석과 구간 라벨,
// 그리고 사진 행에 구간이 남는지를 본다. 만든 행만 지운다.
//
//   node scripts/check-leg-photo-upload.js
require('dotenv').config();
const db = require('../db');

const MARK = 'e2e-leg-photo-check';
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}`);
  if (!ok) console.log(`         기대: ${JSON.stringify(expected)}\n         실제: ${JSON.stringify(actual)}`);
}

async function main() {
  const created = { orderId: null, photoIds: [] };

  try {
    const hasColumns = await db.all(
      `SELECT 1 FROM information_schema.columns WHERE (table_name = 'order_legs' AND column_name = 'photo_upload_token')
          OR (table_name = 'order_photos' AND column_name = 'leg_seq')`
    );
    if (hasColumns.length < 2) {
      console.log('마이그레이션 20260809040000 미적용 — 확인을 건너뜁니다.');
      return;
    }

    const branch = await db.get('SELECT id FROM branches ORDER BY id LIMIT 1');
    const order = await db.get(
      `INSERT INTO orders (oid, branch_id, status, origin_address, destination_address, reserved_date, reserved_time, memo_customer)
       VALUES (?, ?, '접수', '서울 강서구 출발지', '부산 해운대 도착지', '2026-08-20', '14:00', ?) RETURNING id`,
      [`${MARK}-oid`, branch.id, MARK]
    );
    created.orderId = order.id;

    // 경유지 하나 → 구간 둘(출발→경유, 경유→도착).
    await db.run(
      'INSERT INTO order_waypoints (order_id, seq, address) VALUES (?, 1, ?)',
      [created.orderId, '대전 중구 경유지']
    );
    await db.run('INSERT INTO order_legs (order_id, seq, driver_id) VALUES (?, 1, NULL)', [created.orderId]);
    await db.run('INSERT INTO order_legs (order_id, seq, driver_id) VALUES (?, 2, NULL)', [created.orderId]);

    console.log('[구간마다 다른 토큰]');
    const legs = await db.all(
      'SELECT seq, photo_upload_token FROM order_legs WHERE order_id = ? ORDER BY seq',
      [created.orderId]
    );
    check('구간이 둘이다', legs.length, 2);
    check('두 구간 모두 토큰이 있다', legs.every((l) => !!l.photo_upload_token), true);
    // 같은 토큰이면 구간을 나눈 의미가 없다.
    check('토큰이 서로 다르다', legs[0].photo_upload_token !== legs[1].photo_upload_token, true);

    const orderToken = await db.get('SELECT photo_upload_token FROM orders WHERE id = ?', [created.orderId]);
    check('오더 토큰과도 다르다', legs[0].photo_upload_token !== orderToken.photo_upload_token, true);

    console.log('\n[토큰이 가리키는 구간]');
    // 서버가 실제로 해석하는 경로를 그대로 부른다 — 여기서 오더를 잘못 찾으면 남의 사진이 걸린다.
    const fetchTarget = async (token) => {
      const res = await fetch(`${BASE_URL}/upload/${token}/data.json`, { headers: { 'X-Requested-With': 'fetch' } });
      return res.ok ? res.json() : null;
    };

    const first = await fetchTarget(legs[0].photo_upload_token);
    check('1구간 토큰이 이 오더를 찾는다', first && first.order && first.order.id, created.orderId);
    check('1구간으로 인식한다', first && first.leg && first.leg.seq, 1);
    check('구간 수를 센다', first && first.leg && first.leg.total, 2);
    check('출발 지점을 보여준다', first && first.leg && first.leg.from, '서울 강서구 출발지');
    check('도착 지점은 경유지다', first && first.leg && first.leg.to, '대전 중구 경유지');

    const second = await fetchTarget(legs[1].photo_upload_token);
    check('2구간은 경유지에서 시작한다', second && second.leg && second.leg.from, '대전 중구 경유지');
    check('2구간은 도착지에서 끝난다', second && second.leg && second.leg.to, '부산 해운대 도착지');

    const byOrder = await fetchTarget(orderToken.photo_upload_token);
    // 구간이 없는 오더(단일 배정, 옛 오더)는 예전처럼 오더 토큰으로 동작해야 한다.
    check('오더 토큰도 그대로 통한다', byOrder && byOrder.order && byOrder.order.id, created.orderId);
    check('오더 토큰에는 구간이 없다', byOrder && byOrder.leg, null);

    const bogus = await fetch(`${BASE_URL}/upload/definitely-not-a-token/data.json`, { headers: { 'X-Requested-With': 'fetch' } });
    check('엉뚱한 토큰은 404', bogus.status, 404);

    console.log('\n[사진에 구간이 남는다]');
    const p1 = await db.get(
      'INSERT INTO order_photos (order_id, url, leg_seq) VALUES (?, ?, 1) RETURNING id',
      [created.orderId, 'https://storage.example/leg1.jpg']
    );
    const p2 = await db.get(
      'INSERT INTO order_photos (order_id, url, leg_seq) VALUES (?, ?, NULL) RETURNING id',
      [created.orderId, 'https://storage.example/whole.jpg']
    );
    created.photoIds.push(p1.id, p2.id);

    const rows = await db.all('SELECT id, leg_seq FROM order_photos WHERE order_id = ? ORDER BY id', [created.orderId]);
    check('구간 링크로 올린 사진은 구간이 남는다', rows[0].leg_seq, 1);
    // 구간이 없는 오더도 있으므로, 모르면 비워두는 게 맞다 — 추측해서 넣으면 그게 더 나쁘다.
    check('오더 링크로 올린 사진은 비어 있다', rows[1].leg_seq, null);
  } finally {
    if (created.orderId) {
      await db.run('DELETE FROM order_photos WHERE order_id = ?', [created.orderId]).catch(() => {});
      await db.run('DELETE FROM order_legs WHERE order_id = ?', [created.orderId]).catch(() => {});
      await db.run('DELETE FROM order_waypoints WHERE order_id = ?', [created.orderId]).catch(() => {});
      await db.run('DELETE FROM orders WHERE id = ? AND memo_customer = ?', [created.orderId, MARK]).catch(() => {});
    }
    console.log(`\n정리: order=${created.orderId ?? '-'}`);
  }

  console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => {
  console.error('\n확인 중 오류:', e.message);
  process.exit(1);
});
