// 기타 정산 내역(주유비 · 주차요금 · 톨게이트)이 정산서에 맞게 들어가는지.
//
// 이 표에 들어간 금액은 거래처에 청구된다. 두 가지가 특히 위험하다.
//
//  · **별도 청구가 아닌 실비가 청구서에 오르는 것.** 기사 과실 주차위반처럼 지사가 부담하는
//    실비도 기록은 남긴다. 그게 정산서로 새면 없는 돈을 청구하게 된다.
//  · **어느 달에 들어가는가.** 실비 발생일로 묶으면 월말 오더의 톨게이트비만 다음 달 청구서로
//    넘어가서, 같은 운행의 요금과 실비가 서로 다른 청구서에 실린다. 그래서 오더를 따라간다.
//
// 저장 쪽(화면 → DB)도 함께 본다. 체크박스는 체크된 것만 전송되므로 값에 행 번호를 실어
// 어느 줄인지 가리는데, 그 규칙이 어긋나면 엉뚱한 줄이 "별도 청구"가 된다.
require('dotenv').config();
const db = require('../db');
const extraCharges = require('../lib/extraCharges');
const groupsRoute = require('../routes/groups');

const MARK = 'chk-extra';
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

// 남은 검사용 오더가 다음 실행의 청구액을 부풀린다. 실비는 오더에 딸려 지워진다(on delete cascade).
async function cleanup() {
  const rows = await db.all('SELECT id FROM orders WHERE oid LIKE ?', [`${MARK}%`]);
  for (const r of rows) {
    await db.run('DELETE FROM order_extra_charges WHERE order_id = ?', [r.id]);
    await db.run('DELETE FROM order_status_history WHERE order_id = ?', [r.id]);
    await db.run('DELETE FROM orders WHERE id = ?', [r.id]);
  }
}

