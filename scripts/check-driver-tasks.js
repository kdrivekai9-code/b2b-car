// 기사 화면 "이 건에서 해주실 일" — 무엇이 뜨고 무엇이 안 뜨는지.
//
// 이 목록이 기사에게 닿는 지시의 전부다. 여기서 빠지면 기사는 그 일을 해야 하는 줄 모르고,
// 차가 빈 채로 가거나 인수증이 발송되지 않는다. 화면을 눌러봐서는 확인이 어렵다 —
// 기사 화면은 콜마너가 배차한 사번으로만 열리기 때문이다.
require('dotenv').config();
const db = require('../db');
const { buildDriverTasks } = require('../routes/driverChat');
const extraCharges = require('../lib/extraCharges');
const memoExtraCosts = require('../lib/memoExtraCosts');
const postalReceipt = require('../lib/postalReceipt');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`}`);
}

const MARK = 'zzq기사할일검사';
const MEMO = '주유 3만원을 넣어주고 영수증을 보내주세요\n'
  + '그리고 인수증을 고객에게 받아서 우편으로 출발지주소로 등기로 보내주세요';

(async () => {
  const made = [];
  try {
    console.log('[요청사항 판정 — 두 문장은 서로 다른 길로 간다]');
    // 주유는 부대비용 후보로, 등기는 postal_requested로 간다. 한쪽 규칙이 다른 쪽 문장을
    // 잡아버리면 같은 요청이 두 번 처리된다.
    check('등기 요청으로 읽는다', postalReceipt.isPostalRequested(MEMO), true);
    check('등기 낱말이 없으면 안 읽는다', postalReceipt.isPostalRequested('주유 3만원 넣어주세요'), false);

    const donor = await db.get(
      `SELECT branch_id, requester_group_id, created_by FROM orders
        WHERE branch_id IS NOT NULL AND requester_group_id IS NOT NULL ORDER BY id DESC LIMIT 1`);
    if (!donor) { console.log('  건너뜀 — 지사·법인이 모두 있는 오더가 없다'); }
    else {
      const mk = async (suffix, extra) => {
        const r = await db.get(
          `INSERT INTO orders (oid, branch_id, requester_group_id, status, reserved_date, reserved_time,
             origin_address, destination_address, fare_amount, memo_customer, created_by,
             postal_requested, receipt_upload_token)
           VALUES (?, ?, ?, '기사배정', '2019-12-24', '10:00', 'a', 'b', 50000, ?, ?, ?, ?) RETURNING id`,
          [MARK + suffix, donor.branch_id, donor.requester_group_id, MEMO, donor.created_by,
            !!(extra && extra.postal), (extra && extra.token) || null]);
        made.push(r.id);
        return db.get('SELECT * FROM orders WHERE id = ?', [r.id]);
      };

      console.log('[인수증 등기 — 적요1이 잘려도 여기서 보여야 한다]');
      const token = postalReceipt.generateReceiptToken();
      const postalOrder = await mk('-postal', { postal: true, token });
      let tasks = await buildDriverTasks(postalOrder);
      const postalTask = tasks.find((t) => t.chargeType === 'postal_receipt');
      check('등기 할 일이 뜬다', !!postalTask, true);
      check('무엇을 하는 일인지 적힌다', postalTask && postalTask.label, '인수증 등기 발송');
      // 링크가 없으면 화면이 버튼을 못 그린다 — 기사는 어디에 올릴지 모른다.
      check('업로드 화면 링크가 붙는다', !!(postalTask && postalTask.uploadUrl && postalTask.uploadUrl.includes(token)), true);
      check('아직 안 올렸으면 미완료', postalTask && postalTask.hasReceipt, false);

      // 올리고 나면 표시가 바뀌어야 한다 — 안 바뀌면 기사가 두 번 보낸다.
      await db.run('INSERT INTO order_receipts (order_id, tracking_no, url) VALUES (?, ?, ?)',
        [postalOrder.id, '1234567890123', 'https://example.invalid/r.jpg']);
      tasks = await buildDriverTasks(postalOrder);
      check('올린 뒤에는 완료로 바뀐다',
        tasks.find((t) => t.chargeType === 'postal_receipt').hasReceipt, true);

      // 등기 요청이 없는 오더에까지 뜨면 기사가 하지 않아도 될 일을 한다.
      const plain = await mk('-plain', { postal: false, token: null });
      check('등기 요청이 없으면 안 뜬다',
        (await buildDriverTasks(plain)).some((t) => t.chargeType === 'postal_receipt'), false);

      console.log('[주유 영수증 — 관리자가 채택해야 뜬다]');
      // 요청사항 분석은 후보만 만든다. 확정 전에 기사에게 흘리면 채택되지 않았을 때
      // 기사가 헛돈을 쓴다(routes/driverChat.js buildDriverTasks 주석).
      const fuelOrder = await mk('-fuel', { postal: false, token: null });
      await memoExtraCosts.analyzeAndStore(fuelOrder.id, MEMO, {}, {});
      const afterAnalyze = await db.get('SELECT * FROM orders WHERE id = ?', [fuelOrder.id]);
      const candidates = memoExtraCosts.loadFromOrder(afterAnalyze);
      check('요청사항에서 주유비를 찾는다', candidates.map((c) => c.chargeType), ['주유비']);
      check('찾은 금액', candidates[0] && candidates[0].amount, 30000);
      check('아직 판단 전이다', !!(candidates[0] && candidates[0].decision), false);
      check('채택 전에는 기사 할 일에 없다',
        (await buildDriverTasks(afterAnalyze)).some((t) => t.chargeType === '주유비'), false);

      // 관리자가 채택하면(= 부대비용 줄이 생기면) 그때 뜬다.
      await extraCharges.saveIntakeRows(fuelOrder.id, {
        rows: [{ chargeType: '주유비', optionCode: 'amount', amount: 30000, settleMode: 'monthly', billable: true, chargedOn: null }],
        ferry: null, knownIds: [],
      }, null);
      const accepted = await buildDriverTasks(await db.get('SELECT * FROM orders WHERE id = ?', [fuelOrder.id]));
      const fuelTask = accepted.find((t) => t.chargeType === '주유비');
      check('채택 후에는 뜬다', !!fuelTask, true);
      check('금액이 함께 간다', fuelTask && fuelTask.amount, 30000);
      // 영수증 버튼은 chargeId가 있어야 그려진다.
      check('영수증이 필요하다고 표시된다', fuelTask && fuelTask.needsReceipt, true);
      check('어느 줄에 붙일지 id가 있다', !!(fuelTask && fuelTask.chargeId), true);
    }
  } finally {
    for (const id of made) {
      await db.run('DELETE FROM order_receipts WHERE order_id = ?', [id]).catch(() => {});
      await db.run('DELETE FROM order_extra_charges WHERE order_id = ?', [id]).catch(() => {});
      await db.run('DELETE FROM order_status_history WHERE order_id = ?', [id]).catch(() => {});
      await db.run('DELETE FROM orders WHERE id = ?', [id]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
