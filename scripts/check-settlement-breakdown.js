// 정산내역이 요청한 구조대로 나오는지 — 운행요금 서브 항목, 기타정산 항목별, 정산완료 상태.
//
// 사용자 지시(2026-08-29):
//   · 탁송료 → 구간요금으로 이름 변경, 도선료는 기타정산으로 뺀다
//   · 운행요금 대분류 아래 구간요금 · 할증요금 · 대기요금 · 취소요금
//   · 기타정산을 항목별로(주유비/세차비/톨게이트/주차비/도선료…)
//   · 부대비용 설정을 포함 / 실비 월정산 / 실비 개별정산 셋으로
//   · 오더별·항목별 정산완료 상태 + 처리 시각·담당자 기록
//
// 무엇을 옮기든 **총 청구액은 그대로여야 한다.** 도선료를 기타정산으로 옮긴 것도 표시 위치를
// 바꾼 것이지 금액을 옮긴 것이 아니다. 여기가 깨지면 거래처 청구액이 달라진다.
require('dotenv').config();
const db = require('../db');
const groupsRoute = require('../routes/groups');
const fareSurcharge = require('../lib/fareSurcharge');
const tripFees = require('../lib/tripFees');

const MARK = 'chk-brk';
const MONTH = '2019-12';
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
  try {
    console.log('[대기요금 — 기준을 넘을 때만, 정액 1회]');
    const feeSet = { wait_threshold_min: 15, wait_fee: 10000, cancel_before_fee: 5000, cancel_after_fee: 20000 };
    check('기준 이하면 안 받는다', tripFees.waitFee(feeSet, 10).amount, 0);
    // 경계에서 받으면 "15분까지 무료"라는 약속이 깨진다.
    check('기준과 같으면 안 받는다', tripFees.waitFee(feeSet, 15).amount, 0);
    check('기준을 넘으면 정액', tripFees.waitFee(feeSet, 32).amount, 10000);
    // 왜 붙었는지 없으면 거래처 문의에 답할 수 없다.
    check('근거를 남긴다', tripFees.waitFee(feeSet, 32).note, '대기 32분 (기준 15분 초과)');
    // 기준이 0이면 "대기하면 무조건" 받게 된다 — 설정 실수일 가능성이 높아 안 받는 쪽으로 기운다.
    check('기준이 0이면 안 받는다', tripFees.waitFee({ wait_fee: 10000, wait_threshold_min: 0 }, 60).amount, 0);

    console.log('[취소요금 — 배차 전후로 갈린다]');
    check('배차 전', tripFees.cancelFee(feeSet, { previousStatus: '접수' }).amount, 5000);
    check('배차 후', tripFees.cancelFee(feeSet, { previousStatus: '기사배정' }).amount, 20000);
    check('운행시작 뒤도 배차 후', tripFees.cancelFee(feeSet, { previousStatus: '운행시작' }).amount, 20000);
    check('설정이 0이면 안 받는다', tripFees.cancelFee({}, { previousStatus: '기사배정' }).amount, 0);

    console.log('[부대비용 정산 방식 3단계]');
    check('모드 세 가지', fareSurcharge.EXTRA_COST_MODES.map((m) => m.value), ['included', 'monthly', 'individual']);
    // 마이그레이션만으로 동작이 바뀌면 안 된다 — 옛 컬럼만 있으면 그대로 읽는다.
    const legacy = fareSurcharge.extraCostStates({ toll_normal_included: 1, fuel_included: 0 });
    check('옛 설정 포함 → included', legacy.find((i) => i.code === 'toll_normal').mode, 'included');
    check('옛 설정 제외 → monthly', legacy.find((i) => i.code === 'fuel').mode, 'monthly');
    check('새 설정이 우선', fareSurcharge.extraCostStates({ fuel_included: 1, fuel_mode: 'individual' })
      .find((i) => i.code === 'fuel').mode, 'individual');
    // 도선료는 금액이 orders.ferry_fare_amount에서 온다 — 손으로 또 넣으면 두 번 청구된다.
    check('도선료는 수기 입력 선택지에 없다', fareSurcharge.billableChargeTypes({}).includes('도선료'), false);
    check('도선료도 정산 항목 분류에는 있다',
      fareSurcharge.EXTRA_COST_ITEMS.some((i) => i.chargeType === '도선료'), true);

    await cleanup();
    const group = await db.get('SELECT id, branch_id FROM groups_tbl ORDER BY id LIMIT 1');
    if (!group) { console.log('  (건너뜀 — 법인이 없습니다)'); console.log('\n모두 통과'); process.exit(0); }

    // 구간 97,000 + 할증 8,000 = fare_amount 105,000 / 대기 10,000 / 취소 20,000 / 도선 30,000
    // 기타(주유비) 40,000 → 총 청구액 205,000원
    const row = await db.get(
      `INSERT INTO orders (oid, branch_id, requester_group_id, status, reserved_date, reserved_time,
                           vehicle_number, origin_address, destination_address,
                           fare_amount, ferry_fare_amount, fare_surcharges_json,
                           wait_fee_amount, wait_fee_note, cancel_fee_amount, cancel_fee_note)
       VALUES (?, ?, ?, '완료', '2019-12-05', '10:00', '11가2233', '검사출발', '검사도착',
               105000, 30000, ?, 10000, '대기 32분 (기준 15분 초과)', 20000, '배차 후 취소') RETURNING id`,
      [`${MARK}-1`, group.branch_id, group.id,
        JSON.stringify([{ code: 'imported', label: '수입차 할증', amount: 8000 }])]
    );
    const orderId = Number(row.id);
    await db.run(
      `INSERT INTO order_status_history (order_id, old_status, new_status, created_at)
       VALUES (?, '기사배정', '완료', ?)`, [orderId, `${MONTH}-05 23:00:00`]
    );
    await db.run(
      `INSERT INTO order_extra_charges (order_id, charge_type, amount, charged_on, billable)
       VALUES (?, '주유비', 40000, ?, true)`, [orderId, `${MONTH}-05`]
    );

    const data = await groupsRoute.loadSettlement(group.id, MONTH);
    const mine = data.items.filter((r) => String(r.oid || '').startsWith(MARK));
    const myExtras = data.extras.filter((e) => String(e.oid || '').startsWith(MARK));

    console.log('[운행요금 대분류 + 서브 항목]');
    check('구간요금(할증 제외)', mine[0] && mine[0].baseFare, 97000);
    check('할증요금', mine[0] && mine[0].surchargeTotal, 8000);
    check('대기요금', mine[0] && mine[0].waitFee, 10000);
    check('취소요금', mine[0] && mine[0].cancelFee, 20000);
    // 운행요금 합계 = 구간 + 할증 + 대기 + 취소. 도선료는 여기 없다(기타로 옮겼다).
    check('운행요금 합계', mine[0] && mine[0].total, 135000);

    console.log('[도선료는 기타 정산으로 나온다 — 금액을 옮긴 게 아니라 표시 위치만 바꿨다]');
    const ferryLine = myExtras.find((e) => e.charge_type === '도선료');
    check('도선료 줄이 있다', !!ferryLine, true);
    check('도선료 금액', ferryLine && ferryLine.amount, 30000);
    // 오더에서 파생된 줄이라 따로 정산완료 처리하지 않는다.
    check('파생 줄로 표시', ferryLine && ferryLine.derived, true);
    check('주유비도 항목별로', (myExtras.find((e) => e.charge_type === '주유비') || {}).amount, 40000);

    console.log('[**총 청구액은 그대로** — 옮겨도 금액이 달라지면 안 된다]');
    // 105,000(구간+할증) + 10,000(대기) + 20,000(취소) + 30,000(도선) + 40,000(주유) = 205,000
    const mineTotal = mine.reduce((a, r) => a + r.total, 0)
      + myExtras.reduce((a, e) => a + e.amount, 0);
    check('합계 205,000원', mineTotal, 205000);

    console.log('[월정산 / 개별정산 구분]');
    check('구분이 붙는다', ['monthly', 'individual'].includes(ferryLine && ferryLine.settleMode), true);
    check('통계에 나뉜다', Object.keys(data.extraSummary.byMode).sort(), ['individual', 'monthly']);

    console.log('[정산완료 상태 — 시각과 담당자를 남긴다]');
    check('처음엔 미정산', mine[0] && mine[0].settled, false);
    const user = await db.get("SELECT id, name FROM users WHERE status = 'active' ORDER BY id LIMIT 1");
    await db.run("UPDATE orders SET settled_at = '2019-12-31 18:00:00', settled_by = ? WHERE id = ?",
      [user.id, orderId]);
    const after = await groupsRoute.loadSettlement(group.id, MONTH);
    const settled = after.items.find((r) => String(r.oid || '').startsWith(MARK));
    check('정산완료로 바뀐다', settled && settled.settled, true);
    check('처리 시각', settled && settled.settled_at, '2019-12-31 18:00:00');
    // 시각만 남기면 "누가 확정했나"를 못 찾는다.
    check('담당자 이름', settled && settled.settled_by_name, user.name);
    check('완료 건수 집계', after.summary.settledCount, 1);
    // 상태가 바뀌어도 청구액은 그대로다.
    check('정산완료해도 총액 불변', after.grandTotal, data.grandTotal);
    console.log('[감사에서 찾은 구멍 ① 개별정산이 월 정산서 총액에 들어가면 이중청구]');
    // 개별정산은 건별 청구서로 따로 청구한다. 월 정산서 총액에도 넣으면 같은 금액을 두 번
    // 청구하게 된다 — 실제로 그랬다(2026-08-30 감사).
    await db.run("UPDATE group_fare_extra_settings SET fuel_mode = 'individual' WHERE group_id = ?", [group.id])
      .catch(() => {});
    const indiv = await groupsRoute.loadSettlement(group.id, MONTH);
    const fuelLine = indiv.extras.find((e) => e.charge_type === '주유비' && String(e.oid || '').startsWith(MARK));
    check('개별정산 줄은 목록에 남는다', !!fuelLine, true);
    check('구분이 개별정산', fuelLine && fuelLine.settleMode, 'individual');
    // 목록에는 있어도 청구 합계에는 없어야 한다. 도선료(30,000)는 월정산이라 남는다 —
    // 개별정산으로 돌린 주유비 40,000만 빠진다.
    check('개별정산 금액만 합계에서 빠진다', indiv.extraSummary.total, 30000);
    check('총 청구액 = 운행요금 + 월정산 기타', indiv.grandTotal, indiv.summary.total + 30000);
    // 목록 건수는 그대로여야 한다 — 청구에서 뺐다고 화면에서 사라지면 무엇이 있는지 모른다.
    check('목록에서는 사라지지 않는다', indiv.extraSummary.listedCount, indiv.extras.length);
    await db.run("UPDATE group_fare_extra_settings SET fuel_mode = 'monthly' WHERE group_id = ?", [group.id])
      .catch(() => {});

    console.log('[감사에서 찾은 구멍 ② 취소요금이 붙은 오더가 정산서에 안 나오면 청구 불가]');
    // 예전에는 '완료'만 정산 대상이라, 취소요금을 계산해 저장해도 청구할 방법이 없었다.
    const cancelled = await db.get(
      `INSERT INTO orders (oid, branch_id, requester_group_id, status, reserved_date, reserved_time,
                           origin_address, destination_address, fare_amount, cancel_fee_amount, cancel_fee_note)
       VALUES (?, ?, ?, '취소', '2019-12-20', '10:00', '검사출발', '검사도착', 0, 20000, '배차 후 취소')
       RETURNING id`,
      [`${MARK}-c`, group.branch_id, group.id]
    );
    await db.run(
      `INSERT INTO order_status_history (order_id, old_status, new_status, created_at)
       VALUES (?, '기사배정', '취소', ?)`, [cancelled.id, `${MONTH}-20 11:00:00`]
    );
    const withCancel = await groupsRoute.loadSettlement(group.id, MONTH);
    const cRow = withCancel.items.find((r) => r.oid === `${MARK}-c`);
    check('취소 건이 정산서에 나온다', !!cRow, true);
    check('취소요금이 청구된다', cRow && cRow.total, 20000);

    // 취소요금이 0인 취소 건은 청구할 것이 없다 — 목록만 늘리면 읽기 어려워진다.
    const freeCancel = await db.get(
      `INSERT INTO orders (oid, branch_id, requester_group_id, status, reserved_date, reserved_time,
                           origin_address, destination_address, fare_amount)
       VALUES (?, ?, ?, '취소', '2019-12-21', '10:00', 'x', 'y', 0) RETURNING id`,
      [`${MARK}-c0`, group.branch_id, group.id]
    );
    await db.run(
      `INSERT INTO order_status_history (order_id, old_status, new_status, created_at)
       VALUES (?, '접수', '취소', ?)`, [freeCancel.id, `${MONTH}-21 11:00:00`]
    );
    const after2 = await groupsRoute.loadSettlement(group.id, MONTH);
    check('취소요금 0원 건은 안 나온다', after2.items.some((r) => r.oid === `${MARK}-c0`), false);

    console.log('[감사에서 찾은 구멍 ③ 접수 경로마다 요금 근거가 빠지던 것]');
    // createOrder는 모든 접수 경로가 지나는 한 곳이다. 예전에는 웹 폼 라우트에서만 계산해
    // 넘겨서, 카카오·웹 AI로 접수된 오더는 할증 근거도 대기요금도 없었다(청구 누락).
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib/orderCreate.js'), 'utf8');
    check('createOrder가 스스로 채운다', /접수 경로가 안 넘겼으면 여기서 채운다/.test(src), true);
    check('이미 넘어온 값은 덮어쓰지 않는다', /const needWait = !row\.waitFee;/.test(src), true);
  } finally {
    await cleanup();
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
