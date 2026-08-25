// 고객이 말한 접수번호로 주문을 찾는지 — 우리 OID와 콜마너 접수번호 둘 다.
//
// 실사용 사고(2026-08-25): "OID1474 예약시간을 오늘 1시로 변경해줘" → "접수번호 OID1474 주문을
// 고객님 주문 목록에서 찾지 못했습니다". 그 주문은 우리 DB에도(대기, conf_slip 180923958)
// 콜마너 진행중 목록에도 멀쩡히 있었다.
//
// 원인: 소유 확인(assertOwnedOrder)이 콜마너 접수번호로만 찾았다. 그런데 봇은 목록을 보여줄 때
// "접수번호 OID1459(180891275)"처럼 둘을 함께 찍는다 — 고객이 앞의 OID를 말하는 건 당연하다.
//
// 소유 확인은 남의 주문을 막는 자리이기도 하다. OID를 받아준다고 그 방어가 헐거워지면 안 되므로
// 여기서 함께 본다.
require('dotenv').config();
const db = require('../db');
const access = require('../lib/mcpDispatchAccess');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

(async () => {
  try {
    // 콜마너 접수번호가 붙어 있는 실제 오더 하나를 표본으로 쓴다.
    const sample = await db.get(
      `SELECT oid, callmaner_conf_slip FROM orders
        WHERE callmaner_conf_slip IS NOT NULL AND oid IS NOT NULL ORDER BY id DESC LIMIT 1`
    );
    if (!sample) {
      console.log('  (건너뜀 — 콜마너 접수번호가 붙은 오더가 없습니다)');
      console.log('\n모두 통과');
      process.exit(0);
    }
    const oid = String(sample.oid);
    const slip = String(sample.callmaner_conf_slip);
    const digits = oid.replace(/\D/g, '');

    console.log(`[OID → 콜마너 접수번호 (표본 ${oid} → ${slip})]`);
    check('대문자 그대로', await access.loadCallmanerSlipByOid(oid), slip);
    check('소문자로 말해도', await access.loadCallmanerSlipByOid(oid.toLowerCase()), slip);
    // 고객이 접두어를 빼고 숫자만 말하는 경우가 흔하다.
    check('숫자만 말해도', await access.loadCallmanerSlipByOid(digits), slip);

    console.log('[없는 번호는 없다고 한다]');
    // 여기서 아무거나 돌려주면 남의 주문을 건드리게 된다.
    check('존재하지 않는 OID', await access.loadCallmanerSlipByOid('OID99999999'), null);
    check('빈 값', await access.loadCallmanerSlipByOid(''), null);
    check('숫자가 없는 문자열', await access.loadCallmanerSlipByOid('없음'), null);

    console.log('[소유 확인은 그대로 남의 주문을 막는다]');
    // OID를 받아준다고 방어가 헐거워지면 안 된다 — 허용 목록이 빈 사용자는 아무것도 못 찾아야 한다.
    const strangerCtx = {
      repNo: '12345', primaryCid: null, allowedCids: [], lookupOrder: [],
      linkedCids: [], linkNames: {}, usageCids: [], viewerScoped: true,
      userId: -1, userName: '검사용', branchId: null, branchName: null,
    };
    const denied = await access.assertOwnedOrder(strangerCtx, oid);
    check('허용된 연락처가 없으면 찾지 못한다', !!denied.error, true);
  } finally {
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
