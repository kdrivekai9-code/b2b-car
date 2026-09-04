// 법인 계정 구분(본사 직원 / 개인 딜러)과 조회 범위 검사.
//
// 이 규칙이 틀리면 개인 딜러가 남의 오더를 보게 된다. 그건 화면에 오류로 드러나지 않는다 —
// 더 보이는 것은 아무도 신고하지 않기 때문이다. 그래서 규칙 자체를 검사로 고정한다.
require('dotenv').config();

const clientScope = require('../lib/clientScope');

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${e} / 실제 ${a})`}`);
}

const dealer = { id: 7, role: 'client', client_type: 'dealer', group_id: 1, branch_id: 1 };
const hq = { id: 8, role: 'client', client_type: 'hq', group_id: 1, branch_id: 1 };
const legacy = { id: 9, role: 'client', client_type: null, group_id: 1, branch_id: 1 };
const admin = { id: 1, role: 'admin' };
const manager = { id: 2, role: 'branch_manager', branch_id: 1 };

console.log('[구분 판정]');
check('개인 딜러', clientScope.isDealer(dealer), true);
check('본사 직원', clientScope.isDealer(hq), false);
// 기존 계정은 client_type이 비어 있다 — 마이그레이션만으로 누군가의 오더가 사라지면 안 된다.
check('구분이 없으면 본사 직원으로 본다', clientScope.isDealer(legacy), false);
// 권한을 좁히는 방향이라 안전해 보이지만, 관리자가 오더를 못 보면 운영이 멈춘다.
check('관리자에게 딜러 값이 붙어도 무시', clientScope.isDealer({ ...admin, client_type: 'dealer' }), false);
check('지사장도 무시', clientScope.isDealer({ ...manager, client_type: 'dealer' }), false);
check('알 수 없는 값은 본사 직원', clientScope.isDealer({ ...dealer, client_type: 'xxx' }), false);
check('빈 사용자', clientScope.isDealer(null), false);

console.log('\n[별도 정산 청구]');
// 오더 조회 범위와 정산 청구는 별개다 — 본인 것만 보되 정산은 본사가 받는 계약이 흔하다.
check('딜러 + 별도청구 켬', clientScope.hasSeparateSettlement({ ...dealer, separate_settlement: true }), true);
check('딜러 + 별도청구 끔', clientScope.hasSeparateSettlement({ ...dealer, separate_settlement: false }), false);
check('본사 직원은 켜져 있어도 false',
  clientScope.hasSeparateSettlement({ ...hq, separate_settlement: true }), false);

console.log('\n[스코프 — 딜러는 본인 오더만]');
// middleware/auth.js scopeFilter와 같은 규칙을 여기서 재현해 고정한다.
const scopeOf = (u) => {
  if (u.role === 'admin') return {};
  if (u.role === 'branch_manager') return { branch_id: u.branch_id };
  if (u.role === 'client') {
    const s = { branch_id: u.branch_id, group_id: u.group_id };
    if (clientScope.isDealer(u)) s.created_by = u.id;
    return s;
  }
  return {};
};
check('딜러는 created_by가 붙는다', scopeOf(dealer), { branch_id: 1, group_id: 1, created_by: 7 });
check('본사 직원은 법인까지만', scopeOf(hq), { branch_id: 1, group_id: 1 });
check('구분 없는 기존 계정도 법인까지만', scopeOf(legacy), { branch_id: 1, group_id: 1 });
check('관리자는 제한 없음', scopeOf(admin), {});
check('지사장은 지사까지만', scopeOf(manager), { branch_id: 1 });

console.log('\n[레코드 접근 가드]');
// 가드가 다섯 곳에 흩어져 있어 한 곳을 빠뜨렸고, 목록은 가려지는데 주소창에 id를 넣으면
// 남의 오더가 그대로 열렸다(실측 403이 아니라 200). 이제 판정을 한 함수가 한다.
const dealerScope = { branch_id: 1, group_id: 1, created_by: 7 };
const hqScope = { branch_id: 1, group_id: 1 };
const mine = { branch_id: 1, requester_group_id: 1, created_by: 7 };
const sibling = { branch_id: 1, requester_group_id: 1, created_by: 8 };
const otherGroup = { branch_id: 1, requester_group_id: 2, created_by: 7 };
const otherBranch = { branch_id: 9, requester_group_id: 1, created_by: 7 };

