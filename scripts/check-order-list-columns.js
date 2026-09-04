// 오더 리스트 컬럼 구성 — 역할마다 다른 부분을 못 박는다.
//
// 규칙(사용자 확정):
//   고객   지사는 아예 뺀다 / 요청 법인은 기본 체크 해제 / 담당자는 켠다
//   관리자 담당자를 추가하고 기본으로 켠다
//
// 왜 검사가 필요한가: 이 구성이 세 곳에 나뉘어 있다 — 표 마크업(views/orders/list.ejs),
// EJS용 컬럼 스크립트(public/js/order-list-columns.js), Next용 표
// (src/app/orders/OrderListTable.js). 한 곳만 고치면 화면에 따라 컬럼이 달라지는데,
// 그건 눌러보기 전에는 드러나지 않는다. 고객 화면은 관리자 계정으로 열어볼 수도 없다.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`}`);
}

const VIEWS = path.join(__dirname, '../views');

// 목록 화면이 쓰는 값들. 실제 라우트(routes/orders.js buildOrdersListData)가 주는 모양을
// 최소한으로 흉내낸다 — 여기서 보는 것은 데이터가 아니라 컬럼 구성이다.
function localsFor(role) {
  return {
    currentUser: { name: '검사', login_id: 'zzq', role, phone: '' },
    path: '/orders',
    title: '오더 리스트',
    statusColor: () => 'gray',
    formatMoney: (n) => String(Number(n) || 0),
    orders: [{
      id: 1, oid: 'OID1', branch_name: '서울', group_name: '서울모터스', group_phone: '02-0000-0000',
      origin_address: 'a', destination_address: 'b', waypoints_text: null,
      vehicle_type: '토레스', vehicle_number: '12가3456',
      reserved_date: '2026-01-01', reserved_time: '10:00', payment_method_name: '현금',
      fare_amount: 1000, dispatch_fare_amount: null, status: '완료', photo_count: 0,
      leg_count: 0, legs_assigned_count: 0, leg_driver_names: null,
      driver_name: null, driver_phone: null, created_at: '2026-01-01 09:00:00',
      created_by_name: '홍길동', created_by_login: 'hong',
    }],
    branches: [{ id: 1, name: '서울' }],
    ORDER_STATUSES: ['완료'],
    filters: {},
    pagination: { page: 1, totalPages: 1, total: 1 },
    statusSummary: {},
  };
}

