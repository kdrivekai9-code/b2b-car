// 주문 목록 조회 답변을 모델이 아니라 서버가 쓰는지 확인한다.
//
// 왜 필요한가(실사용 사고 2026-08-24, OID1455):
//
//   고객: 오늘 탁송예약건 조회좀
//   AI  : 상태: 대기 (기사 배정됨)
//         요금: 0원
//
// 실제 MCP 응답은 `driver.matched: false`, `fare: 0`이었다(실서버 조회로 확인). 우리 DB도
// callmaner_driver_name이 비어 있었다. 즉 **기사는 배정되지 않았는데 배정됐다고 안내**했고,
// 요금 미정(0)을 "0원"으로 적어 공짜처럼 읽히게 했다.
//
// 원인은 이 답변을 모델이 썼다는 것이다. 서버에는 이미 결정적 포맷터(formatActiveListAnswer)가
// 있는데, "오늘" 같은 기간 표현이 붙으면 고정 조회 빠른 경로(matchFixedQuery)에서 빠져 모델
// 경로로 내려간다. 모델에게는 구조화된 값만 가고 문장은 모델이 쓰므로 사실이 뒤집힐 수 있다.
//
// 이 저장소는 같은 판단을 이미 했다 — 변경 도구의 확인 문구도 모델에게 맡겼다가 실행되지 않은
// 일을 완료된 것처럼 쓰는 사고가 나서 서버가 직접 만들게 바꿨다(describeConfirmation 주석).
//
// 외부 호출(Vertex/MCP)은 전부 가짜로 바꾼다. DB는 쓰지 않는다.
//
//   node scripts/check-order-list-answer.js
require('dotenv').config();

function stub(relPath, exports) {
  const full = require.resolve(relPath);
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
  return exports;
}

// 에이전트가 generateWithTools를 구조분해로 가져가므로(const { generateWithTools } = require(...)),
// 나중에 모듈 속성을 덮어써도 소용없다 — 스텁이 읽는 큐를 바꿔 턴을 순서대로 흘려보낸다.
let turnQueue = [];
stub('../lib/vertexAi', {
  generateWithTools: async () => turnQueue.shift() || { parts: [], functionCalls: [], text: '' },
  generateJson: async () => ({}),
  generateJsonWithImages: async () => ({}),
  embedText: async () => [],
  EMBEDDING_DIMENSIONS: 768,
});

// 실서버에서 받은 그 주문 그대로 — 예약 상태, 기사 미배정, 요금 미정(0).
const ORDER = {
  rcptNo: '180862604',
  st: 'scheduled',
  statusCode: 'R',
  driver: { matched: false, phase: 'scheduled', rawStatusCode: 'R' },
  fare: 0,
  departure: { name: '서울 서초구 방배천로2길 10' },
  arrival: { name: '서울 서초구 서초동 1374' },
  requestedAt: '2026-08-24T22:04:00+09:00',
  scheduledAt: '2026-08-25T15:00:00+09:00',
};

stub('../lib/mcpDispatchClient', {
  isConfigured: () => true,
  listTools: async () => [],
  callTool: async (name) => {
    if (name === 'call.list.active') return { ok: true, data: { orders: [ORDER] } };
    if (name === 'cust.get') return { ok: true, data: { customer: null } };
    return { ok: true, data: {} };
  },
  baseUrl: () => 'https://stub.invalid',
});

// 우리 DB가 아는 값. 콜마너 MCP 프록시가 뒤처질 때 이쪽이 옳다 — 우리 sync는 콜마너
// 단건조회(OrderInfo)를 직접 읽고, 고객에게 나간 통보도 이 값으로 만들어졌다.
let ourRows = new Map();

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
  loadOidsByCallmanerSlips: async () => ourRows,
  assertOwnedOrder: async () => ({ error: '검사용 스텁' }),
  normalizeCid: (v) => String(v || ''),
  isPlausiblePhone: () => true,
  linkCustomerCid: async () => {},
});
stub('../lib/groupActivityFeed', { recordActivity: async () => {} });
stub('../routes/orders', { updateOrderWithCallmaner: async () => {} });