check('딜러 — 본인 오더는 열린다', clientScope.canView(dealerScope, mine), true);
check('딜러 — 같은 법인 남의 오더는 막힌다', clientScope.denyReason(dealerScope, sibling), 'owner');
check('딜러 — 다른 법인 오더는 막힌다', clientScope.denyReason(dealerScope, otherGroup), 'group');
check('딜러 — 다른 지사 오더는 막힌다', clientScope.denyReason(dealerScope, otherBranch), 'branch');
check('본사 직원 — 같은 법인이면 남의 오더도 열린다', clientScope.canView(hqScope, sibling), true);
check('본사 직원 — 다른 법인은 막힌다', clientScope.canView(hqScope, otherGroup), false);
check('관리자(빈 스코프)는 전부 열린다', clientScope.canView({}, otherGroup), true);
// 문의는 requester_group_id를 쓰지만 다른 표는 group_id를 쓸 수 있다 — 둘 다 받는다.
check('group_id 필드로도 판정한다',
  clientScope.denyReason(hqScope, { branch_id: 1, group_id: 2, created_by: 7 }), 'group');

console.log('\n[정산 구분]');
// loadSettlement이 나누는 규칙: 별도청구 딜러만 따로, 나머지는 본사에 합친다.
const rows = [
  { id: 1, created_by: 8, created_by_client_type: 'hq', created_by_separate: false, total: 10000 },
  { id: 2, created_by: 7, created_by_client_type: 'dealer', created_by_separate: true, total: 20000 },
  { id: 3, created_by: 9, created_by_client_type: 'dealer', created_by_separate: false, total: 30000 },
  { id: 4, created_by: 7, created_by_client_type: 'dealer', created_by_separate: true, total: 40000 },
  { id: 5, created_by: null, created_by_client_type: null, created_by_separate: null, total: 50000 },
];
const split = (list) => {
  const byUser = new Map();
  const hqRows = [];
  list.forEach((r) => {
    const sep = r.created_by_client_type === 'dealer' && r.created_by_separate === true;
    if (!sep || !r.created_by) { hqRows.push(r); return; }
    const k = String(r.created_by);
    if (!byUser.has(k)) byUser.set(k, []);
    byUser.get(k).push(r);
  });
  return { hq: hqRows.map((r) => r.id), dealers: [...byUser.entries()].map(([k, v]) => [Number(k), v.map((r) => r.id)]) };
};
const out = split(rows);
check('별도청구 딜러만 따로 묶인다', out.dealers, [[7, [2, 4]]]);
// 별도청구를 안 하는 딜러(3)와 접수자 없는 건(5)은 본사에 합쳐진다.
check('나머지는 전부 본사로', out.hq, [1, 3, 5]);
// 합계가 갈리면 정산에서 가장 나쁜 버그다 — 나눈 뒤에도 총합이 같아야 한다.
const totalAll = rows.reduce((a, r) => a + r.total, 0);
const totalSplit = rows.filter((r) => out.hq.includes(r.id)).reduce((a, r) => a + r.total, 0)
  + rows.filter((r) => !out.hq.includes(r.id)).reduce((a, r) => a + r.total, 0);
check('나눠도 총합은 같다', totalSplit, totalAll);
check('별도청구 딜러가 없으면 나누지 않는다',
  split(rows.filter((r) => !r.created_by_separate)).dealers, []);

console.log('\n[팀 접수 현황 안내 — 딜러는 못 본다]');
// 법인 단위 옵트인이지만 딜러는 본인 오더만 보는 자격이다. 같은 법인이라는 이유로 남의 접수
// 내역을 보게 하면 오더 상세에 걸어둔 가림막이 이 피드로 새어버린다 — 요약에는 출발·도착
// 주소와 연락처가 들어 있어 그 자체로 영업 정보다.
//
// 이 파일의 check는 값 비교식이라(actual, expected) 조건은 true와 맞춘다.
const fs = require('fs');
const path = require('path');
const readFile = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const feed = readFile('lib/groupActivityFeed.js');
const ordersSrc = readFile('routes/orders.js');