(async () => {
  console.log('[표 마크업 — views/orders/list.ejs]');
  const admin = await ejs.renderFile(path.join(VIEWS, 'orders/list.ejs'), localsFor('admin'), { root: VIEWS });
  const client = await ejs.renderFile(path.join(VIEWS, 'orders/list.ejs'), localsFor('client'), { root: VIEWS });

  const has = (html, key) => html.includes(`data-column="${key}"`);
  check('관리자에게는 지사 칸이 있다', has(admin, 'branch'), true);
  // 고객은 자기 지사 하나뿐이라 모든 줄이 같은 값이다 — 칸만 차지한다.
  check('고객에게는 지사 칸을 그리지 않는다', has(client, 'branch'), false);
  check('담당자 칸은 양쪽 다 있다', [has(admin, 'created_by'), has(client, 'created_by')], [true, true]);
  // 요청 법인은 "기본 체크 해제"지 "삭제"가 아니다 — 고를 수는 있어야 한다.
  check('요청 법인 칸은 고객에게도 남는다', has(client, 'group'), true);
  // 컬럼 스크립트가 역할을 알아야 기본값을 가른다.
  check('표에 역할이 실린다', /data-my-role="client"/.test(client), true);
  // 이름이 없는 계정은 아이디로 보여준다.
  check('담당자 이름이 찍힌다', admin.includes('홍길동'), true);

  console.log('[컬럼 기본값 — 두 구현이 같은 규칙을 쓴다]');
  // 실행하지 않고 소스에서 기본값 배열을 읽는다. 두 파일 모두 브라우저 전용이라
  // (localStorage · React) 여기서 require할 수 없다.
  const legacy = fs.readFileSync(path.join(__dirname, '../public/js/order-list-columns.js'), 'utf8');
  const next = fs.readFileSync(path.join(__dirname, '../src/app/orders/OrderListTable.js'), 'utf8');
  const arrayOf = (src, name) => {
    const m = src.match(new RegExp(`${name} = \\[([^\\]]*)\\]`));
    return m ? m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean) : null;
  };
  const legacyVisible = arrayOf(legacy, 'DEFAULT_VISIBLE');
  const nextVisible = arrayOf(next, 'DEFAULT_VISIBLE');
  check('두 구현의 기본 표시 컬럼이 같다', legacyVisible, nextVisible);
  check('담당자가 기본으로 켜져 있다(관리자)', legacyVisible.includes('created_by'), true);
  const legacyOrder = arrayOf(legacy, 'DEFAULT_ORDER');
  check('두 구현의 컬럼 순서가 같다', legacyOrder, arrayOf(next, 'DEFAULT_ORDER'));
  check('담당자가 등록일시 앞에 온다',
    legacyOrder.indexOf('created_by') < legacyOrder.indexOf('created_at'), true);
  // 고객 기본값은 두 파일 모두 branch/group을 걷어내는 분기를 갖고 있어야 한다.
  check('EJS 쪽에 고객 분기가 있다', /IS_CLIENT/.test(legacy) && /k !== 'group'/.test(legacy), true);
  check('Next 쪽에 고객 분기가 있다', /columnConfigFor/.test(next) && /k !== 'group'/.test(next), true);

  console.log('[고객 컬럼 순서 — 요청 법인은 맨 뒤, 담당자가 그 자리]');
  // 두 구현이 각자 clientOrder를 갖고 있어 실제로 같은 배열을 만드는지 본다. 규칙을 글로만
  // 맞춰두면 한쪽이 바뀌었을 때 화면에 따라 순서가 달라진다.
  // 함수 본문은 중괄호를 세어 잘라낸다. 정규식으로 끝을 찾으면(첫 '\n}') 들여쓰기가 다른
  // 두 파일에서 서로 다른 지점을 끝으로 잡아, 엉뚱한 코드까지 함께 잘려 온다.
  const extractFn = (src, name) => {
    const start = src.indexOf(`function ${name}(`);
    if (start === -1) return null;
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    return null;
  };
  const clientOrderOf = (src) => {
    const fn = extractFn(src, 'clientOrder');
    if (!fn) return null;
    // eslint-disable-next-line no-new-func
    return new Function(`${fn}\nreturn clientOrder(${JSON.stringify(legacyOrder)});`)();
  };
  const legacyClient = clientOrderOf(legacy);
  const nextClient = clientOrderOf(next);
  check('두 구현의 고객 순서가 같다', legacyClient, nextClient);
  check('지사가 빠진다', legacyClient.includes('branch'), false);
  // 담당자가 요청 법인이 있던 자리(고객 기준 OID 다음)로 온다.
  check('담당자가 OID 바로 뒤', legacyClient.slice(0, 2), ['oid', 'created_by']);
  check('요청 법인이 맨 뒤', legacyClient[legacyClient.length - 1], 'group');
  // 자리만 옮기고 지우지는 않는다 — 여러 법인을 걸친 계정이 생기면 켤 수 있어야 한다.
  check('요청 법인이 목록에서 사라지지는 않는다', legacyClient.includes('group'), true);
  check('컬럼 수는 지사 하나만 줄어든다', legacyClient.length, legacyOrder.length - 1);

  console.log('[기본값 변경을 이미 저장한 사람에게도 한 번 반영한다]');
  // 저장값이 이기는 구조라, 표시(rev)가 없으면 바뀐 배치가 아무에게도 안 보인다.
  const revOf = (src) => { const m = src.match(/LAYOUT_REV = (\d+)/); return m ? Number(m[1]) : null; };
  check('두 구현의 LAYOUT_REV가 같다', revOf(legacy), revOf(next));
  check('LAYOUT_REV가 2 이상', revOf(legacy) >= 2, true);
  check('EJS가 rev를 저장한다', /saved\.rev = LAYOUT_REV/.test(legacy), true);
  check('Next가 rev를 저장한다', /saved\.rev = LAYOUT_REV/.test(next), true);

  console.log('[목록 조회 — 담당자 이름을 실어온다]');
  const routes = fs.readFileSync(path.join(__dirname, '../routes/orders.js'), 'utf8');
  // 조인이 빠지면 화면은 멀쩡히 뜨고 담당자 칸만 조용히 '-'가 된다.
  check('created_by_name을 SELECT 한다', /cu\.name AS created_by_name/.test(routes), true);
  check('users 조인이 있다', /LEFT JOIN users cu ON cu\.id = o\.created_by/.test(routes), true);

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
