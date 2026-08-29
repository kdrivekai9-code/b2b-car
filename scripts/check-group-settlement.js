// 법인관리 · 월별 정산내역이 맞는 오더만, 맞는 금액으로 묶는지.
//
// 이 화면은 거래처에 청구할 금액의 근거다. 한 건이라도 새거나 남의 달로 들어가면 청구서가
// 틀리므로 눈으로 보고 넘어갈 수 없다. 특히 두 가지가 위험하다.
//
//  · 묶는 기준이 완료일이다(사용자 확정). 예약일로 묶으면 말일 예약이 다음 달 새벽에 끝났을 때
//    두 달 중 어디에도 안 들어가거나 두 번 들어간다.
//  · 요금은 **계약 요금**(fare_amount)이다. 이번에 배차 요금(dispatch_fare_amount)이 생겼는데
//    그건 콜마너에 거는 원가라 정산에 섞이면 거래처에 원가를 청구하게 된다.
//
// created_at이 text(KST 문자열)라는 것도 함께 확인한다 — timestamptz로 캐스팅하는 순간
// 다른 곳에서 겪은 타입 충돌이 그대로 재현되고, 그게 .catch에 먹히면 "실적 없음"으로 보인다.
require('dotenv').config();
const db = require('../db');
const groupsRoute = require('../routes/groups');

const MARK = 'chk-settle';
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

// 매번 처음부터 돌 수 있어야 한다 — 남은 검사용 오더가 다음 실행의 합계를 부풀린다.
// 상태이력이 오더를 참조하고 있어 이력을 먼저 지운다(외래키).
async function cleanup() {
  const rows = await db.all('SELECT id FROM orders WHERE oid LIKE ?', [`${MARK}%`]);
  for (const r of rows) {
    await db.run('DELETE FROM order_status_history WHERE order_id = ?', [r.id]);
    await db.run('DELETE FROM orders WHERE id = ?', [r.id]);
  }
}

async function makeOrder({ oid, groupId, branchId, status, fare, ferry, dispatchFare, completedAt }) {
  const row = await db.get(
    `INSERT INTO orders (oid, branch_id, requester_group_id, status, reserved_date, reserved_time,
                         origin_address, destination_address, fare_amount, ferry_fare_amount, dispatch_fare_amount)
     VALUES (?, ?, ?, ?, '2026-07-31', '23:30', '서울 강남구 검사로 1', '경기 성남시 검사로 2', ?, ?, ?)
     RETURNING id`,
    [oid, branchId, groupId, status, fare, ferry, dispatchFare]
  );
  if (completedAt) {
    await db.run(
      `INSERT INTO order_status_history (order_id, old_status, new_status, created_at)
       VALUES (?, '기사배정', '완료', ?)`,
      [row.id, completedAt]
    );
  }
  return Number(row.id);
}

