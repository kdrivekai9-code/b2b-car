// 배차 도우미 "투기 실행"(의도분류와 동시에 미리 돌리기)의 안전장치 검사.
//
// 왜 필요한가: 이 실행 결과는 의도가 unsupported가 아니면 버려진다. 그런데 도우미 경로에는
// 확인 대기 상태를 저장하고("네" 한마디로 접수/취소가 실행되는 자리다) 실제 변경까지 하는
// 길이 섞여 있다. 버려질 실행이 그 길로 들어가면, 고객이 나중에 한 "네"가 엉뚱한 행위의
// 동의로 소비된다. 그 두 길이 실제로 막혀 있는지 확인한다.
//
// 외부 호출(Vertex/MCP)은 require.cache를 미리 채워 가짜로 바꾼다 — vertexAi는 에이전트가
// 구조분해로 가져가므로(const { generateWithTools } = require(...)) 나중에 덮어써도 소용없다.
require('dotenv').config();

// ---- 가짜 모듈 주입 (에이전트를 require하기 전에) ----
function stub(relPath, exports) {
  const full = require.resolve(relPath);
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
  return exports;
}

let nextTurn = null; // generateWithTools가 돌려줄 값
stub('../lib/vertexAi', {
  generateWithTools: async () => nextTurn,
  generateJson: async () => ({}),
  generateJsonWithImages: async () => ({}),
  embedText: async () => [],
  generateWithToolsRaw: async () => nextTurn,
  EMBEDDING_DIMENSIONS: 768,
});
stub('../lib/mcpDispatchClient', {
  isConfigured: () => true,
  listTools: async () => [],
  callTool: async () => ({ ok: true, data: { orders: [] } }),
  baseUrl: () => 'https://stub.invalid',
});
stub('../lib/mcpDispatchAccess', {
  // lib/mcpDispatchAccess.js의 loadDispatchContext가 실제로 돌려주는 모양 그대로.
  loadDispatchContext: async () => ({
    userId: -1,
    userName: '검사용',
    branchId: null,
    branchName: null,
    repNo: '0000',
    primaryCid: '01000000000',
    usageCids: ['01000000000'],
    linkedCids: [],
    linkNames: {},
    allowedCids: ['01000000000'],
    lookupOrder: ['01000000000'],
    viewerScoped: false,
  }),
  maskPhone: (v) => String(v || ''),
  // 고정 조회 빠른 경로가 이걸 부른다 — 빠뜨리면 조용히 모델 경로로 되돌아가 검사가 헐거워진다.
  logToolCall: async () => {},
  loadOwnedOrders: async () => ({ activeOrders: [], byRcptNo: new Map() }),
  resolveCid: (ctx, cid) => cid || (ctx && ctx.primaryCid) || null,
  loadOidsByCallmanerSlips: async () => new Map(),
  assertOwnedOrder: async () => ({ error: '검사용 스텁' }),
  normalizeCid: (v) => String(v || ''),
  isPlausiblePhone: () => true,
});

const db = require('../db');
const agent = require('../lib/mcpDispatchAgent');
const { shouldProbeDispatch } = require('../routes/orders');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

const USER = { id: -1, branch_id: null, group_id: null, phone: '01000000000', role: 'client' };

async function pendingOf(sessionId) {
  const row = await db.get('SELECT mcp_pending_json FROM chat_sessions WHERE id = ?', [sessionId]);
  return row && row.mcp_pending_json ? JSON.parse(row.mcp_pending_json) : null;
}

