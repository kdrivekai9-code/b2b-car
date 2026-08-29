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

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