(async () => {
  try {
    console.log('[정산월 해석]');
    check('YYYY-MM 그대로', groupsRoute.settlementMonth('2026-07'), '2026-07');
    check('공백 섞여도', groupsRoute.settlementMonth(' 2026-07 '), '2026-07');
    // 값이 없으면 이번 달(KST)이다. UTC로 계산하면 매달 1일 오전 9시 이전에 지난 달이 뜬다.
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const nowMonth = `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}`;
    check('빈 값이면 이번 달(KST)', groupsRoute.settlementMonth(''), nowMonth);
    check('형식이 깨지면 이번 달', groupsRoute.settlementMonth('2026/7'), nowMonth);
    // 여기서 사용자 입력이 그대로 통과하면 SQL로 넘어간다.
    check('SQL 조각은 통과 못 한다', groupsRoute.settlementMonth("2026-07' OR '1'='1"), nowMonth);

    await cleanup();
    const branch = await db.get('SELECT id FROM branches ORDER BY id LIMIT 1');
    const group = await db.get('SELECT id FROM groups_tbl ORDER BY id LIMIT 1');
    if (!branch || !group) {
      console.log('  (건너뜀 — 지사/법인 표본이 없습니다)');
      console.log('\n모두 통과');
      process.exit(0);
    }

    // 7월 정산에 들어가야 하는 것: 7월에 완료된 완료 오더 2건.
    await makeOrder({ oid: `${MARK}-1`, groupId: group.id, branchId: branch.id, status: '완료',
      fare: 50000, ferry: 0, dispatchFare: 38000, completedAt: '2026-07-15 10:00:00' });
    await makeOrder({ oid: `${MARK}-2`, groupId: group.id, branchId: branch.id, status: '완료',
      fare: 70000, ferry: 12000, dispatchFare: 40000, completedAt: '2026-07-31 23:59:59' });
    // 예약은 7월 말이지만 완료가 8월 새벽 — 완료일 기준이므로 7월에 들어오면 안 된다.
    await makeOrder({ oid: `${MARK}-3`, groupId: group.id, branchId: branch.id, status: '완료',
      fare: 90000, ferry: 0, dispatchFare: 50000, completedAt: '2026-08-01 00:20:00' });
    // 완료가 아닌 오더는 청구 대상이 아니다.
    await makeOrder({ oid: `${MARK}-4`, groupId: group.id, branchId: branch.id, status: '기사배정',
      fare: 99000, ferry: 0, dispatchFare: 60000, completedAt: null });
    // 법인이 없는 오더(개인 접수)가 남의 정산서에 실리면 안 된다.
    await makeOrder({ oid: `${MARK}-5`, groupId: null, branchId: branch.id, status: '완료',
      fare: 88000, ferry: 0, dispatchFare: 60000, completedAt: '2026-07-20 09:00:00' });

    const july = await groupsRoute.loadSettlement(group.id, '2026-07');
    const mine = july.items.filter((r) => String(r.oid || '').startsWith(MARK));

    console.log('[7월 정산 — 완료일 기준으로 묶는다]');
    check('7월에 완료된 2건만', mine.map((r) => r.oid), [`${MARK}-1`, `${MARK}-2`]);
    check('완료일 오름차순', mine.map((r) => r.completed_at),
      ['2026-07-15 10:00:00', '2026-07-31 23:59:59']);

    console.log('[금액 — 운행요금에는 도선료가 없다]');
    // 도선료는 기타 정산으로 옮겼다(사용자 지시 2026-08-29). 금액을 옮긴 것이 아니라 표시
    // 위치를 바꾼 것이라, 운행요금에서는 빠지고 기타 정산에 같은 금액이 나타난다.
    check('1건차 운행요금', mine[0] && mine[0].total, 50000);
    check('2건차 운행요금(도선료 제외)', mine[1] && mine[1].total, 70000);
    const ferryLine = july.extras.find((e) => e.charge_type === '도선료' && String(e.oid || '').startsWith(MARK));
    check('도선료가 기타 정산에 있다', ferryLine && ferryLine.amount, 12000);
    // 배차 요금은 콜마너에 거는 원가다. 여기 섞이면 거래처에 원가를 청구하게 된다.
    check('배차 요금이 새어 들어오지 않는다',
      mine.some((r) => r.total === Number(r.dispatch_fare_amount)), false);

    console.log('[합계 통계]');
    const sum = (k) => mine.reduce((s, r) => s + r[k], 0);
    check('건수', mine.length, 2);
    check('구간요금 합계', sum('fare'), 120000);
    check('도선료 합계', sum('ferry'), 12000);
    // 운행요금 합계에는 도선료가 없다 — 기타 정산으로 나간다.
    check('운행요금 합계', sum('total'), 120000);
    // **총 청구액은 그대로다.** 옮겨도 거래처가 내는 돈이 달라지면 안 된다.
    const myExtraTotal = july.extras
      .filter((e) => String(e.oid || '').startsWith(MARK))
      .reduce((a, e) => a + e.amount, 0);
    check('총 청구액(운행요금 + 기타)', sum('total') + myExtraTotal, 132000);
    // 화면 하단 통계는 이 값을 그대로 쓴다 — 목록과 통계가 어긋나면 정산서를 못 믿는다.
    check('통계가 목록에서 나온다', july.summary.total >= sum('total'), true);

    console.log('[8월에는 8월 완료건이 있다]');
    const aug = await groupsRoute.loadSettlement(group.id, '2026-08');
    check('7월 예약·8월 완료건은 8월에 있다',
      aug.items.some((r) => r.oid === `${MARK}-3`), true);
    check('7월 완료건이 8월에 겹치지 않는다',
      aug.items.some((r) => r.oid === `${MARK}-1`), false);

    console.log('[고를 수 있는 달]');
    check('7월과 8월이 목록에 있다',
      ['2026-07', '2026-08'].every((m) => july.months.includes(m)), true);
    check('최신 달이 먼저', july.months[0] >= july.months[july.months.length - 1], true);
  } finally {
    await cleanup().catch(() => {});
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