(async () => {
  const s = await db.get(
    `INSERT INTO chat_sessions (user_id, status, channel) VALUES (NULL, 'bot', 'web') RETURNING id`
  );
  const sessionId = Number(s.id);

  try {
    console.log('[언제 미리 돌릴지]');
    const SID = 1;
    check('주문 조회는 미리 돌린다', shouldProbeDispatch('내 주문 어떻게 됐어?', null, SID), true);
    check('기사 연락처도', shouldProbeDispatch('기사님 연락처 알려줘', null, SID), true);
    check('어디쯤인지도', shouldProbeDispatch('지금 어디쯤이에요?', null, SID), true);
    check('취소 요청도', shouldProbeDispatch('아까 그거 취소해줘', null, SID), true);
    // 아래는 미리 돌리지 않는다 — 놓쳐도 클라이언트가 직접 부르므로 기능은 그대로다.
    check('일반 FAQ는 돌리지 않는다', shouldProbeDispatch('책임보험 가입도 되나요?', null, SID), false);
    check('오더접수 본문은 돌리지 않는다', shouldProbeDispatch('출발 강남역 도착 판교역 01012345678', null, SID), false);
    check('상담원 요청은 돌리지 않는다', shouldProbeDispatch('상담원 연결해줘', null, SID), false);
    check('되묻는 중이면 돌리지 않는다', shouldProbeDispatch('내 주문 어떻게 됐어?', 'reserved_date', SID), false);
    check('세션이 없으면 돌리지 않는다', shouldProbeDispatch('내 주문 어떻게 됐어?', null, null), false);

    console.log('[모델을 거치지 않는 고정 조회 — 넓힌 말투]');
    const fixed = (t) => agent.matchFixedQuery(t);
    // 새로 인정하는 말투 (기존에는 모델 경로로 새서 3.4초 걸리던 문장들)
    check('"내 주문 어떻게 됐어?"', fixed('내 주문 어떻게 됐어?'), 'active_list');
    check('"주문 어떻게 됐나요?"', fixed('주문 어떻게 됐나요?'), 'active_list');
    check('"제 접수 어떻게 되고 있어요?"', fixed('제 접수 어떻게 되고 있어요?'), 'active_list');
    check('"배차 잘 진행되고 있나요?"', fixed('배차 잘 진행되고 있나요?'), 'active_list');
    // 기존에 되던 것 (회귀 확인)
    check('"주문 내역 알려줘"', fixed('주문 내역 알려줘'), 'active_list');
    check('"접수 현황 좀 보여줘"', fixed('접수 현황 좀 보여줘'), 'active_list');
    // 넓혀도 절대 걸리면 안 되는 것 — 금지어가 먼저 걸러낸다
    check('위치 질문은 제외', fixed('기사님 어디쯤이에요?'), null);
    check('취소 요청은 제외', fixed('내 주문 취소해줘'), null);
    check('기간 조회는 제외', fixed('오늘 주문 어떻게 됐어?'), null);
    check('특정 건 지목은 제외', fixed('2번 주문 어떻게 됐어?'), null);
    check('요금 질문은 제외', fixed('내 주문 요금 얼마야?'), null);
    check('명사 하나만은 제외', fixed('주문'), null);
    check('여러 요청이 섞이면 제외', fixed('주문 어떻게 됐어? 그리고 취소해줘'), null);

    console.log('[확인 대기 중이면 투기 실행은 물러난다]');
    // "네" 한마디로 실행될 상태를 미리 만들어둔다.
    const preset = { action: 'confirm', mcpTool: 'call.create', callArgs: { x: 1 }, createdAt: Date.now() };
    await db.run('UPDATE chat_sessions SET mcp_pending_json = ? WHERE id = ?', [JSON.stringify(preset), sessionId]);

    nextTurn = { parts: [], functionCalls: [], text: '아무 말' };
    let out = await agent.runDispatchAgent({ user: USER, sessionId, text: '네', history: [], speculative: true });
    check('handled=false로 물러난다', out.handled, false);
    check('사유가 speculative_pending', out.reason, 'speculative_pending');
    // 물러났으니 대기 상태는 그대로 있어야 한다 — 지워버리면 고객의 확인이 증발한다.
    check('대기 상태를 지우지 않는다', await pendingOf(sessionId), preset);

    console.log('[변경 도구를 고르면 투기 실행은 멈춘다]');
    await db.run('UPDATE chat_sessions SET mcp_pending_json = NULL WHERE id = ?', [sessionId]);
    nextTurn = {
      parts: [{ functionCall: { name: 'create_order', args: {} } }],
      functionCalls: [{ name: 'create_order', args: {} }],
      text: '',
    };
    out = await agent.runDispatchAgent({ user: USER, sessionId, text: '강남에서 판교로 접수해줘', history: [], speculative: true });
    check('handled=false로 멈춘다', out.handled, false);
    check('사유가 speculative_mutation', out.reason, 'speculative_mutation');
    // 여기가 핵심 — 확인 대기 상태를 남기면 다음 "네"가 이 접수의 동의로 소비된다.
    check('확인 대기 상태를 남기지 않는다', await pendingOf(sessionId), null);

    console.log('[투기가 아니면 예전 그대로 확인을 받는다]');
    await db.run('UPDATE chat_sessions SET mcp_pending_json = NULL WHERE id = ?', [sessionId]);
    out = await agent.runDispatchAgent({ user: USER, sessionId, text: '강남에서 판교로 접수해줘', history: [] });
    // prepareMutation이 인자 검증에 실패해 확인까지 못 갈 수도 있다 — 그건 이 검사의 관심사가
    // 아니다. 중요한 건 "투기가 아닐 때는 speculative_* 로 막히지 않는다"는 것.
    check('speculative 사유로 막히지 않는다', /^speculative_/.test(String(out.reason || '')), false);

    console.log('[고정 조회는 모델을 아예 거치지 않는다]');
    await db.run('UPDATE chat_sessions SET mcp_pending_json = NULL WHERE id = ?', [sessionId]);
    let modelCalls = 0;
    const countingTurn = { parts: [], functionCalls: [], text: '모델이 불렸다' };
    nextTurn = countingTurn;
    const vertexStub = require('../lib/vertexAi');
    const realGen = vertexStub.generateWithTools;
    vertexStub.generateWithTools = async (...args) => { modelCalls += 1; return realGen(...args); };
    out = await agent.runDispatchAgent({ user: USER, sessionId, text: '내 주문 어떻게 됐어?', history: [], speculative: true });
    vertexStub.generateWithTools = realGen;
    check('빠른 경로로 답한다', (out.usedTools || []).join(','), 'get_my_orders(fast)');
    // 여기가 이번 변경의 값이다 — 모델을 한 번도 부르지 않아야 2.3초가 빠진다.
    check('모델 호출 0회', modelCalls, 0);

    console.log('[조회만 하는 라운드는 투기에서도 그대로 답한다]');
    await db.run('UPDATE chat_sessions SET mcp_pending_json = NULL WHERE id = ?', [sessionId]);
    nextTurn = { parts: [], functionCalls: [], text: '진행 중인 주문이 2건 있습니다.' };
    // 고정 조회에 안 걸리는 문장이어야 모델 경로를 본다("자세"가 금지어라 빠른 경로로 안 샌다).
    out = await agent.runDispatchAgent({ user: USER, sessionId, text: '주문 상태 자세히 설명해줘', history: [], speculative: true });
    check('handled=true로 답한다', out.handled, true);
    check('문장을 만든다', out.message, '진행 중인 주문이 2건 있습니다.');
  } finally {
    await db.run('DELETE FROM chat_messages WHERE session_id = ?', [sessionId]).catch(() => {});
    await db.run('DELETE FROM chat_sessions WHERE id = ?', [sessionId]).catch(() => {});
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('검사 실패:', e);
  process.exit(1);
});
