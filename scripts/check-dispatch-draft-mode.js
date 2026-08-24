// 초안 실행(draftMode)이 대기 상태를 남기지 않고, 변경 도구도 문구까지는 만들어 주는지 본다.
//
// 왜 이게 안전장치인가: 상담원 도우미 초안은 **채택될지 모르는** 실행이다. 여기서 확인 대기
// (chat_sessions.mcp_pending_json)를 저장해버리면, 고객이 나중에 다른 맥락에서 보낸 "네"가
// 그 초안의 동의로 소비되어 등록·취소가 실행된다. 되돌릴 수 없는 사고다.
//
// 그렇다고 변경 도구를 만났을 때 그냥 물러나면(투기 실행 speculative의 동작) 수정·취소 요청에는
// 초안이 아예 안 만들어진다 — 상담원이 봇의 도움을 못 받는 구간이 그대로 남는다. 그래서
// draftMode는 "문구는 만들되 상태는 남기지 않는다"로 가른다. 실제 실행은 상담원이 채택해
// 봇이 이어받은 뒤(routes/chat.js) 정식 경로에서 확인을 다시 받고 일어난다.
//
// 외부 호출(Vertex/MCP)은 가짜로 바꾸고, DB는 실제로 쓴다 — 대기 상태가 남는지가 확인 대상이라
// 흉내 내면 의미가 없다. 만든 세션은 지운다.
//
//   node scripts/check-dispatch-draft-mode.js
require('dotenv').config();

function stub(relPath, exports) {
  const full = require.resolve(relPath);
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
  return exports;
}

let turnQueue = [];
stub('../lib/vertexAi', {
  generateWithTools: async () => turnQueue.shift() || { parts: [], functionCalls: [], text: '' },
  generateJson: async () => ({}),
  generateJsonWithImages: async () => ({}),
  embedText: async () => [],
  EMBEDDING_DIMENSIONS: 768,
});

const mcpCalls = [];
stub('../lib/mcpDispatchClient', {
  isConfigured: () => true,
  listTools: async () => [],
  callTool: async (name, args) => { mcpCalls.push(name); return { ok: true, data: { orders: [], ...args } }; },
  baseUrl: () => 'https://stub.invalid',
});

const RCPT_NO = 'draft-mode-check';
stub('../lib/mcpDispatchAccess', {
  loadDispatchContext: async () => ({
    userId: -1, userName: '검사용', branchId: null, branchName: null,
    repNo: '0000', primaryCid: '01000000000', usageCids: ['01000000000'],
    linkedCids: [], linkNames: {}, allowedCids: ['01000000000'],
    lookupOrder: ['01000000000'], viewerScoped: false,
  }),
  maskPhone: (v) => String(v || ''),
  logToolCall: async () => {},
  loadOwnedOrders: async () => ({ activeOrders: [], byRcptNo: new Map() }),
  resolveCid: (ctx, cid) => cid || (ctx && ctx.primaryCid) || null,
  loadOidsByCallmanerSlips: async () => new Map(),
  assertOwnedOrder: async () => ({
    order: {
      rcptNo: RCPT_NO, isCancellable: true, isModifiable: true,
      departure: { name: '서울 강남구' }, arrival: { name: '경기 성남시' },
      scheduledAt: '2026-08-26T14:00:00+09:00', fare: 30000,
    },
  }),
  normalizeCid: (v) => String(v || ''),
  isPlausiblePhone: () => true,
  linkCustomerCid: async () => {},
});
stub('../lib/groupActivityFeed', { recordActivity: async () => {} });
stub('../routes/orders', { updateOrderWithCallmaner: async () => {} });

const db = require('../db');
const agent = require('../lib/mcpDispatchAgent');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

const USER = { id: -1, branch_id: null, group_id: null, phone: '01000000000', role: 'client' };
const MARK = 'e2e-draft-mode-check';

function cancelTurn() {
  const call = { name: 'cancel_order', args: { rcptNo: RCPT_NO } };
  return { parts: [{ functionCall: call }], functionCalls: [call], text: '' };
}

(async () => {
  const created = { sessionId: null };
  try {
    const s = await db.get(
      `INSERT INTO chat_sessions (user_id, status, channel, requested_feature)
       VALUES (NULL, 'agent_active', 'kakao', ?) RETURNING id`,
      [MARK]
    );
    created.sessionId = Number(s.id);
    const pendingOf = async () => {
      const row = await db.get('SELECT mcp_pending_json FROM chat_sessions WHERE id = ?', [created.sessionId]);
      return row && row.mcp_pending_json ? JSON.parse(row.mcp_pending_json) : null;
    };

    console.log('[초안 모드 — 취소 요청]');
    turnQueue = [cancelTurn()];
    const draft = await agent.runDispatchAgent({
      user: USER, sessionId: created.sessionId, text: '주문 취소해줘', history: [], draftMode: true,
    });
    check('확인 문구를 만든다', /취소할까요/.test(String(draft.message || '')), true);
    check('변경 계열이라고 알린다', draft.mutating, true);
    // 핵심 — 채택되지도 않은 초안이 고객의 다음 "네"를 소비하면 안 된다.
    check('대기 상태를 남기지 않는다', await pendingOf(), null);
    check('확인 대기라고 표시하지 않는다', draft.awaitingConfirmation, false);

    console.log('\n[정식 실행 — 같은 요청]');
    turnQueue = [cancelTurn()];
    const real = await agent.runDispatchAgent({
      user: USER, sessionId: created.sessionId, text: '주문 취소해줘', history: [],
    });
    check('같은 확인 문구', real.message, draft.message);
    check('이번에는 대기 상태를 남긴다', !!(await pendingOf()), true);
    check('확인 대기로 표시한다', real.awaitingConfirmation, true);

    console.log('\n[대기 중이면 초안을 만들지 않는다]');
    // 고객이 이미 봇의 확인 질문을 받아둔 상태다 — 초안이 그 "네"를 대신 해석하면 안 된다.
    turnQueue = [cancelTurn()];
    const blocked = await agent.runDispatchAgent({
      user: USER, sessionId: created.sessionId, text: '주문 취소해줘', history: [], draftMode: true,
    });
    check('물러난다', blocked.handled, false);
    check('사유가 draft_pending', blocked.reason, 'draft_pending');
    check('앞선 대기 상태를 지우지 않는다', !!(await pendingOf()), true);
  } catch (e) {
    failures += 1;
    console.error('\n검사 도중 오류:', e && e.stack ? e.stack : e);
  } finally {
    if (created.sessionId) {
      await db.run('DELETE FROM chat_messages WHERE session_id = ?', [created.sessionId]).catch(() => {});
      await db.run('DELETE FROM chat_sessions WHERE id = ? AND requested_feature = ?', [created.sessionId, MARK]).catch(() => {});
      const left = await db.all('SELECT id FROM chat_sessions WHERE requested_feature = ?', [MARK]).catch(() => []);
      if (left.length) { failures += 1; console.error(`정리 실패 — 세션 ${left.map((r) => r.id).join(',')} 남음`); }
    }
    console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
    process.exit(failures ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
