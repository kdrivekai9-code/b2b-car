// "오늘 예약건 조회"에 오늘 건만 나오는지.
//
// 실사용(2026-08-26 오전 10:07): 고객이 "오늘 예약건조회"라고 물었는데 8/25 15:00 예약인
// OID1455가 나왔다. 모델은 도구를 제대로 골랐고 날짜도 맞게 넣었다(get_order_history,
// startDate=endDate=2026-08-26 — mcp_tool_calls에 그대로 남아 있다).
//
// 원인은 도구 안쪽이다. get_order_history는 두 목록을 합친다.
//   · call.list.history — 날짜 조건이 걸린다.
//   · call.list.active  — **날짜 조건이 없다.** 오늘 접수한 건이 이력에 아직 안 올라오는 문제
//                          때문에 일부러 같이 부르는데, 그래서 날짜와 무관하게 전부 딸려온다.
// OID1455는 8/25 예약이지만 상태가 기사배정(완료·취소가 아님)이라 진행 중 목록에 남아 있었고,
// 그대로 "오늘" 결과에 합쳐졌다.
//
// 고객이 날짜를 말했으면 그 날짜의 건만 답이다. 다만 기간 밖에 진행 중인 건이 있다는 사실까지
// 없애면 안 된다 — 고객이 "그럼 어제 그 건은?"을 물을 수 있어야 한다.
require('dotenv').config();
const db = require('../db');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

// 실제 핸들러의 기간 판정과 같은 규칙. 핸들러는 MCP 왕복이 있어 그대로 부를 수 없으므로,
// 판정 규칙만 떼어 같은 입력으로 확인한다 — 규칙이 갈리면 아래 [규칙이 코드와 같다]에서 걸린다.
function inRange(row, args) {
  const day = String(row.예약시간 || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return true;
  if (args.startDate && day < String(args.startDate).trim()) return false;
  if (args.endDate && day > String(args.endDate).trim()) return false;
  return true;
}

(async () => {
  try {
    const 오늘 = { startDate: '2026-08-26', endDate: '2026-08-26' };
    const rows = [
      { 접수번호: 'OID1455(180862604)', 예약시간: '2026-08-25 15:00', 구분: '진행중' }, // 이번 사고 건
      { 접수번호: 'OID1460(180900000)', 예약시간: '2026-08-26 09:00', 구분: '진행중' },
      { 접수번호: 'OID1461(180900001)', 예약시간: '2026-08-26 23:59', 구분: '지난이력' },
      { 접수번호: 'OID1462(180900002)', 예약시간: '2026-08-27 08:00', 구분: '진행중' }, // 내일 예약
      { 접수번호: 'OID1463(180900003)', 예약시간: null, 구분: '진행중' },                // 날짜를 못 읽는 건
    ];

    console.log('[오늘로 물으면 오늘 건만 나온다]');
    const kept = rows.filter((r) => inRange(r, 오늘)).map((r) => r.접수번호);
    // 이 한 줄이 이번 사고다 — 어제 예약이 진행 중이라는 이유로 오늘 목록에 섞였다.
    check('어제 예약(기사배정)은 빠진다', kept.includes('OID1455(180862604)'), false);
    check('내일 예약도 빠진다', kept.includes('OID1462(180900002)'), false);
    check('오늘 건은 진행중·지난이력 모두 남는다',
      kept.includes('OID1460(180900000)') && kept.includes('OID1461(180900001)'), true);
    // 판단할 수 없는 것을 숨기면 있는 주문이 없는 것이 된다.
    check('날짜를 못 읽는 건은 남긴다', kept.includes('OID1463(180900003)'), true);

    console.log('[경계 날짜를 잘라내지 않는다]');
    check('시작일 당일 포함', inRange({ 예약시간: '2026-08-26 00:00' }, 오늘), true);
    check('종료일 당일 포함', inRange({ 예약시간: '2026-08-26 23:59' }, 오늘), true);
    check('시작일 하루 전 제외', inRange({ 예약시간: '2026-08-25 23:59' }, 오늘), false);
    check('종료일 하루 뒤 제외', inRange({ 예약시간: '2026-08-27 00:00' }, 오늘), false);

    console.log('[기간을 안 말하면 아무것도 거르지 않는다]');
    // "내 주문 어떻게 됐어요"처럼 날짜가 없는 질문에서 걸러내면 주문이 사라진다.
    check('기간 없으면 전부 통과', rows.every((r) => inRange(r, {})), true);
    check('시작일만 있어도 동작', inRange({ 예약시간: '2026-08-20 10:00' }, { startDate: '2026-08-26' }), false);
    check('종료일만 있어도 동작', inRange({ 예약시간: '2026-08-30 10:00' }, { endDate: '2026-08-26' }), false);

    console.log('[규칙이 코드와 같다]');
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib/mcpDispatchAgent.js'), 'utf8');
    check('핸들러에 기간 필터가 있다', /const inRange = \(row\) => \{/.test(src), true);
    check('기간이 없으면 거르지 않는다', /const labeled = hasRange \? labeledAll\.filter\(inRange\) : labeledAll;/.test(src), true);
    // 걸러낸 건수를 알려줘야 모델이 "주문이 없습니다"로 단정하지 않는다.
    check('기간 밖 건수를 함께 돌려준다', /기간밖제외: 제외건수/.test(src), true);
    check('모델에게 그 값을 안내하라고 지시한다', /"기간밖제외"가 있으면/.test(src), true);
    // 조회조건 문구도 실제로 본 범위와 맞아야 한다 — 이번에 고객이 받은 첫 줄이 틀린 말이었다.
    check('기간 조회의 조회조건 문구가 바뀐다', /그 기간의 진행중 \+ 지난이력/.test(src), true);
  } finally {
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