// 세 겹으로 막아야 한다 — 하나만 빠져도 새는 길이 남는다.
check('웹 수신 대상에서 뺀다', /client_type[\s\S]{0,40}<> 'dealer'/.test(feed), true);
check('카카오 수신 대상에서도 뺀다', (feed.match(/<> 'dealer'/g) || []).length >= 2, true);
check('화면 자체를 막는다',
  /team-feed[\s\S]{0,400}clientScope\.isDealer\(u\)[\s\S]{0,80}403/.test(ordersSrc), true);
// 값이 비어 있는 기존 계정은 본사 직원으로 본다 — 마이그레이션만으로 누가 조용히 빠지면 안 된다.
check('빈 값은 본사 직원으로 본다', /COALESCE\(NULLIF\((u\.)?client_type, ''\), 'hq'\)/.test(feed), true);
// 채널 전체 매핑은 누가 붙을지 알 수 없다 — 딜러가 그 통로로 들어오면 막을 방법이 없다.
check('사용자가 안 걸린 카카오 매핑에는 안 보낸다', /u\.id IS NOT NULL/.test(feed), true);
// 갈 수 없는 곳으로 안내하지 않는다.
['views/partials/header.ejs', 'src/app/_components/AppShell.js'].forEach((f) => {
  check(`${f} — 딜러에게 메뉴를 숨긴다`, /client_type !== 'dealer'|!isDealer/.test(readFile(f)), true);
});

console.log('\n[관리자가 한 일은 피드에 안 실린다]');
// 이 피드는 "같은 법인 동료가 무엇을 요청했는지"를 나누는 자리다. 관리자·지사장이 오더를
// 손보는 것은 동료의 요청이 아니라 우리가 처리하는 일이라, 여기 실리면 고객에게
// "시스템관리자님이 오더 내용을 변경했습니다"가 카카오톡으로 나간다(실측 2026-09-04).
// 고객은 자기가 부탁한 적 없는 변경을 통보받고 무슨 일인지 되묻게 된다.
check('작성자 확인 함수가 있다', /async function isGroupMember/.test(feed), true);
check('client만 통과시킨다', /u\.role === 'client' && Number\(u\.group_id\) === Number\(groupId\)/.test(feed), true);
// 시스템·크론·MCP 자동 처리는 사람이 한 일이 아니다.
check('작성자가 없으면 안 보낸다', /if \(!actorUserId\) return false/.test(feed), true);
// 안 보내서 생기는 손해보다 잘못 보내서 생기는 손해가 크다.
check('확인이 안 되면 안 보낸다', /확인 실패\(보내지 않음\)[\s\S]{0,80}return false/.test(feed), true);
// 기록 전에 막아야 한다 — 기록만 남고 알림이 안 가면 화면과 통보가 어긋난다.
check('기록보다 먼저 막는다',
  feed.indexOf('await isGroupMember(actorUserId, groupId)') < feed.indexOf('INSERT INTO group_activity_feed'), true);

console.log('\n[바뀐 곳을 보여준다]');
// 앞에서 20자만 잘라 양쪽에 찍으면, 정작 바뀐 부분이 그 뒤에 있을 때 같은 문장이 화살표
// 양쪽에 그대로 나온다(실측). 읽는 사람은 무엇이 바뀐 건지 알 수 없다.
const ordersFile = readFile('routes/orders.js');
check('변경 지점을 찾아 보여준다', /function describeTextChange/.test(ordersFile), true);
check('메모 diff가 그 함수를 쓴다',
  /describeTextChange\('고객사 메모'/.test(ordersFile) && /describeTextChange\('업체요청사항'/.test(ordersFile), true);
// 폼이 개행을 정리해 보내는 일이 흔한데, 그걸 변경으로 기록하면 아무도 손대지 않은 오더에
// 변경 이력이 쌓이고 그 알림이 고객에게 나간다.
check('공백만 다른 것은 변경이 아니다', /if \(a === b\) return null;/.test(ordersFile), true);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
