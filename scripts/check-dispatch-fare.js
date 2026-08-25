// 배차 요금이 계약 요금과 확실히 분리돼 있는지.
//
// 요금 체계가 둘로 갈렸다(사용자 지시 2026-08-25).
//   · 계약 요금(fare_rules / group_fare_rules) — 거래처에 청구하는 값. 고객 요금안내·정산내역.
//   · 배차 요금(branch_dispatch_fare_rules) — 콜마너에 걸어 기사를 붙이는 값.
//
// 둘을 나눈 이유가 "계약 단가를 올리지 않고 배차만 서두른다"이므로, 한쪽이 다른 쪽으로 새면
// 기능 자체가 무의미해진다. 특히 콜마너 페이로드에 계약 요금이 들어가면 계약 단가가 그대로
// 기사에게 노출된다 — 눈으로 확인하고 넘어갈 수 있는 종류의 실수가 아니다.
//
// 배차 요금표를 등록하지 않은 지사는 값이 비어야 한다. 계약 요금으로 대체하는 폴백을 넣으면
// 위 노출이 조용히 되살아난다.
require('dotenv').config();
const db = require('../db');
const branchPolicy = require('../lib/branchPolicy');
const callmaner = require('../lib/callmaner');

const MARK_BRANCH = 'chk-dispatch-fare';
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

// 검사용 지사를 만들고 지운다 — 실사용 지사의 요금표를 건드리면 그 지사의 배차가 바뀐다.
async function cleanup() {
  const rows = await db.all('SELECT id FROM branches WHERE code = ?', [MARK_BRANCH]);
  for (const r of rows) {
    await db.run('DELETE FROM branch_dispatch_fare_rules WHERE branch_id = ?', [r.id]);
    await db.run('DELETE FROM branches WHERE id = ?', [r.id]);
  }
}

// 좌표·행정구역이 있어야 페이로드가 만들어진다(없으면 buildOrderPayload가 던진다).
function sampleOrder(extra) {
  return {
    oid: 'chk-1', order_type: '탁송',
    origin_lat: 37.5, origin_lon: 127.0, origin_sido: '서울', origin_sigugun: '강남구', origin_dong: '역삼동',
    destination_lat: 37.4, destination_lon: 127.1, destination_sido: '경기', destination_sigugun: '성남시', destination_dong: '삼평동',
    reserved_date: '2026-08-30', reserved_time: '10:00',
    origin_contact_phone: '01012345678',
    ...extra,
  };
}

(async () => {
  try {
    await cleanup();

    console.log('[배차 요금표가 없으면 값이 비어야 한다]');
    const branchRow = await db.get(
      'INSERT INTO branches (code, name) VALUES (?, ?) RETURNING id', [MARK_BRANCH, MARK_BRANCH]
    );
    const branchId = Number(branchRow.id);
    // 계약 요금으로 대체하는 폴백이 생기면 여기가 깨진다.
    check('요금표 미등록 지사', await branchPolicy.calculateDispatchFare(branchId, 10), { enabled: false });
    check('지사가 없으면', await branchPolicy.calculateDispatchFare(null, 10), { enabled: false });

    console.log('[구간표대로 계산한다]');
    // 기본 10km 30,000원 + 초과 1km당 800원.
    await db.run(
      `INSERT INTO branch_dispatch_fare_rules
         (branch_id, tier_seq, base_distance_km, base_fare, surcharge_fare, surcharge_unit_km, round_unit, round_method)
       VALUES (?, 1, 10, 30000, 800, 1, 1000, 'round')`,
      [branchId]
    );
    check('기본거리 이내', (await branchPolicy.calculateDispatchFare(branchId, 8)).fare, 30000);
    check('기본거리 정확히', (await branchPolicy.calculateDispatchFare(branchId, 10)).fare, 30000);
    // 10km 초과 10km × 800 = 8,000원 → 38,000원.
    check('기본거리 초과', (await branchPolicy.calculateDispatchFare(branchId, 20)).fare, 38000);

    console.log('[콜마너에 거는 금액은 배차 요금이다]');
    const withDispatch = await callmaner.buildOrderPayload(
      sampleOrder({ fare_amount: 120000, dispatch_fare_amount: 38000 }), '현금', []
    );
    // 계약 요금 120,000원이 여기 들어가면 계약 단가가 기사에게 그대로 노출된다.
    check('price는 배차 요금', withDispatch.price, '38000');
    check('현금 결제액도 배차 요금', withDispatch.use_cash, '38000');
    check('계약 요금은 어디에도 없다',
      JSON.stringify(withDispatch).includes('120000'), false);

    const postpaid = await callmaner.buildOrderPayload(
      sampleOrder({ fare_amount: 120000, dispatch_fare_amount: 38000 }), '후불', []
    );
    check('후불도 배차 요금', postpaid.post_charge, '38000');
    check('후불 결제액도 배차 요금', postpaid.use_cb, '38000');

    console.log('[배차 요금이 없으면 0을 보낸다 — 계약 요금으로 되돌리지 않는다]');
    for (const [label, value] of [['null', null], ['0', 0], ['빈 문자열', '']]) {
      const rq = await callmaner.buildOrderPayload(
        sampleOrder({ fare_amount: 120000, dispatch_fare_amount: value }), '현금', []
      );
      check(`배차 요금 ${label}`, rq.price, '0');
      check(`배차 요금 ${label} — 계약 요금 미노출`, JSON.stringify(rq).includes('120000'), false);
    }
  } finally {
    await cleanup().catch(() => {});
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