const agent = require('../lib/mcpDispatchAgent');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}${ok || !detail ? '' : `\n         ${detail}`}`);
}

const USER = { id: -1, branch_id: null, group_id: null, phone: '01000000000', role: 'client' };

// 모델이 get_my_orders를 고른 뒤, 다음 턴에서 (사실이 뒤집힌) 문장을 쓴 것으로 꾸민다.
const TOOL_TURN = {
  parts: [{ functionCall: { name: 'get_my_orders', args: {} } }],
  functionCalls: [{ name: 'get_my_orders', args: {} }],
  text: '',
};
const HALLUCINATED = '접수번호 180862604\n상태: 대기 (기사 배정됨)\n요금: 0원';

(async () => {
  console.log('[고정 조회 경로를 타지 않는 질문]');
  // "오늘" 같은 기간 표현이 붙으면 빠른 경로에서 빠진다 — 사고가 난 그 질문이다.
  check('"오늘 탁송예약건 조회좀"은 빠른 경로가 아니다', agent.matchFixedQuery('오늘 탁송예약건 조회좀') === null);
  check('"내 주문 어떻게 됐어?"는 빠른 경로다', agent.matchFixedQuery('내 주문 어떻게 됐어?') === 'active_list');

  console.log('\n[모델이 사실을 뒤집어 써도 서버 문장이 나간다]');
  {
    turnQueue = [TOOL_TURN, { parts: [], functionCalls: [], text: HALLUCINATED }];
    const out = await agent.runDispatchAgent({ user: USER, sessionId: null, text: '오늘 탁송예약건 조회좀', history: [] });
    check('처리했다고 답한다', out.handled === true, JSON.stringify(out));
    const msg = String(out.message || '');
    console.log(`\n${msg.split('\n').map((l) => `      ${l}`).join('\n')}\n`);

    // 핵심 — 기사 미배정을 배정됐다고 말하지 않는다.
    check('"기사 배정됨"이라고 하지 않는다', !/기사 배정됨/.test(msg), msg);
    check('"기사 미배정"으로 밝힌다', /기사 미배정/.test(msg), msg);
    // 요금 0은 무료가 아니라 미정이다 — 서버 포맷터는 아예 숨긴다(formatFare).
    check('"0원"을 적지 않는다', !/0원/.test(msg), msg);
    // 상태도 도구 결과 그대로 — scheduled는 "예약"이다("대기"가 아니다).
    // 조회조건 문구에도 "대기"라는 낱말이 들어 있으므로(진행 중 범위 설명) 상태 줄만 본다.
    const statusLine = msg.split('\n').find((l) => l.trim().startsWith('상태:')) || '';
    check('상태를 도구 값 그대로 옮긴다(예약)', /예약/.test(statusLine) && !/대기/.test(statusLine), statusLine);
    // 모델이 쓴 문장이 그대로 나가지 않았다는 확인.
    check('모델 문장을 쓰지 않는다', msg !== HALLUCINATED, msg);
    check('서버 포맷터 형식이다(번호 매김)', /^1\. 접수번호 /m.test(msg), msg);
  }

  console.log('\n[MCP가 뒤처져도 우리 DB 값으로 답한다]');
  {
    // 실측(2026-08-25): 콜마너 단건조회는 wk_info "T11111*채정식"(기사 배정)인데 MCP는
    // st:"scheduled", driver.matched:false를 줬다. 우리 DB는 '기사배정'이고 배차 통보까지 나갔다.
    ourRows = new Map([['180862604', {
      oid: 'OID1455', callmaner_conf_slip: '180862604', status: '기사배정',
      callmaner_driver_name: '채정식', callmaner_driver_phone: '05083224305',
      origin_address: '서울 서초구 방배천로2길 10', destination_address: '서울 서초구 서초동 1374',
    }]]);
    turnQueue = [TOOL_TURN, { parts: [], functionCalls: [], text: HALLUCINATED }];
    const out = await agent.runDispatchAgent({ user: USER, sessionId: null, text: '오늘 예약건 보여줘', history: [] });
    const msg = String(out.message || '');
    const statusLine = msg.split('\n').find((l) => l.trim().startsWith('상태:')) || '';
    check('우리 상태(기사배정)로 답한다', /기사배정/.test(statusLine), statusLine);
    check('"기사 미배정"이라고 하지 않는다', !/기사 미배정/.test(statusLine), statusLine);
    check('배차 지연으로 몰지 않는다', !/지연/.test(msg) || /지연되고 있는 주문은 없습니다/.test(msg), msg);
  }

  console.log('\n[우리가 완료로 아는 건은 진행 중 목록에서 뺀다]');
  {
    // 실측: 운행완료 통보까지 보낸 OID1459가 MCP 목록에 남아 "예약 (기사 미배정)"으로 보였다.
    ourRows = new Map([['180862604', {
      oid: 'OID1455', callmaner_conf_slip: '180862604', status: '완료',
      callmaner_driver_name: '채정식', callmaner_driver_phone: '05083224305',
    }]]);
    turnQueue = [TOOL_TURN, { parts: [], functionCalls: [], text: HALLUCINATED }];
    const out = await agent.runDispatchAgent({ user: USER, sessionId: null, text: '오늘 예약건 보여줘', history: [] });
    const msg = String(out.message || '');
    check('목록에서 빠진다', !/180862604/.test(msg), msg);
    check('없다고 알린다', /주문이 없습니다/.test(msg), msg);
    ourRows = new Map();
  }

  console.log('\n[조회 말고 다른 도구가 섞이면 모델이 쓴다]');
  {
    // 위치·요금·이력이 섞인 답변은 목록 문장 하나로 대신할 수 없다 — 예전처럼 모델이 쓴다.
    const mixed = {
      parts: [{ functionCall: { name: 'get_my_orders', args: {} } }, { functionCall: { name: 'get_fare_quote', args: {} } }],
      functionCalls: [{ name: 'get_my_orders', args: {} }, { name: 'get_fare_quote', args: {} }],
      text: '',
    };
    turnQueue = [mixed, { parts: [], functionCalls: [], text: '주문 1건과 예상요금을 함께 알려드립니다.' }];
    const out = await agent.runDispatchAgent({ user: USER, sessionId: null, text: '내 주문이랑 강남까지 요금 알려줘', history: [] });
    check('모델 문장이 그대로 나간다', out.message === '주문 1건과 예상요금을 함께 알려드립니다.', JSON.stringify(out.message));
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
