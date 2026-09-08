// 기간 조회를 "접수일"과 "예약일" 중 무엇으로 세는가.
//
// 왜 필요한가(실사용 지적 2026-09-08): 챗봇에 "오늘 접수한건 조회해줘"라고 물으면 오늘
// **예약된** OID2075(접수는 어제)가 나오고, 정작 오늘 접수한 OID2150(예약은 내일)은 빠졌다.
// 기간 필터가 예약시간 한 칸만 봤기 때문이다.
//
// 사람은 접수와 예약을 섞어 쓴다. 그래서 물어본 말대로 세고(dateBasis), 다른 기준으로 걸린
// 건은 버리지 않고 따로 묶어 함께 돌려준다 — 어느 말로 물었든 찾는 주문이 보인다.
// 미래 기간에는 덧붙이지 않는다: 접수는 과거에만 일어나므로 "내일 접수된 건"은 없다.
//
// 여기서는 도구가 만드는 **묶음**만 본다(모델 답변 문구는 프롬프트 규칙이라 함께 확인).
// MCP 호출 없이 돌 수 있게 조회 계층을 대역으로 갈아끼운다 — 외부 API에 의존하는 검사는
// 키가 없는 환경에서 조용히 통과해버린다.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { joinAddress } = require('../lib/intakeSummary');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`}`);
}

// ── 조회 계층 대역 ────────────────────────────────────────────────────────────
// 오늘 = 2026-09-08로 고정하지 않는다(달력에 묶으면 언젠가 통과만 하는 검사가 된다).
const now = new Date(Date.now() + 9 * 3600 * 1000);
const day = (n) => new Date(now.getTime() + n * 86400000).toISOString().slice(0, 10);
const TODAY = day(0);

// 실제 사고 그대로: 어제 접수한 오늘 예약 건 / 오늘 접수한 내일 예약 건 / 오래된 건.
const FIXTURES = [
  { rcptNo: '182353721', requestedAt: `${TODAY}T09:00:01+09:00`, scheduledAt: `${TODAY}T16:20:00+09:00`, st: 'scheduled' },
  { rcptNo: '182432031', requestedAt: `${TODAY}T11:27:18+09:00`, scheduledAt: `${day(1)}T18:30:00+09:00`, st: 'waiting' },
  { rcptNo: '180862604', requestedAt: `${day(-14)}T20:15:37+09:00`, scheduledAt: `${day(-13)}T15:00:00+09:00`, st: 'assigned' },
];
const OURS = new Map([
  // OID2075: 콜마너 requestedAt(오늘 09:00)은 접수시각이 아니다 — 예약 건을 수행일 아침에
  // 대기열로 올린 시각이다. 우리 created_at(어제)이 실제 접수시각이다.
  ['182353721', { oid: 'OID2075', created_at: `${day(-1)} 10:08:21`, reserved_date: TODAY, reserved_time: '16:20', status: '예약' }],
  ['182432031', { oid: 'OID2150', created_at: `${TODAY} 11:27:17`, reserved_date: day(1), reserved_time: '18:30', status: '대기' }],
  ['180862604', { oid: 'OID1455', created_at: `${day(-14)} 20:15:37`, reserved_date: day(-13), reserved_time: '15:00', status: '기사배정' }],
]);

const realLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === './mcpDispatchClient') {
    return {
      callTool: async (tool) => (tool === 'call.list.active'
        ? { ok: true, data: { orders: FIXTURES.filter((o) => o.st !== 'assigned') } }
        : { ok: true, data: { orders: FIXTURES } }),
    };
  }
  const mod = realLoad(request, parent, isMain);
  if (request === './mcpDispatchAccess') {
    return {
      ...mod,
      maskPhone: (v) => String(v || ''),
      logToolCall: async () => {},
      loadOidsByCallmanerSlips: async (slips) => {
        const map = new Map();
        (slips || []).forEach((slip) => {
          const row = OURS.get(String(slip || ''));
          if (row) map.set(String(slip), { ...row, callmaner_conf_slip: String(slip) });
        });
        return map;
      },
    };
  }
  return mod;
};
const agent = require('../lib/mcpDispatchAgent');
Module._load = realLoad;

const ctx = { repNo: '12345', lookupOrder: ['01000000000'], usageCids: [], linkedCids: [], linkNames: {} };
const oidsOf = (rows) => (rows || []).map((r) => String(r.접수번호 || '').split('(')[0]);