(async () => {
  try {
    console.log('[화면에서 올라온 줄 거르기]');
    // 빈 줄을 저장하면 정산서에 0원짜리가 늘어선다.
    check('금액 0원인 줄은 버린다', extraCharges.parseRows({
      extra_charge_type: ['주유비'], extra_charge_amount: ['0'],
      extra_charge_date: ['2026-07-10'], extra_charge_billable: ['0'], extra_charge_note: [''],
    }, '2026-07-01').length, 0);
    // 예시로 '세차비'를 쓰고 있었는데 20260828 작업에서 정식 항목이 되었다 — 목록에 정말 없는
    // 이름으로 바꾼다. 항목이 늘어날 때 여기가 조용히 통과하면 오타가 그대로 저장된다.
    check('모르는 항목은 버린다', extraCharges.parseRows({
      extra_charge_type: ['식대'], extra_charge_amount: ['5000'],
      extra_charge_date: ['2026-07-10'], extra_charge_billable: ['0'], extra_charge_note: [''],
    }, '2026-07-01').length, 0);

    // 이번에 늘어난 두 항목이 실제로 저장 대상인지 — 요금설정에서 "제외"로 켰는데 저장이 안 되면
    // 설정만 있고 청구는 못 하는 상태가 된다.
    check('세차비는 정식 항목', extraCharges.EXTRA_CHARGE_TYPES.includes('세차비'), true);
    check('특수구간통행료는 정식 항목', extraCharges.EXTRA_CHARGE_TYPES.includes('특수구간통행료'), true);

    // 체크박스는 체크된 것만 올라온다 — 값에 행 번호를 실어 어느 줄인지 가린다.
    // 여기가 어긋나면 청구하지 않기로 한 줄이 청구된다.
    const parsed = extraCharges.parseRows({
      extra_charge_type: ['주유비', '주차요금', '톨게이트'],
      extra_charge_amount: ['50000', '3000', '4500'],
      extra_charge_date: ['2026-07-10', '', '잘못된날짜'],
      extra_charge_billable: ['0', '2'],
      extra_charge_note: ['', '지하주차장', ''],
    }, '2026-07-05');
    check('세 줄 모두 들어온다', parsed.length, 3);
    check('별도 청구는 0번·2번 줄만', parsed.map((r) => r.billable), [true, false, true]);
    // 일자를 안 넣으면 오더 예약일로 본다 — 매번 같은 날짜를 손으로 넣게 하면 안 넣는다.
    check('일자 비면 예약일', parsed[1].chargedOn, '2026-07-05');
    // 엉뚱한 날짜가 찍혀 다른 달 청구서에 들어가는 것보다 비는 편이 낫다 → 예약일로 떨어진다.
    check('형식이 깨진 일자도 예약일', parsed[2].chargedOn, '2026-07-05');
    check('넣은 일자는 그대로', parsed[0].chargedOn, '2026-07-10');

    console.log('[항목별 합계]');
    const summed = extraCharges.summarize([
      { charge_type: '주유비', amount: 50000 },
      { charge_type: '톨게이트', amount: 4500 },
      { charge_type: '톨게이트', amount: 5500 },
    ]);
    check('총합', summed.total, 60000);
    check('톨게이트 두 건', summed.byType['톨게이트'], { count: 2, amount: 10000 });
    // 건수가 0인 항목도 줄이 남아야 화면 합계표에서 빠진 항목이 보인다.
    check('없는 항목도 0으로 남는다', summed.byType['주차요금'], { count: 0, amount: 0 });

    await cleanup();
    const branch = await db.get('SELECT id FROM branches ORDER BY id LIMIT 1');
    const group = await db.get('SELECT id FROM groups_tbl ORDER BY id LIMIT 1');
    if (!branch || !group) {
      console.log('  (건너뜀 — 지사/법인 표본이 없습니다)');
      console.log('\n모두 통과');
      process.exit(0);
    }

    // 7월 31일 예약 → 7월 31일 완료. 톨게이트비는 8월 1일 새벽에 발생했다(밤샘 운행).
    const orderRow = await db.get(
      `INSERT INTO orders (oid, branch_id, requester_group_id, status, reserved_date, reserved_time,
                           vehicle_number, origin_address, destination_address, fare_amount, ferry_fare_amount)
       VALUES (?, ?, ?, '완료', '2026-07-31', '22:00', '12가3456', '서울 강남구 검사로 1', '경기 성남시', 100000, 0)
       RETURNING id`,
      [`${MARK}-1`, branch.id, group.id]
    );
    const orderId = Number(orderRow.id);
    await db.run(
      `INSERT INTO order_status_history (order_id, old_status, new_status, created_at)
       VALUES (?, '기사배정', '완료', '2026-07-31 23:40:00')`, [orderId]
    );

    await extraCharges.replaceForOrder(orderId, [
      { chargeType: '주유비', amount: 50000, chargedOn: '2026-07-31', billable: true, note: null },
      { chargeType: '톨게이트', amount: 4500, chargedOn: '2026-08-01', billable: true, note: '서해대교' },
      // 기사 과실 주차위반 — 지사가 부담한다. 기록은 남기되 청구서에는 오르면 안 된다.
      { chargeType: '주차요금', amount: 40000, chargedOn: '2026-07-31', billable: false, note: '기사 과실' },
    ], null);

    console.log('[정산내역에 들어가는 것]');
    const july = await groupsRoute.loadSettlement(group.id, '2026-07');
    const mine = july.extras.filter((r) => String(r.oid || '').startsWith(MARK));
    check('별도 청구 두 건만', mine.map((r) => r.charge_type), ['주유비', '톨게이트']);
    // 지사가 부담하는 실비가 새면 없는 돈을 청구하게 된다.
    check('별도 청구 아닌 것은 없다', mine.some((r) => r.amount === 40000), false);
    check('기타 합계', mine.reduce((s, r) => s + r.amount, 0), 54500);

    console.log('[목록에 필요한 칸이 다 있다 — 일자 / 차량번호 / 출발지 / 항목]');
    const toll = mine.find((r) => r.charge_type === '톨게이트');
    // 일자는 실제 발생일이다(오더 완료일이 아니라).
    check('일자는 발생일 그대로', toll.charged_on, '2026-08-01');
    check('차량번호', toll.vehicle_number, '12가3456');
    check('출발지', toll.origin_address, '서울 강남구 검사로 1');

    console.log('[어느 달에 들어가는가 — 오더를 따라간다]');
    // 8월 1일에 쓴 톨게이트비지만 오더가 7월에 끝났으므로 7월 청구서에 있어야 한다.
    // 발생일로 묶으면 같은 운행의 요금과 실비가 서로 다른 청구서로 갈린다.
    check('8월 발생 실비도 7월 정산에 있다', !!toll, true);
    const aug = await groupsRoute.loadSettlement(group.id, '2026-08');
    check('8월 정산에는 없다', aug.extras.some((r) => String(r.oid || '').startsWith(MARK)), false);

    console.log('[총 청구액 = 운행요금 + 기타]');
    const mineFare = july.items.filter((r) => String(r.oid || '').startsWith(MARK));
    check('운행요금 100,000원', mineFare.reduce((s, r) => s + r.total, 0), 100000);
    // 화면이 다시 더하지 않도록 서버에서 한 번만 계산한다 — 목록과 통계가 갈리면 안 된다.
    check('총 청구액이 둘의 합', july.grandTotal, july.summary.total + july.extraSummary.total);

    console.log('[다시 저장하면 통째로 갈아끼운다]');
    await extraCharges.replaceForOrder(orderId, [
      { chargeType: '주유비', amount: 30000, chargedOn: '2026-07-31', billable: true, note: null },
    ], null);
    const after = await extraCharges.loadForOrder(orderId);
    check('한 줄만 남는다', after.length, 1);
    check('금액이 새 값으로', Number(after[0].amount), 30000);
  } finally {
    await cleanup().catch(() => {});
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
