// 배차 도우미로 "접수 후 차량번호 정정"이 실제로 반영되는지 확인한다.
//
// 왜 필요한가: 상담 로그에 "차량번호 수정 합니다. 코란도 157서6830 → 코란도 335모6328" 형태의
// 정정 요청이 반복해서 나오는데, update_order 스키마에 차량 칸이 없어 시간·주소·요금만 되고
// 차량번호만 매번 상담원 인계로 빠졌다.
//
// 확인해야 하는 것이 하나 더 있다. 차량번호는 콜마너로 나가지 않는 값이다(콜마너 오더접수
// payload에 차량 칸이 아예 없다 — lib/callmaner.js buildOrderPayload). 그래서 우리 DB만
// 고치면 그게 반영의 전부이고, 콜마너 MCP(call.update)를 부를 이유가 없다. 부르면 빈 changes로
// 나가서 거부되거나 아무 일도 하지 않는다. 그 호출이 정말로 안 나가는지까지 본다.
//
// 외부 호출(Vertex/MCP/콜마너)은 require.cache를 미리 채워 전부 가짜로 바꾼다. DB는 쓴다 —
// 실제로 orders.vehicle_number가 바뀌는지가 이 기능의 전부라 흉내 내면 확인하는 의미가 없다.
// 만든 오더는 지운다.
//
//   node scripts/check-mcp-vehicle-update.js
require('dotenv').config();

function stub(relPath, exports) {
  const full = require.resolve(relPath);
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
  return exports;
}

let nextTurn = null;
stub('../lib/vertexAi', {
  generateWithTools: async () => nextTurn,
  generateJson: async () => ({}),
  generateJsonWithImages: async () => ({}),
  embedText: async () => [],
  EMBEDDING_DIMENSIONS: 768,
});

const mcpCalls = [];
stub('../lib/mcpDispatchClient', {
  isConfigured: () => true,
  listTools: async () => [],
  callTool: async (name, args) => { mcpCalls.push({ name, args }); return { ok: true, data: {} }; },
  baseUrl: () => 'https://stub.invalid',
});

// 콜마너 자체 연동(OrderModify)도 나가면 안 된다 — 실서버로 수정 요청이 간다.
const callmanerModifyCalls = [];
stub('../routes/orders', {
  updateOrderWithCallmaner: async (orderId, branchId) => { callmanerModifyCalls.push({ orderId, branchId }); },
});
stub('../lib/groupActivityFeed', { recordActivity: async () => {} });

const MARK = 'e2e-mcp-vehicle-check';
// oid·callmaner_conf_slip에는 unique 제약이 있다. 고정값을 쓰면 앞선 실행이 정리에 실패했을 때
// 그 뒤로 영영 돌릴 수 없게 된다(실제로 그렇게 막혔다) — 실행마다 다른 값을 쓰고 흔적은
// MARK(memo_customer)로 찾는다.
const RUN_ID = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const OID = `${MARK}-${RUN_ID}`;
const RCPT_NO = `e2e-vehicle-check-slip-${RUN_ID}`;
let ownedOrder = null;

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
  assertOwnedOrder: async (_ctx, rcptNo) => (
    String(rcptNo) === RCPT_NO ? { order: ownedOrder } : { error: '검사용 스텁 — 대상 아님' }
  ),
  normalizeCid: (v) => String(v || ''),
  isPlausiblePhone: () => true,
  linkCustomerCid: async () => {},
});

const db = require('../db');
const agent = require('../lib/mcpDispatchAgent');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

const USER = { id: -1, branch_id: null, group_id: null, phone: '01000000000', role: 'client' };

// 모델이 update_order를 고른 것으로 꾸민다.
function toolTurn(args) {
  return { parts: [{ functionCall: { name: 'update_order', args } }], functionCalls: [{ name: 'update_order', args }], text: '' };
}

async function orderRow(id) {
  return db.get('SELECT vehicle_number, vehicle_type, fare_amount FROM orders WHERE id = ?', [id]);
}

