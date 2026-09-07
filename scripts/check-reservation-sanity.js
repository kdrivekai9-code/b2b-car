// 예약일 상식 검사.
//
// 왜 필요한가(실측 2026-09-07): OID2075가 오늘 접수되면서 예약일이 2027-09-08로 저장됐다.
// 날짜 칸에서 연도를 잘못 고른 것인데 아무도 막지 않아 콜마너까지 그대로 등록됐다
// (conf_slip 182353721). 오더 리스트에는 멀쩡히 보이니 접수된 줄 알지만 "오늘·내일 예약 콜"
// 조회에는 안 잡히고, 그 날짜가 올 때까지 아무도 모른다.
//
// 막지는 않는다. 몇 달 뒤 출고 예정 차량을 미리 잡는 일이 실제로 있고, 그 판단을 우리가
// 대신할 수는 없다. 대신 눈에 띄게 만든다 — 접수할 때 한 번 되묻고 목록에서 표시한다.
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const sanity = require('../lib/reservationSanity');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const NOW = '2026-09-07T01:00:00Z'; // KST 2026-09-07 10:00

console.log('[정상 범위는 통과한다]');
// 되묻기가 잦으면 사람은 읽지 않고 확인을 누른다. 그러면 경고가 없는 것과 같아진다.
['2026-09-07', '2026-09-08', '2026-09-06', '2026-12-01'].forEach((d) => {
  check(`${d} 통과`, sanity.checkReservedDate(d, NOW).ok === true);
});

console.log('\n[상식 밖은 되묻는다]');
// 이번 사고 그대로.
const far = sanity.checkReservedDate('2027-09-08', NOW);
check('1년 뒤는 되묻는다', far.ok === false && far.reason === 'far_future', far.reason);
check('며칠 뒤인지 알려준다', far.days === 366, String(far.days));
// 연도가 원인이었으므로 날짜를 그대로 보여줘야 무엇이 이상한지 보인다.
check('문구에 날짜가 들어간다', /2027-09-08/.test(sanity.describe('2027-09-08', NOW)));
check('연도를 확인하라고 말한다', /연도를 확인/.test(sanity.describe('2027-09-08', NOW)));
// 오타로 작년을 고르면 그 오더는 조회에서 영영 안 나온다.
// 작년을 고른 오타는 1년쯤 어긋난다.
const past = sanity.checkReservedDate('2025-09-08', NOW);
check('작년 오타는 되묻는다', past.ok === false && past.reason === 'past', past.reason);
// 지난 날짜라고 다 오타가 아니다. 예약일이 지났는데 아직 완료 안 된 건은 **밀린 오더**지
// 잘못 입력한 게 아니다 — 실제 데이터에서 200건 중 38건이 그랬고(경과일 8~48일), 그것까지
// 표시하면 목록이 느낌표로 뒤덮여 정작 오타 한 건이 묻힌다.
['2026-09-06', '2026-08-29', '2026-08-01', '2026-07-25'].forEach((d) => {
  check(`${d} 밀린 오더는 안 잡는다`, sanity.checkReservedDate(d, NOW).ok === true,
    `${sanity.checkReservedDate(d, NOW).days}일 전`);
});
check('지난 날짜 기준이 180일', sanity.PAST_LIMIT_DAYS === 180);

console.log('\n[이상한 값에도 버틴다]');
// 형식이 아니면 다른 검증이 잡는다 — 여기서 막으면 그쪽 오류 메시지가 안 보인다.
['', null, '내일', '2026-13-45'].forEach((d) => {
  check(`${JSON.stringify(d)}는 통과시킨다`, sanity.checkReservedDate(d, NOW).ok === true);
});
// Date가 2026-13-45를 다음 해로 굴려버려서 "1년 뒤 예약"으로 잡히던 것을 막았다 —
// 날짜가 아닌 것은 날짜가 아니라고 해야 다른 검증이 제 일을 한다.
check('굴러간 날짜를 미래로 오해하지 않는다',
  sanity.checkReservedDate('2026-13-45', NOW).days === 0);

console.log('\n[화면에 드러난다]');
const orderForm = read('src/app/orders/new/OrderForm.js');
// 막지 않고 되묻는다 — confirm이지 return이 아니다.
check('접수 전에 되묻는다', /reservationSanity\.describe\(reservedDate\)/.test(orderForm)
  && /window\.confirm/.test(orderForm));
check('화면이 따로 세지 않는다', /import reservationSanity from/.test(orderForm),
  '서버와 같은 모듈을 써야 "여기선 통과, 서버는 경고"가 안 생긴다');

const routes = read('routes/orders.js');
check('목록이 판정을 내려받는다', /date_odd: reservationSanity\.describe\(o\.reserved_date\)/.test(routes));
// 자기가 잘못 고른 날짜다. 빨리 알수록 고치기 쉽다.
check('고객에게도 보여준다', !/date_odd: isAdminView/.test(routes),
  '전송 실패와 달리 이건 고객이 고칠 수 있는 일이다');

['views/orders/list.ejs', 'src/app/orders/OrderListTable.js'].forEach((f) => {
  const src = read(f);
  check(`${f} — 목록에 표시한다`, /date-odd-mark/.test(src));
  check(`${f} — 이유를 툴팁으로 보여준다`, /o\.date_odd/.test(src));
});
// 전송 실패와 다른 색이어야 한다 — 그쪽은 우리가 고칠 일이고 이쪽은 날짜를 다시 고를 일이다.
const css = read('public/css/style.css');
check('전송 실패와 다른 색', /\.date-odd-mark[\s\S]{0,200}background:#c7a008/.test(css));

(async () => {
  console.log('\n[실제 데이터]');
  if (!process.env.DATABASE_URL) { console.log('  건너뜀 — DATABASE_URL 없음'); }
  else {
    const db = require('../db');
    try {
      const rows = await db.all(
        `SELECT oid, reserved_date FROM orders
          WHERE status NOT IN ('완료','취소') AND reserved_date IS NOT NULL
          ORDER BY id DESC LIMIT 200`
      );
      const odd = rows.filter((r) => !sanity.checkReservedDate(r.reserved_date).ok);
      check('판정이 돈다', Array.isArray(rows));
      console.log(`  (참고) 최근 200건 중 예약일이 상식 밖인 건: ${odd.length}건`
        + (odd.length ? ` — ${odd.slice(0, 5).map((r) => `${r.oid}(${r.reserved_date})`).join(', ')}` : ''));
    } catch (e) {
      check('DB 검사', false, e.message);
    }
  }
  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})();