(async () => {
  console.log('[오늘 — 접수일 기준으로 물었다]');
  const created = await agent.runReadTool(ctx, null, 'get_order_history',
    { startDate: TODAY, endDate: TODAY, dateBasis: 'created' });
  check('기준을 밝힌다', created.기준, '접수일');
  check('오늘 접수한 건만 앞에', oidsOf(created.orders), ['OID2150']);
  // 오늘 예약이지만 어제 접수한 건 — 버리지 않고 따로 묶는다.
  check('예약일이 오늘인 건을 덧붙인다', oidsOf(created.다른기준 && created.다른기준.orders), ['OID2075']);
  check('덧붙인 묶음의 이름', created.다른기준 && created.다른기준.기준, '예약일');

  console.log('\n[오늘 — 예약일 기준으로 물었다]');
  const reserved = await agent.runReadTool(ctx, null, 'get_order_history',
    { startDate: TODAY, endDate: TODAY, dateBasis: 'reserved' });
  check('기준을 밝힌다', reserved.기준, '예약일');
  check('오늘 예약된 건만 앞에', oidsOf(reserved.orders), ['OID2075']);
  check('오늘 접수한 건을 덧붙인다', oidsOf(reserved.다른기준 && reserved.다른기준.orders), ['OID2150']);
  check('기준을 안 주면 예약일', (await agent.runReadTool(ctx, null, 'get_order_history',
    { startDate: TODAY, endDate: TODAY })).기준, '예약일');

  console.log('\n[미래 — 덧붙이지 않는다]');
  // 접수는 과거에만 일어난다. "내일 접수된 건"이라는 집합은 없으므로 덧붙일 것도 없다.
  const tomorrow = await agent.runReadTool(ctx, null, 'get_order_history',
    { startDate: day(1), endDate: day(1), dateBasis: 'reserved' });
  check('내일 예약 건만', oidsOf(tomorrow.orders), ['OID2150']);
  check('덧붙임 없음', tomorrow.다른기준, undefined);

  console.log('\n[과거 — 덧붙인다]');
  const pastDay = await agent.runReadTool(ctx, null, 'get_order_history',
    { startDate: day(-13), endDate: day(-13), dateBasis: 'reserved' });
  check('그날 예약된 건', oidsOf(pastDay.orders), ['OID1455']);

  console.log('\n[접수시각은 우리 값이 먼저다]');
  // 콜마너 requestedAt은 예약 건에서 접수시각이 아니다(실측: OID2075 requestedAt 오늘 09:00,
  // 실제 접수는 어제 10:08). 이 우선순위가 뒤집히면 위 [오늘] 검사가 곧 다시 깨진다.
  const row2075 = (created.다른기준.orders || []).find((r) => String(r.접수번호).startsWith('OID2075'));
  check('우리 created_at을 쓴다', row2075.접수시각, `${day(-1)} 10:08`);
  check('예약시각도 함께 싣는다', row2075.예약시각, `${TODAY} 16:20`);

  console.log('\n[프롬프트 규칙]');
  const src = fs.readFileSync(path.join(__dirname, '../lib/mcpDispatchAgent.js'), 'utf8');
  // 도구가 두 묶음을 줘도, 모델이 앞의 "물어본 것에만 답하세요" 규칙 때문에 버리면 의미가 없다.
  check('다른기준을 덧붙이라고 지시한다', /도구 결과에 \*\*"다른기준"\*\*이 들어 있으면/.test(src), true);
  check('기준 고르는 법을 지시한다', /"오늘 접수한 건 \/ 등록한 건 \/ 넣은 건" → created/.test(src), true);
  check('접수 기준 답에는 접수시각도', /접수일 기준으로 물어본 답\(dateBasis=created\)에는 \*\*접수시각도 함께\*\*/.test(src), true);
  check('도구 스키마에 dateBasis', /dateBasis: \{/.test(src), true);

  console.log('\n[주소를 두 번 읽지 않는다]');
  // 조회 답변은 주소+상세주소를 합쳐 읽어준다. 주소 칸에 이미 상세가 들어간 행이 있어서
  // 그대로 합치면 같은 말이 두 번 나갔다(실측 OID2075).
  check('상세가 주소에 이미 있으면 안 붙인다',
    joinAddress('서울 강서구 양천로53길 30 서서울모터리움 803호', '서서울모터리움 803호'),
    '서울 강서구 양천로53길 30 서서울모터리움 803호');
  check('띄어쓰기·쉼표만 다른 경우도 같게 본다',
    joinAddress('서울 양천로 53길 30, 서서울모터리움 803호', '서서울모터리움 803호'),
    '서울 양천로 53길 30, 서서울모터리움 803호');
  check('없는 상세는 붙인다',
    joinAddress('서울 강서구 양천로53길 30', '803호'), '서울 강서구 양천로53길 30 803호');

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