(async () => {
  const created = { orderId: null, sessionId: null };
  try {
    const branch = await db.get('SELECT id FROM branches ORDER BY id LIMIT 1');
    const order = await db.get(
      `INSERT INTO orders (oid, branch_id, status, origin_address, destination_address,
                           reserved_date, reserved_time, vehicle_type, vehicle_number,
                           callmaner_conf_slip, fare_amount, memo_customer)
       VALUES (?, ?, '접수', '서울 강서구', '경기 성남시', '2026-08-20', '14:00', '코란도', '157서6830', ?, 50000, ?)
       RETURNING id`,
      [OID, branch.id, RCPT_NO, MARK]
    );
    created.orderId = Number(order.id);

    const s = await db.get(`INSERT INTO chat_sessions (user_id, status, channel) VALUES (NULL, 'bot', 'kakao') RETURNING id`);
    created.sessionId = Number(s.id);

    ownedOrder = {
      rcptNo: RCPT_NO,
      isModifiable: true,
      isCancellable: true,
      departure: { name: '서울 강서구' },
      arrival: { name: '경기 성남시' },
      scheduledAt: '2026-08-20T14:00:00+09:00',
      fare: 50000,
    };

    console.log('[번호판 형식이 어긋나면 되묻는다]');
    {
      // 잘못된 번호가 오더에 박히면 현장에서 다른 차를 가져가는 사고가 된다.
      nextTurn = toolTurn({ rcptNo: RCPT_NO, vehicleNumber: '8083692' });
      const out = await agent.runDispatchAgent({ user: USER, sessionId: created.sessionId, text: '차량번호 8083692로 수정해주세요', history: [] });
      check('확인 대기를 만들지 않는다', !!(await agent.loadPending(created.sessionId)), false);
      const before = await orderRow(created.orderId);
      check('차량번호를 건드리지 않는다', before.vehicle_number, '157서6830');
      // 확인 문구를 만들어서는 안 된다 — 만들면 고객의 "네" 한마디로 틀린 번호가 저장된다.
      // (실제로는 모델이 도구 오류를 읽고 고객에게 되묻는다. 여기서는 모델을 같은 응답만
      // 돌려주도록 고정해뒀으므로 도우미가 라운드를 소진하고 물러난다.)
      check('확인 문구를 만들지 않는다', out.handled, false);
    }

    console.log('\n[차량번호만 정정 — 확인 문구]');
    nextTurn = toolTurn({ rcptNo: RCPT_NO, vehicleNumber: '335모6328', vehicleType: '코란도' });
    const first = await agent.runDispatchAgent({
      user: USER, sessionId: created.sessionId, text: '차량번호 수정합니다. 코란도 335모6328', history: [],
    });
    check('처리했다고 답한다', first.handled, true);
    check('확인 문구에 차량을 보여준다', /코란도 335모6328/.test(first.message || ''), true);
    check('아직 실행하지 않는다', (await orderRow(created.orderId)).vehicle_number, '157서6830');

    const pending = await agent.loadPending(created.sessionId);
    check('확인 대기가 저장됐다', pending && pending.mcpTool, 'call.update');
    // JSON으로 저장됐다 되읽히는 경로다 — 여기서 빠지면 다음 턴에 차량번호가 사라진다.
    check('차량 변경분이 저장에서 살아남는다', pending && pending.localChanges, { vehicleNumber: '335모6328', vehicleType: '코란도' });
    check('콜마너로 보낼 변경은 비어 있다', pending && pending.callArgs.changes, {});

    console.log('\n[고객이 "네"라고 답하면 실행한다]');
    nextTurn = { parts: [], functionCalls: [], text: '' };
    const second = await agent.runDispatchAgent({ user: USER, sessionId: created.sessionId, text: '네', history: [] });
    check('처리했다고 답한다', second.handled, true);

    const after = await orderRow(created.orderId);
    check('차량번호가 바뀐다', after.vehicle_number, '335모6328');
    check('차종도 반영된다', after.vehicle_type, '코란도');
    check('다른 값은 건드리지 않는다', Number(after.fare_amount), 50000);
    // 차량번호는 콜마너로 나가지 않는 값이라, 두 외부 경로 모두 부를 이유가 없다.
    check('콜마너 MCP를 부르지 않는다', mcpCalls.map((c) => c.name), []);
    check('콜마너 OrderModify도 부르지 않는다', callmanerModifyCalls.length, 0);

    const history = await db.get(
      `SELECT note FROM order_status_history WHERE order_id = ? ORDER BY id DESC LIMIT 1`,
      [created.orderId]
    );
    check('무엇이 무엇으로 바뀌었는지 이력에 남는다', /코란도\/157서6830 → 코란도\/335모6328/.test((history && history.note) || ''), true);

    console.log('\n[요금과 함께 바꾸면 콜마너에도 반영한다]');
    ownedOrder.fare = 50000;
    nextTurn = toolTurn({ rcptNo: RCPT_NO, vehicleNumber: '111가2222', fare: 60000 });
    await agent.runDispatchAgent({ user: USER, sessionId: created.sessionId, text: '차량번호 111가2222, 요금 6만원으로 변경', history: [] });
    const pending2 = await agent.loadPending(created.sessionId);
    check('요금은 콜마너 쪽 변경으로 간다', pending2 && pending2.callArgs.changes, { fare: 60000 });
    check('차량은 우리 쪽 변경으로 남는다', pending2 && pending2.localChanges, { vehicleNumber: '111가2222' });

    nextTurn = { parts: [], functionCalls: [], text: '' };
    await agent.runDispatchAgent({ user: USER, sessionId: created.sessionId, text: '네', history: [] });
    const after2 = await orderRow(created.orderId);
    check('차량번호가 또 바뀐다', after2.vehicle_number, '111가2222');
    check('요금도 바뀐다', Number(after2.fare_amount), 60000);
    check('이번에는 콜마너 MCP를 부른다', mcpCalls.map((c) => c.name), ['call.update']);
    check('콜마너 OrderModify도 부른다', callmanerModifyCalls.length, 1);
  } catch (e) {
    // 여기서 잡아 실패로 세지 않으면, 검사가 중간에 터져도 아래 finally가 "모두 통과"를 찍고
    // 0으로 끝난다(실제로 그렇게 만들었다가 잡았다). 정리는 finally가 그대로 이어서 한다.
    failures += 1;
    console.error('\n검사 도중 오류:', e && e.stack ? e.stack : e);
  } finally {
    // 정리 실패를 삼키면 검사용 오더가 실서비스 목록에 남는다. 조용히 넘기지 않고 알린다.
    const cleanupErrors = [];
    const purge = async (label, sql, params) => {
      await db.run(sql, params).catch((e) => cleanupErrors.push(`${label}: ${e.message}`));
    };
    if (created.orderId) {
      await purge('이력', 'DELETE FROM order_status_history WHERE order_id = ?', [created.orderId]);
      await purge('오더', 'DELETE FROM orders WHERE id = ? AND memo_customer = ?', [created.orderId, MARK]);
    }
    if (created.sessionId) {
      await purge('대화', 'DELETE FROM chat_messages WHERE session_id = ?', [created.sessionId]);
      await purge('세션', 'DELETE FROM chat_sessions WHERE id = ?', [created.sessionId]);
    }
    // 정말로 지워졌는지 확인한다 — DELETE가 0행을 지워도 오류는 나지 않는다.
    const leftover = await db.all(
      'SELECT id FROM orders WHERE memo_customer = ?', [MARK]
    ).catch(() => []);
    if (leftover.length) cleanupErrors.push(`오더 ${leftover.map((r) => r.id).join(',')}가 남았습니다`);
    if (cleanupErrors.length) {
      failures += 1;
      console.error(`\n정리 실패 — 직접 지워야 합니다:\n  ${cleanupErrors.join('\n  ')}`);
    }
    console.log(`\n정리: order=${created.orderId}, session=${created.sessionId}`);
    console.log(failures ? `${failures}건 실패` : '모두 통과');
    process.exit(failures ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
