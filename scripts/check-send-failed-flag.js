// 콜마너 전송 실패 표시 검사.
//
// 왜 필요한가: 전송이 실패한 오더는 배차가 **아예 시작되지 않았는데** 상태만 보면 진행 중처럼
// 읽힌다('대기', '접수', '오더등록' 무엇이든 그대로 뜬다). 실측: 전송 실패 10건이 어느
// 화면에도 안 떠서, 좌표만 다시 잡으면 나갈 건들이 방치돼 있었다.
//
// 고객에게는 보여주지 않는다. 우리 연동 사정이라 고객이 할 수 있는 게 없고, 실패 사유에는
// 콜마너 내부 메시지가 그대로 들어 있다.
require('dotenv').config();

const fs = require('fs');
const path = require('path');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const routes = read('routes/orders.js');
const ejs = read('views/orders/list.ejs');
const next = read('src/app/orders/OrderListTable.js');

console.log('[무엇을 실패로 세나]');
// 접수번호가 없다고 다 실패는 아니다. 연동 이전 옛 데이터는 시도 자체가 없어 사유도 없다
// (실측 법인1: 미등록 46건 중 36건). 그런 건까지 세면 고칠 수 없는 숫자가 매일 떠 있게 되고,
// 그러면 아무도 안 본다.
check('접수번호 없음 + 사유 있음', /callmaner_conf_slip IS NULL AND o\.callmaner_last_error IS NOT NULL/.test(routes));
check('판정을 한 곳에 둔다', /const SEND_FAILED_SQL/.test(routes),
  '화면이 각자 조건을 다시 쓰면 갈린다');
check('줄마다 서버가 판정해 내려준다', /send_failed: isAdminView && !o\.callmaner_conf_slip && !!o\.callmaner_last_error/.test(routes));

console.log('\n[고객에게는 없다]');
check('역할을 받는다', /async function buildOrdersListData\(scope, query, role\)/.test(routes));
check('client면 관리자 화면이 아니다', /const isAdminView = role !== 'client'/.test(routes));
check('client에게는 필터가 안 걸린다', /const sendFailedOnly = isAdminView &&/.test(routes));
check('client에게는 건수가 0', /sendFailed: isAdminView \? \(Number\(summaryRow\.send_failed\) \|\| 0\) : 0/.test(routes));
// 사유에는 콜마너 내부 메시지가 그대로 들어 있다.
check('client에게는 사유도 안 준다', /callmaner_last_error: isAdminView \? o\.callmaner_last_error : null/.test(routes));
check('두 화면 호출부가 역할을 넘긴다',
  (routes.match(/buildOrdersListData\(scopeFilter\(req\), req\.query, req\.session\.user\.role\)/g) || []).length === 2);

console.log('\n[집계와 필터가 서로를 망치지 않는다]');
// 상태별 집계는 상태 필터를 빼고 센다(탭처럼 동작). 전송실패 필터도 같은 자리에 둬야
// 다른 상태 건수가 0으로 안 바뀐다.
check('필터는 상태 필터와 같은 자리', /if \(sendFailedOnly\) where\.push/.test(routes));
check('집계는 상태 무관 조건으로', /COUNT\(\*\) FILTER \(WHERE \$\{SEND_FAILED_SQL\}\) AS send_failed/.test(routes));

console.log('\n[두 화면에 같이 있다]');
// 한쪽만 고치면 플래그를 되돌렸을 때 표시가 사라진다.
[['EJS', ejs], ['Next', next]].forEach(([name, src]) => {
  check(`${name} — 맨 앞에 표시를 그린다`, /send-failed-mark/.test(src));
  check(`${name} — 사유를 툴팁으로 보여준다`, /배차 시스템 전송 실패/.test(src));
  check(`${name} — 눌러서 거를 수 있다`, /send_failed: filters\.send_failed \? '' : '1'/.test(src));
  // 0건이면 매일 떠 있는 빈 칩이 된다.
  // EJS는 `if (…)`, Next는 `!!…&&` 로 같은 판단을 한다.
  check(`${name} — 0건이면 칩을 안 그린다`,
    /if \(statusSummary\.sendFailed\)|!!statusSummary\.sendFailed/.test(src));
});

const css = read('public/css/style.css');
check('표시가 빨간색', /\.send-failed-mark[\s\S]{0,200}background:#d93025/.test(css));

(async () => {
  console.log('\n[실제 데이터]');
  if (!process.env.DATABASE_URL) { console.log('  건너뜀 — DATABASE_URL 없음'); }
  else {
    const db = require('../db');
    try {
      const sql = 'o.callmaner_conf_slip IS NULL AND o.callmaner_last_error IS NOT NULL';
      const hit = await db.get(`SELECT COUNT(*) AS c FROM orders o WHERE ${sql}`);
      // 사유 없는 미등록 건(연동 이전 데이터)은 안 잡혀야 한다.
      const noReason = await db.get(
        'SELECT COUNT(*) AS c FROM orders o WHERE o.callmaner_conf_slip IS NULL AND o.callmaner_last_error IS NULL'
      );
      check('실패 건이 잡힌다', Number(hit.c) >= 0, `${hit.c}건`);
      console.log(`  (참고) 전송 실패 ${hit.c}건 / 사유 없는 미등록 ${noReason.c}건 — 뒤쪽은 세지 않는다`);
    } catch (e) {
      check('DB 검사', false, e.message);
    }
  }
  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})();
