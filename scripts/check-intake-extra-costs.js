// 접수 단계 부대비용 — 항목 정의, 파싱, 저장, 정산 반영을 못 박는다.
//
// 이 기능의 위험은 전부 "청구"에 있다. 잘못 저장되면 안 받거나 두 번 받는다:
//   - 금액 미정('가득') 줄이 정산서에 0원으로 올라가면 받는 쪽이 무엇을 청구받는지 모른다
//   - 도선료가 order_extra_charges에도 줄로 생기면 ferry_fare_amount와 겹쳐 두 번 청구된다
//   - 저장할 때 통째로 갈아끼우면 관리자가 넣은 톨게이트 줄이 같이 지워진다
// 셋 다 화면을 봐서는 안 보이므로 여기서 확인한다.
require('dotenv').config();
const db = require('../db');
const extraCharges = require('../lib/extraCharges');
const fareSurcharge = require('../lib/fareSurcharge');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`}`);
}

const MARK = 'zzq부대비용검사';

(async () => {
  let orderId = null;
  try {
    console.log('[항목 정의]');
    const labels = extraCharges.INTAKE_EXTRA_ITEMS.map((it) => it.label);
    // 뒤 셋(도선료·대기요금·취소요금)은 줄이 아니라 orders 컬럼에 저장된다 — 순서까지 못 박는
    // 이유는 화면이 "첫 항목"을 기본값으로 쓰기 때문이다(주유비가 앞이라야 자연스럽다).
    check('접수에서 고를 수 있는 항목', labels,
      ['주유비', '충전비', '세차비', '주차비', '도선료', '대기요금', '취소요금']);
    check('orders 컬럼에 저장되는 항목',
      extraCharges.INTAKE_EXTRA_ITEMS.filter((it) => it.orderColumn).map((it) => it.orderColumn),
      ['ferry', 'wait', 'cancel']);
    // 충전비는 이번에 추가한 항목이다. 요금설정에 안 뜨면 정산구분을 정할 수 없다.
    check('충전비가 요금설정 항목에도 있다',
      fareSurcharge.EXTRA_COST_ITEMS.some((it) => it.chargeType === '충전비'), true);
    check('충전비는 기본이 청구 가능', fareSurcharge.billableChargeTypes({}).includes('충전비'), true);
    const fuel = extraCharges.intakeItem('주유비');
    check('주유비 선택지는 가득/금액입력', fuel.options.map((o) => o.value), ['full', 'amount']);
    check('세차비 선택지는 자동/손세차',
      extraCharges.intakeItem('세차비').options.map((o) => o.value), ['auto_wash', 'hand_wash']);
    check('주차비는 선택지 없음', extraCharges.intakeItem('주차요금').options.length, 0);
    // 도선료를 두 줄 만들면 ferry_fare_amount와 합쳐 두 번 청구된다.
    check('도선료는 한 줄만', extraCharges.intakeItem('도선료').single, true);

    console.log('[오더구분별 대기 · 취소요금]');
    const tripFees = require('../lib/tripFees');
    // 탁송 기준 값이 시간제 오더에 새어 들어오면 받지 말아야 할 돈을 받는다(사용자 지적).
    const dispatchOnly = { wait_fee: 10000, wait_threshold_min: 15, cancel_before_fee: 5000, cancel_after_fee: 20000 };
    check('탁송은 탁송 칸을 읽는다', tripFees.waitFee(dispatchOnly, 40, 'dispatch').amount, 10000);
    check('프리미엄에 탁송 대기요금이 안 붙는다', tripFees.waitFee(dispatchOnly, 40, 'premium').amount, 0);
    check('일일기사에 탁송 대기요금이 안 붙는다', tripFees.waitFee(dispatchOnly, 40, 'daily_driver').amount, 0);
    check('프리미엄에 탁송 취소요금이 안 붙는다',
      tripFees.cancelFee(dispatchOnly, { previousStatus: '기사배정', orderType: 'premium' }).amount, 0);

    const perType = {
      ...dispatchOnly,
      premium_wait_fee: 7000, premium_wait_threshold_min: 30,
      premium_cancel_before_fee: 3000, premium_cancel_after_fee: 15000,
      daily_wait_fee: 8000, daily_wait_threshold_min: 60,
    };
    check('프리미엄은 자기 칸을 읽는다', tripFees.waitFee(perType, 40, 'premium').amount, 7000);
    // 기준이 60분인데 40분이면 아직 안 넘었다 — 오더구분마다 기준이 다르다는 것이 요구사항의 핵심이다.
    check('일일기사는 자기 기준을 쓴다', tripFees.waitFee(perType, 40, 'daily_driver').amount, 0);
    check('일일기사 기준을 넘으면 붙는다', tripFees.waitFee(perType, 90, 'daily_driver').amount, 8000);

    // 탁송은 배차 기준, 프리미엄/일일기사는 도착 기준(사용자 지시).
    check('탁송: 기사배정이면 배차 후',
      tripFees.cancelFee(perType, { previousStatus: '기사배정', orderType: 'dispatch' }),
      { amount: 20000, note: '배차 후 취소' });
    // 프리미엄은 기사가 배정돼도 아직 도착 전일 수 있다 — 배정만으로 도착 후 요금을 받으면 과청구다.
    check('프리미엄: 기사배정은 아직 도착 전',
      tripFees.cancelFee(perType, { previousStatus: '기사배정', orderType: 'premium' }),
      { amount: 3000, note: '도착 전 취소' });
    check('프리미엄: 운행시작이면 도착 후',
      tripFees.cancelFee(perType, { previousStatus: '운행시작', orderType: 'premium' }),
      { amount: 15000, note: '도착 후 취소' });
    // hadDriver(기사 배정됨)도 프리미엄에서는 도착 근거가 못 된다.
    check('프리미엄: hadDriver로는 도착 후가 안 된다',
      tripFees.cancelFee(perType, { hadDriver: true, previousStatus: '접수', orderType: 'premium' }).amount, 3000);
    // 오더구분이 없으면 탁송으로 본다 — 기존 데이터가 그렇다.
    check('오더구분이 비면 탁송', tripFees.waitFee(dispatchOnly, 40, null).amount, 10000);

    console.log('[파싱]');
    const feeExtra = { fuel_mode: 'individual', wash_mode: 'included' };
    const parsed = extraCharges.parseIntakeRows({
      intake_extra_type: ['주유비', '세차비', '도선료', '없는항목'],
      intake_extra_option: ['full', 'hand_wash', '', ''],
      intake_extra_amount: ['0', '30000', '12000', '5000'],
      intake_extra_mode: ['', 'monthly', '', ''],
      intake_extra_id: ['', '', '', ''],
      intake_extra_known_id: ['7'],
    }, feeExtra, '2019-12-24');
    check('모르는 항목은 버린다', parsed.rows.length, 2);
    // 비워두면 요금설정을 따른다 — 사용자 지시("설정값을 기본값으로 가져오되 수정 가능").
    check('정산구분을 안 보내면 설정값', parsed.rows[0].settleMode, 'individual');
    check('보냈으면 그 값', parsed.rows[1].settleMode, 'monthly');
    // '가득'은 접수 시점에 금액을 모른다. 줄을 버리면 청구할 근거가 사라진다.
    check('가득은 금액 0이어도 남는다', parsed.rows[0].amount, 0);
    check('무엇을 하기로 했는지 코드로 남는다', parsed.rows[0].optionCode, 'full');
    // 세차비에 '가득'이 오면 그 항목 선택지가 아니다 — 조용히 버려야 엉뚱한 값이 안 남는다.
    check('항목에 없는 선택지는 버린다',
      extraCharges.parseIntakeRows({ intake_extra_type: ['세차비'], intake_extra_option: ['full'] }, {}, null).rows[0].optionCode, null);
    check('도선료는 줄이 아니라 따로 나온다', parsed.ferry, { amount: 12000, settleMode: 'monthly' });
    check('도선료가 줄 목록에는 없다', parsed.rows.some((r) => r.chargeType === '도선료'), false);
    check('화면이 들고 있던 id를 같이 받는다', parsed.knownIds, [7]);
    // 포함(청구불가)을 청구 대상으로 켜두면 기본요금에 이미 든 돈을 또 받는다.
    const inc = extraCharges.parseIntakeRows({
      intake_extra_type: ['주차요금'], intake_extra_mode: ['included'],
    }, {}, null);
    check('포함은 청구하지 않는다', inc.rows[0].billable, false);

    console.log('[대기 · 취소요금을 부대비용에서 직접 입력]');
    const adminFees = extraCharges.parseIntakeRows({
      intake_extra_type: ['대기요금', '취소요금'],
      intake_extra_amount: ['12000', '0'],
    }, {}, null);
    // 둘 다 orders 컬럼에 저장된다 — 줄로도 만들면 같은 돈이 두 군데서 집계돼 두 번 청구된다.
    check('대기·취소요금은 줄을 만들지 않는다', adminFees.rows.length, 0);
    check('대기요금은 orders 컬럼으로 간다', adminFees.orderFees.wait, { amount: 12000, settleMode: 'monthly' });
    // 0을 넣었다면 "이 건은 안 받는다"는 관리자의 판단이다 — 무시하면 자동 계산이 다시 붙는다.
    check('0원도 기록한다', adminFees.orderFees.cancel.amount, 0);
    const waitItem = extraCharges.intakeItem('대기요금');
    check('정산구분 칸을 두지 않는다', waitItem.noSettleMode, true);
    check('한 오더에 하나뿐', waitItem.single, true);

    console.log('[저장]');
    const order = await db.get(
      `SELECT id, branch_id, requester_group_id FROM orders
        WHERE branch_id IS NOT NULL ORDER BY id DESC LIMIT 1`);
    if (!order) { console.log('  건너뜀 — 오더가 없다'); }
    else {
      const made = await db.get(
        `INSERT INTO orders (oid, branch_id, requester_group_id, status, reserved_date, reserved_time,
                             origin_address, destination_address, fare_amount)
         VALUES (?, ?, ?, '오더등록', '2019-12-24', '10:00', 'x', 'y', 0) RETURNING id`,
        [MARK, order.branch_id, order.requester_group_id]
      );
      orderId = made.id;
      // 관리자가 오더상세에서 넣은 줄 — 접수 화면이 이걸 지우면 안 된다.
      await db.run(
        `INSERT INTO order_extra_charges (order_id, charge_type, amount, billable) VALUES (?, '톨게이트', 4800, true)`,
        [orderId]
      );
      await extraCharges.saveIntakeRows(orderId, parsed, null);
      const saved = await extraCharges.loadForOrder(orderId);
      check('접수 줄 2개 + 관리자 줄 1개', saved.length, 3);
      check('관리자가 넣은 톨게이트는 살아있다', saved.some((r) => r.charge_type === '톨게이트'), true);
      const fuelRow = saved.find((r) => r.charge_type === '주유비');
      check('선택지가 저장된다', fuelRow.option_code, 'full');
      // 청구한 뒤 요금설정이 바뀌어도 이미 접수한 건의 구분이 따라 바뀌면 안 된다.
      check('정산구분이 줄에 박힌다', fuelRow.settle_mode, 'individual');

      await extraCharges.saveOrderFeeFields(orderId, { wait: { amount: 12000 }, cancel: { amount: 0 } });
      const o = await db.get('SELECT wait_fee_amount, cancel_fee_amount, wait_fee_note FROM orders WHERE id = ?', [orderId]);
      check('대기요금이 orders에 박힌다', o.wait_fee_amount, 12000);
      check('왜 그 금액인지 남는다', o.wait_fee_note, '관리자 입력');
      // null이 아니라 0이라야 applyCancelFee가 덮어쓰지 않는다 — 관리자의 "안 받음"이 유지된다.
      check('0원도 null이 아니다', o.cancel_fee_amount, 0);
      const backWith = await extraCharges.loadIntakeRows(orderId);
      check('수정 화면에 대기요금이 다시 보인다',
        backWith.some((r) => r.chargeType === '대기요금' && r.amount === 12000), true);
      await db.run('UPDATE orders SET wait_fee_amount = NULL, cancel_fee_amount = NULL WHERE id = ?', [orderId]);

      const rows = await extraCharges.loadIntakeRows(orderId);
      check('수정 화면에는 접수 항목만 돌려준다', rows.length, 2);
      check('톨게이트는 안 돌려준다', rows.some((r) => r.chargeType === '톨게이트'), false);

      // 화면에서 세차비 줄을 지우고 저장 — 그 줄만 사라져야 한다.
      const keep = rows.filter((r) => r.chargeType === '주유비');
      await extraCharges.saveIntakeRows(orderId, {
        rows: keep.map((r) => ({ ...r, billable: true, chargedOn: null })),
        ferry: null,
        knownIds: rows.map((r) => r.id),
      }, null);
      const after = await extraCharges.loadForOrder(orderId);
      check('지운 줄만 사라진다', after.map((r) => r.charge_type).sort(), ['주유비', '톨게이트']);

      console.log('[정산 반영]');
      const groupsRoute = require('../routes/groups');
      // 금액 0인 줄이 정산서에 오르면 받는 쪽이 무엇을 청구받는지 알 수 없다.
      const s1 = await groupsRoute.loadSettlement(order.requester_group_id, '2019-12');
      check('금액 미정 줄은 정산서에 안 나온다',
        s1.extras.some((e) => e.oid === MARK), false);
      await db.run(`UPDATE order_extra_charges SET amount = 90000 WHERE order_id = ? AND charge_type = '주유비'`, [orderId]);
      await db.run(
        `INSERT INTO order_status_history (order_id, old_status, new_status, created_at)
         VALUES (?, '오더등록', '완료', '2019-12-24 11:00:00')`, [orderId]);
      await db.run(`UPDATE orders SET status = '완료' WHERE id = ?`, [orderId]);
      const s2 = await groupsRoute.loadSettlement(order.requester_group_id, '2019-12');
      const line = s2.extras.find((e) => e.oid === MARK && e.charge_type === '주유비');
      check('금액이 채워지면 나타난다', !!line, true);
      // 줄에 박아둔 개별정산이 요금설정보다 우선해야 한다 — 안 그러면 월 총액에 섞여 두 번 청구된다.
      check('줄에 박아둔 정산구분을 따른다', line && line.settleMode, 'individual');
    }
  } finally {
    if (orderId) {
      await db.run('DELETE FROM order_extra_charges WHERE order_id = ?', [orderId]).catch(() => {});
      await db.run('DELETE FROM order_status_history WHERE order_id = ?', [orderId]).catch(() => {});
      await db.run('DELETE FROM orders WHERE id = ?', [orderId]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
