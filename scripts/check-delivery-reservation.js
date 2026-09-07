// 도착지 인도시간 기준 접수 — 원래 요청 시각이 남고, 화면과 기사메모에 제대로 나오는지.
//
// 왜 필요한가: orders.reserved_date/time에는 **픽업 시각**이 들어간다. 콜마너가 예약시각을
// 출발 기준으로 받아서, 고객이 "18시 30분 도착"으로 접수해도 경로 소요시간을 역산한 값
// (예: 16시 20분)으로 바뀐다. 그 순간 고객이 말한 시각은 어디에도 없다 — 다시 물으면 대조할
// 근거가 없고, 기사는 픽업 시각을 도착 시각으로 오해한다.
//
// 판정이 어긋나면 틀린 시각이 화면·기사메모·콜마너 적요까지 그대로 흘러간다. 눈으로는
// "그럴듯한 시각"이라 안 보인다 — 그래서 여기서 못 박는다.
require('dotenv').config();
const path = require('path');
const ejs = require('ejs');
const { deliveryReservedFrom } = require('../routes/orders');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`}`);
}

const VIEWS = path.join(__dirname, '../views');

(async () => {
  console.log('[무엇을 인도시각으로 기록하나]');
  const body = {
    reserved_date: '2027-07-27', reserved_time: '18:30',
    pickup_reserved_date: '2027-07-27', pickup_reserved_time: '16:20',
  };
  check('도착지 인도 기준이면 화면의 시각을 남긴다',
    deliveryReservedFrom({ ...body, reservation_basis: 'delivery' }),
    { date: '2027-07-27', time: '18:30' });

  // 여기가 이 기능에서 가장 틀리기 쉬운 자리다. '즉시'와 '출발지 픽업' 기준에서도 픽업 필드는
  // 채워지므로(public/js/order-form.js setPickupHiddenFields), "픽업 필드가 있으면 인도 기준"
  // 으로 가르면 모든 오더에 인도시각이 잘못 붙는다.
  check('출발지 픽업 기준이면 남기지 않는다',
    deliveryReservedFrom({ ...body, reservation_basis: 'pickup' }), { date: null, time: null });
  check('즉시 기준이면 남기지 않는다',
    deliveryReservedFrom({ ...body, reservation_basis: 'immediate' }), { date: null, time: null });
  check('기준이 안 오면 남기지 않는다', deliveryReservedFrom(body), { date: null, time: null });
  // 기준을 픽업으로 되돌린 수정에서 null이 나와야 예전 값이 지워진다.
  check('값이 비면 null', deliveryReservedFrom({ reservation_basis: 'delivery' }), { date: null, time: null });

  console.log('[오더 상세 — 그런 오더에만 붙는다]');
  const locals = (extra) => ({
    currentUser: { name: '검사', login_id: 'zzq', role: 'admin', phone: '' },
    path: '/orders/1', title: '오더 상세',
    statusColor: () => 'gray', formatMoney: (n) => String(Number(n) || 0),
    order: {
      id: 1, oid: 'OID1', status: '접수', branch_name: '서울',
      reserved_date: '2027-07-27', reserved_time: '16:20',
      origin_address: 'a', destination_address: 'b', ...extra,
    },
  });
  // 상세 화면은 부가 데이터를 많이 받는다. 여기서 보려는 것은 예약일시 한 줄이라, 그 줄만
  // 떼어 렌더한다 — 화면 전체를 태우면 이 검사가 다른 카드의 변경에 계속 걸린다.
  const row = `<%= order.reserved_date %> <%= order.reserved_time %>`
    + `<% if (order.delivery_reserved_date && order.delivery_reserved_time) { %>`
    + `[도착지 인도 <%= order.delivery_reserved_time %>`
    + `<% if (order.delivery_reserved_date !== order.reserved_date) { %> (<%= order.delivery_reserved_date %>)<% } %>]`
    + `<% } %>`;
  const render = (extra) => ejs.render(row, locals(extra));

  check('기준이 아니면 아무것도 안 붙는다', render({}).trim(), '2027-07-27 16:20');
  check('같은 날이면 시각만',
    render({ delivery_reserved_date: '2027-07-27', delivery_reserved_time: '18:30' }).trim(),
    '2027-07-27 16:20[도착지 인도 18:30]');
  // 밤에 출발해 다음날 아침 인도하는 건 — 날짜가 없으면 기사·상담원이 당일로 읽는다.
  check('날짜가 다르면 날짜까지',
    render({ reserved_date: '2027-07-27', delivery_reserved_date: '2027-07-28', delivery_reserved_time: '09:00' }).trim(),
    '2027-07-27 16:20[도착지 인도 09:00 (2027-07-28)]');
  // 마이그레이션 전에는 칸이 없어 undefined가 온다 — 화면이 깨지면 안 된다.
  check('칸이 없어도 깨지지 않는다',
    render({ delivery_reserved_date: undefined, delivery_reserved_time: undefined }).trim(), '2027-07-27 16:20');

  console.log('[기사메모 문구 — 두 화면이 같은 규칙을 쓴다]');
  const fs = require('fs');
  const formJs = fs.readFileSync(path.join(__dirname, '../public/js/order-form.js'), 'utf8');
  // 옛 문구('일시:')로 저장된 오더가 있다. 지울 때 걷어내지 않으면 수정할 때마다 한 줄씩 쌓인다.
  check('옛 문구도 걷어낸다', /DELIVERY_RESERVATION_MEMO_PREFIXES\s*=\s*\[[^\]]*'일시:'/.test(formJs), true);
  check('새 문구를 쓴다', /DELIVERY_RESERVATION_MEMO_PREFIX\s*=\s*'도착지 인도시간 :'/.test(formJs), true);
  // 기사가 읽는 칸이라 "일시"로는 무슨 일시인지 알 수 없다 — 픽업으로 읽으면 두 시간 일찍 온다.
  check('"도착요망" 문구는 더 쓰지 않는다', /도착요망/.test(formJs), false);

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
