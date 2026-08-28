// 정산서 할증 표시 방식(법인별 A안/B안)이 **총 청구액을 바꾸지 않는지**.
//
// 사용자 지시(2026-08-29): 법인마다 계약서 형태가 달라 정산서에 할증을 어떻게 보여줄지 고른다.
//   included  운행요금 한 줄로 두고 내역만 밝힌다 (기본값 = 지금 동작)
//   itemized  운행요금에서 할증을 떼어 별도 줄로 보여준다
//
// 이 검사의 핵심은 하나다: **어느 모드든 총 청구액이 같아야 한다.** 저장된 금액(fare_amount)은
// 하나이고 모드는 표시 방식일 뿐이다. 여기가 깨지면 설정 하나 바꿨다고 거래처 청구액이
// 달라진다 — 정산에서 가장 하면 안 되는 일이다.
//
// 할증은 지금도 fare_amount에 이미 더해져 청구된다(lib/branchPolicy.js: fare += surcharge.total).
// 저장하는 것은 금액이 아니라 **근거**다.
require('dotenv').config();
const db = require('../db');
const groupsRoute = require('../routes/groups');

const MARK = 'chk-surmode';
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

async function cleanup() {
  const rows = await db.all('SELECT id FROM orders WHERE oid LIKE ?', [`${MARK}%`]).catch(() => []);
  for (const r of rows) {
    await db.run('DELETE FROM order_extra_charges WHERE order_id = ?', [r.id]).catch(() => {});
    await db.run('DELETE FROM order_status_history WHERE order_id = ?', [r.id]).catch(() => {});
    await db.run('DELETE FROM orders WHERE id = ?', [r.id]).catch(() => {});
  }
}

(async () => {
  let group = null;
  let originalMode = null;
  try {
    await cleanup();
    group = await db.get('SELECT id, settlement_surcharge_mode FROM groups_tbl ORDER BY id LIMIT 1');
    const branch = await db.get('SELECT id FROM branches ORDER BY id LIMIT 1');
    if (!group || !branch) {
      console.log('  (건너뜀 — 법인/지사 표본이 없습니다)');
      console.log('\n모두 통과');
      process.exit(0);
    }
    originalMode = group.settlement_surcharge_mode;

    // 청구액 105,000원 = 기본 97,000 + 수입차 5,000 + 야간 3,000. 할증은 이미 fare_amount에
    // 들어 있고, 내역은 근거로만 저장된다.
    const surcharges = [
      { code: 'imported', label: '수입차 할증', amount: 5000, reason: '수입 브랜드' },
      { code: 'night', label: '야간/조조 할증', amount: 3000, reason: '야간 출발' },
    ];
    const row = await db.get(
      `INSERT INTO orders (oid, branch_id, requester_group_id, status, reserved_date, reserved_time,
                           origin_address, destination_address, fare_amount, ferry_fare_amount, fare_surcharges_json)
       VALUES (?, ?, ?, '완료', '2019-09-10', '23:30', '검사출발', '검사도착', 105000, 0, ?)
       RETURNING id`,
      [`${MARK}-1`, branch.id, group.id, JSON.stringify(surcharges)]
    );
    await db.run(
      `INSERT INTO order_status_history (order_id, old_status, new_status, created_at)
       VALUES (?, '기사배정', '완료', '2019-09-10 23:59:00')`, [row.id]
    );

    const load = async (mode) => {
      await db.run('UPDATE groups_tbl SET settlement_surcharge_mode = ? WHERE id = ?', [mode, group.id]);
      const data = await groupsRoute.loadSettlement(group.id, '2019-09');
      const mine = data.items.filter((r) => String(r.oid || '').startsWith(MARK));
      return { data, mine };
    };

    console.log('[포함 방식 — 지금 동작]');
    const inc = await load('included');
    check('모드', inc.data.surchargeMode, 'included');
    check('운행요금은 할증 포함 금액', inc.mine[0] && inc.mine[0].fare, 105000);
    check('할증 내역이 살아 있다', inc.mine[0] && inc.mine[0].surchargeTotal, 8000);
    // 기본요금은 청구액에서 역산한다 — 그래야 합이 항상 맞는다.
    check('기본요금은 역산', inc.mine[0] && inc.mine[0].baseFare, 97000);

    console.log('[별도 줄 방식]');
    const item = await load('itemized');
    check('모드', item.data.surchargeMode, 'itemized');
    // 저장된 금액은 그대로다 — 모드는 표시 방식일 뿐이다.
    check('저장된 운행요금은 그대로', item.mine[0] && item.mine[0].fare, 105000);
    check('할증 항목별 합계', item.data.surchargeByLabel['수입차 할증'], { count: 1, amount: 5000 });

    console.log('[**총 청구액은 어느 모드든 같아야 한다** — 여기가 이 기능의 전부다]');
    check('총 청구액 동일', inc.data.grandTotal, item.data.grandTotal);
    check('총 청구액 값', inc.data.grandTotal, 105000);
    // 화면이 보여줄 금액도 합이 맞아야 한다: (할증 제외 운행요금) + 할증 = 포함 방식 운행요금
    check('별도 줄 합이 포함 방식과 같다',
      item.data.summary.base + item.data.summary.ferry + item.data.summary.surcharge,
      inc.data.summary.total);

    console.log('[할증 내역이 없는 오더는 예전과 똑같이 보인다]');
    const plain = await db.get(
      `INSERT INTO orders (oid, branch_id, requester_group_id, status, reserved_date, reserved_time,
                           origin_address, destination_address, fare_amount, ferry_fare_amount)
       VALUES (?, ?, ?, '완료', '2019-09-11', '10:00', '검사출발2', '검사도착2', 50000, 0) RETURNING id`,
      [`${MARK}-2`, branch.id, group.id]
    );
    await db.run(
      `INSERT INTO order_status_history (order_id, old_status, new_status, created_at)
       VALUES (?, '기사배정', '완료', '2019-09-11 18:00:00')`, [plain.id]
    );
    const after = await load('itemized');
    const plainRow = after.mine.find((r) => r.oid === `${MARK}-2`);
    check('할증 없으면 기본요금 = 운행요금', plainRow && plainRow.baseFare, 50000);
    check('할증 합계 0', plainRow && plainRow.surchargeTotal, 0);
    // 마이그레이션 전 오더(컬럼이 null)도 깨지지 않아야 한다.
    check('내역이 없어도 총액은 정상', after.data.grandTotal, 155000);
  } finally {
    if (group) {
      await db.run('UPDATE groups_tbl SET settlement_surcharge_mode = ? WHERE id = ?',
        [originalMode || 'included', group.id]).catch(() => {});
    }
    await cleanup();
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
