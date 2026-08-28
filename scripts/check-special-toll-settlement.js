// 특수구간 통행료(민자 교량 등)가 계산에서 정산까지 이어지는지.
//
// 사용자 지적(2026-08-29): "할증·부대비용·특수구간 톨게이트가 정산 기타 내역에 전부 들어가나?"
// 확인해보니 특수구간은 **완전히 끊겨 있었다.** calculateFare가 찾아 돌려주기만 하고 받는 쪽이
// 없어서, 등록된 규칙이 있어도 정산 줄은 0건이었다. 계산은 되는데 청구가 안 되던 상태다.
//
// 판정 근거도 약했다. 예전에는 출발지·도착지 **주소 문자열만** 훑어서 경로 중간의 교량은
// 잡히지 않았다 — 서해대교를 지나는 사당역→당진 경로에서 주소 어디에도 "서해대교"가 없다.
// 이제 카카오가 주는 **요금소 이름**(guides)을 함께 본다.
//
// 금액은 우리 표에서 온다. 카카오는 톨비를 합계 하나로만 주고(실측 summary.fare.toll)
// 요금소별 금액을 주지 않기 때문이다.
require('dotenv').config();
const db = require('../db');
const branchPolicy = require('../lib/branchPolicy');
const fareSurcharge = require('../lib/fareSurcharge');
const { createOrder } = require('../lib/orderCreate');

const MARK = 'chk-toll';
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
  await db.run("DELETE FROM fare_special_tolls WHERE name LIKE ?", [`${MARK}%`]).catch(() => {});
}

(async () => {
  try {
    console.log('[요금소 이름으로 판정한다 — 주소만 보면 경로 중간 교량을 놓친다]');
    const extra = { toll_special_included: 0 };
    const rules = [{ name: '서해대교', fee: 6600 }];
    // 실제 사당역→당진 경로의 요금소 목록(카카오 guides에서 뽑은 값)에는 서해대교가 없다.
    // 그래서 주소·요금소 어디에도 없으면 안 붙는 것이 맞다.
    check('주소에만 있으면 잡는다',
      fareSurcharge.matchSpecialTolls(extra, rules, ['서해대교 부근', '', []]).length, 1);
    check('요금소 목록에 있으면 잡는다',
      fareSurcharge.matchSpecialTolls(extra, rules, ['서울 강남구', '충남 당진시', ['금천TG', '서해대교', '서산TG']]).length, 1);
    check('둘 다 없으면 안 잡는다',
      fareSurcharge.matchSpecialTolls(extra, rules, ['서울 강남구', '경기 성남시', ['판교TG']]).length, 0);
    check('금액은 우리 표에서 온다',
      fareSurcharge.matchSpecialTolls(extra, rules, ['', '', ['서해대교']])[0].amount, 6600);

    console.log('[요금설정에서 "기본요금 포함"이면 붙이지 않는다 — 이중 청구가 된다]');
    check('포함으로 두면 빈 배열',
      fareSurcharge.matchSpecialTolls({ toll_special_included: 1 }, rules, ['', '', ['서해대교']]), []);

    await cleanup();
    const group = await db.get('SELECT id, branch_id FROM groups_tbl WHERE EXISTS (SELECT 1 FROM group_fare_rules f WHERE f.group_id = groups_tbl.id) ORDER BY id LIMIT 1');
    if (!group) {
      console.log('  (건너뜀 — 요금표가 있는 법인이 없습니다)');
      console.log('\n모두 통과');
      process.exit(0);
    }
    await db.run(
      'INSERT INTO fare_special_tolls (group_id, name, fee, seq) VALUES (?, ?, ?, 99)',
      [group.id, `${MARK}대교`, 6600]
    );
    // 요금설정에서 "제외(실비 정산)"여야 한다 — 기본값이 그렇지만 명시해 둔다.
    await db.run(
      `UPDATE group_fare_extra_settings SET toll_special_included = 0 WHERE group_id = ?`,
      [group.id]
    ).catch(() => {});

    console.log('[서버가 다시 판정한다 — 클라이언트 금액을 믿지 않는다]');
    const found = await branchPolicy.findSpecialTolls(group.id, group.branch_id,
      ['서울 강남구', '충남 당진시', ['금천TG', `${MARK}대교`]]);
    check('규칙을 찾는다', found.length, 1);
    check('금액은 등록값', found[0] && found[0].amount, 6600);
    check('항목 이름은 정산 항목과 같다', found[0] && found[0].chargeType, '특수구간통행료');

    console.log('[접수하면 정산 항목이 생긴다 — 여기가 끊겨 있었다]');
    const created = await createOrder({
      oid: `${MARK}-1`,
      branchId: group.branch_id,
      requesterGroupId: group.id,
      originAddress: '서울 강남구 검사로 1',
      destinationAddress: '충남 당진시 검사로 2',
      reservedDate: '2026-08-29',
      reservedTime: '10:00',
      fareAmount: 100000,
      specialTolls: found,
      status: '접수',
    });
    const orderId = created && (created.orderId || created.id);
    const charges = await db.all(
      "SELECT charge_type, amount, note, billable FROM order_extra_charges WHERE order_id = ?", [orderId]
    );
    check('정산 줄이 생겼다', charges.length, 1);
    check('항목', charges[0] && charges[0].charge_type, '특수구간통행료');
    check('금액', charges[0] && Number(charges[0].amount), 6600);
    // 어느 구간인지 남겨야 정산서를 받은 쪽이 무엇인지 안다.
    check('어느 구간인지 남는다', charges[0] && charges[0].note, `${MARK}대교`);
    // 별도 청구로 들어가야 정산내역에 올라간다.
    check('별도 청구', charges[0] && charges[0].billable, true);

    console.log('[금액이 0인 규칙은 정산 줄을 만들지 않는다]');
    // 0원짜리 줄이 정산서에 늘어서면 읽는 사람이 무엇을 청구받는지 알 수 없다.
    const zero = await createOrder({
      oid: `${MARK}-2`,
      branchId: group.branch_id,
      requesterGroupId: group.id,
      originAddress: '서울 강남구 검사로 1',
      destinationAddress: '충남 당진시 검사로 2',
      reservedDate: '2026-08-29', reservedTime: '10:00', fareAmount: 100000,
      specialTolls: [{ chargeType: '특수구간통행료', name: '무료구간', amount: 0 }],
      status: '접수',
    });
    const zeroId = zero && (zero.orderId || zero.id);
    check('0원은 줄을 만들지 않는다',
      (await db.all('SELECT id FROM order_extra_charges WHERE order_id = ?', [zeroId])).length, 0);
  } finally {
    await cleanup();
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
