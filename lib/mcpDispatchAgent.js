// 챗봇의 "배차 주문 도우미" — Gemini function calling으로 콜마너 MCP 도구를 골라 호출하고,
// 그 결과를 한국어 문장으로 답한다. 지금까지 intent:'unsupported'(주문조회/취소/변경 등)로 분류돼
// 곧바로 상담원 연결로 넘어갔던 요청들을 봇이 직접 처리하는 것이 목적이다.
//
// 설계상 중요한 두 가지:
//  1) LLM에게 노출하는 도구 스키마에는 cid(고객 연락처)/repNo(대표번호)가 없다 — 서버가 로그인
//     세션에서 확정해 주입한다(lib/mcpDispatchAccess.js). 모델이 임의의 전화번호를 만들어내도
//     그 번호로 조회/변경이 나갈 수 없다.
//  2) 등록/수정/취소는 "확인 후 실행" 2단계다. 1단계에서는 실행하지 않고 확인 대기 상태를 DB
//     (chat_sessions.mcp_pending_json)에 저장하고 모델에게 "사용자에게 확인을 받아라"라고 알려준다.
//     실제 실행은 다음 턴에 사용자가 동의했을 때 서버가 직접 한다 — 모델이 스스로 confirmed를
//     만들어 넣는 방식이면 동의 없는 실행을 막을 수 없다.
const crypto = require('crypto');
const db = require('../db');
const mcp = require('./mcpDispatchClient');
const access = require('./mcpDispatchAccess');
const { generateWithTools } = require('./vertexAi');
const { classifyPhaseReply } = require('./hybridChat');
const { kstNow, toDateStr } = require('./period');

const MAX_TOOL_ROUNDS = 4;
const MAX_HISTORY_MESSAGES = 10;
const PENDING_TTL_MS = 10 * 60 * 1000;

// ---------------- LLM에 노출하는 도구 정의 ----------------
// 이름을 MCP 원본 그대로 두지 않고 한글 의미가 드러나는 스네이크 이름으로 바꿨다 — 모델이
// place.find.origin/destination 같은 이름을 헷갈려 출발지 검색 도구로 도착지를 찾는 일이 있었다.
const PLACE_SCHEMA = {
  type: 'OBJECT',
  description: '장소. 반드시 장소검색 도구가 돌려준 값을 그대로 쓰세요(좌표를 직접 만들지 마세요).',
  properties: {
    name: { type: 'STRING', description: '장소명' },
    region: { type: 'STRING', description: '행정구역' },
    xy: { type: 'STRING', description: '좌표 "위도,경도"' },
    address: { type: 'STRING', description: '주소' },
  },
  required: ['name', 'xy'],
};

const TOOL_DECLARATIONS = [
  {
    name: 'search_place',
    description: '출발지/도착지/경유지로 쓸 장소 후보를 검색합니다. 주문 등록이나 요금 조회 전에 좌표를 얻으려면 반드시 이 도구를 먼저 쓰세요.',
    parameters: {
      type: 'OBJECT',
      properties: {
        keyword: { type: 'STRING', description: '검색 키워드(예: "사당역", "강남역 1번출구")' },
        kind: { type: 'STRING', enum: ['origin', 'destination'], description: '출발지 검색이면 origin, 도착지/경유지 검색이면 destination' },
      },
      required: ['keyword', 'kind'],
    },
  },
  {
    name: 'get_my_orders',
    description: '고객의 진행 중인 배차 주문 목록과 고객 정보(이용 가능 여부, 결제수단 등)를 조회합니다. "내 주문 어떻게 됐어요", "기사 배정됐나요" 같은 질문에 사용하세요.',
    parameters: {
      type: 'OBJECT',
      properties: {
        customerPhone: { type: 'STRING', description: '실제 이용 고객의 연락처. 본인 주문을 볼 때는 넣지 마세요. 직접 접수해준 다른 이용자의 주문을 볼 때만 그 번호를 넣으세요.' },
      },
    },
  },
  {
    name: 'get_order_history',
    description: '지난 배차 주문 이력을 조회합니다. 기간을 물어보면 startDate/endDate를 채우세요.',
    parameters: {
      type: 'OBJECT',
      properties: {
        customerPhone: { type: 'STRING', description: '실제 이용 고객의 연락처(본인 이력이면 생략)' },
        startDate: { type: 'STRING', description: '조회 시작일 YYYY-MM-DD' },
        endDate: { type: 'STRING', description: '조회 종료일 YYYY-MM-DD' },
        pageSize: { type: 'INTEGER', description: '가져올 건수(기본 10, 최대 30)' },
      },
    },
  },
  {
    name: 'get_fare_quote',
    description: '출발지와 도착지 기준 예상 요금을 조회합니다. 장소는 search_place 결과를 그대로 넣으세요.',
    parameters: {
      type: 'OBJECT',
      properties: {
        departure: PLACE_SCHEMA,
        arrival: PLACE_SCHEMA,
        waypoints: { type: 'ARRAY', items: PLACE_SCHEMA, description: '경유지 목록(있을 때만)' },
      },
      required: ['departure', 'arrival'],
    },
  },
  {
    name: 'get_eta',
    description: '두 좌표 사이의 예상 소요시간과 거리를 조회합니다.',
    parameters: {
      type: 'OBJECT',
      properties: {
        fromXY: { type: 'STRING', description: '출발 좌표 "위도,경도"' },
        toXY: { type: 'STRING', description: '도착 좌표 "위도,경도"' },
        viaXY: { type: 'STRING', description: '경유 좌표(있을 때만)' },
      },
      required: ['fromXY', 'toXY'],
    },
  },
  {
    name: 'create_order',
    description: '배차 주문(즉시 호출 또는 예약)을 등록합니다. 출발지/도착지 좌표는 search_place로 먼저 확정해야 합니다. 이 도구는 곧바로 등록되지 않고 사용자 확인을 한 번 받습니다.',
    parameters: {
      type: 'OBJECT',
      properties: {
        customerPhone: { type: 'STRING', description: '실제 차량을 이용할 고객의 연락처. 본인이 이용하면 생략하세요. 본인이 아닌 실제 이용자를 위해 접수하는 경우 그 사람의 휴대폰 번호를 넣으세요.' },
        customerName: { type: 'STRING', description: '실제 이용 고객 이름(알고 있을 때만)' },
        serviceType: { type: 'STRING', enum: ['immediate', 'scheduled'], description: '즉시 호출이면 immediate, 예약이면 scheduled' },
        scheduledAt: { type: 'STRING', description: '예약 시각 "YYYY-MM-DD HH:mm" (serviceType이 scheduled면 필수)' },
        departure: PLACE_SCHEMA,
        arrival: PLACE_SCHEMA,
        waypoints: { type: 'ARRAY', items: PLACE_SCHEMA, description: '경유지 목록(있을 때만)' },
        fare: { type: 'INTEGER', description: '요금(원). get_fare_quote로 확인한 금액' },
        notes: { type: 'STRING', description: '기사 전달 메모' },
      },
      required: ['departure', 'arrival'],
    },
  },
  {
    name: 'update_order',
    description: '진행 중인 배차 주문의 예약시각/경로/요금/메모를 변경합니다. 대상은 접수번호(rcptNo)로 지정하며, 사용자 확인을 한 번 받습니다.',
    parameters: {
      type: 'OBJECT',
      properties: {
        rcptNo: { type: 'STRING', description: '변경할 주문의 접수번호. 모르면 get_my_orders로 먼저 확인하세요.' },
        scheduledAt: { type: 'STRING', description: '변경할 예약 시각 "YYYY-MM-DD HH:mm"' },
        departure: PLACE_SCHEMA,
        arrival: PLACE_SCHEMA,
        fare: { type: 'INTEGER', description: '변경할 요금(원)' },
        notes: { type: 'STRING', description: '변경할 메모' },
      },
      required: ['rcptNo'],
    },
  },
  {
    name: 'raise_fare',
    description: '배차가 지연될 때 진행 중인 주문의 요금을 인상합니다. 고객이 "요금 올려주세요"라고 요청할 때 사용하세요. 사용자 확인을 한 번 받습니다.',
    parameters: {
      type: 'OBJECT',
      properties: {
        rcptNo: { type: 'STRING', description: '요금을 인상할 주문의 접수번호. 모르면 get_my_orders로 먼저 확인하세요.' },
        raiseAmount: { type: 'INTEGER', description: `인상 금액(원). 고객이 금액을 말하지 않으면 넣지 마세요(기본 ${5000}원).` },
      },
      required: ['rcptNo'],
    },
  },
  {
    name: 'cancel_order',
    description: '진행 중인 배차 주문을 취소합니다. 대상은 접수번호(rcptNo)로 지정하며, 사용자 확인을 한 번 받습니다.',
    parameters: {
      type: 'OBJECT',
      properties: {
        rcptNo: { type: 'STRING', description: '취소할 주문의 접수번호. 모르면 get_my_orders로 먼저 확인하세요.' },
        reason: { type: 'STRING', description: '취소 사유(고객이 말한 경우만)' },
      },
      required: ['rcptNo'],
    },
  },
];

const MUTATING_TOOLS = new Set(['create_order', 'update_order', 'cancel_order', 'raise_fare']);

// 배차 지연 시 요금 인상 제안 기준 — 사용자 확정 사항(접수 후 5분 경과, 5,000원 인상).
const DELAY_OFFER_MINUTES = Number(process.env.MCP_DISPATCH_DELAY_MINUTES || 5);
const DEFAULT_RAISE_AMOUNT = Number(process.env.MCP_DISPATCH_FARE_RAISE_AMOUNT || 5000);

// ---------------- 시스템 프롬프트 ----------------
function buildSystemInstruction(ctx) {
  const now = kstNow();
  const pad = (n) => String(n).padStart(2, '0');
  const todayISO = toDateStr(now);
  const nowHHmm = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
  const linkedList = ctx.linkedCids.length
    ? ctx.linkedCids.map((c) => `${c}${ctx.linkNames[c] ? '(' + ctx.linkNames[c] + ')' : ''}`).join(', ')
    : '없음';

  return `당신은 B2B 배차(대리운전) 플랫폼의 주문 상담 챗봇입니다. 고객의 요청을 읽고 필요한 도구를 호출해
실제 데이터를 확인한 뒤, 한국어로 간결하게(3~5줄 이내) 답하세요.

[지금 시각] ${todayISO} ${nowHHmm} (KST). "오늘/내일/이번 주 토요일" 같은 표현은 이 시각 기준으로 계산하세요.

[상담 중인 고객]
- 이름: ${ctx.userName}
- 소속 지사: ${ctx.branchName || '미지정'}
- 본인 연락처(기본 조회 대상): ${ctx.primaryCid || '미등록'}
- 이 고객이 대신 접수해준 실제 이용 고객 연락처: ${linkedList}

[권한 규칙 — 반드시 지키세요]
- 조회/변경/취소는 위에 적힌 연락처의 주문에 대해서만 가능합니다. 목록에 없는 번호를 요청받으면
  "직접 접수하신 주문만 확인해드릴 수 있습니다"라고 안내하세요.
- 전화번호를 추측해서 만들지 마세요. 고객이 직접 말해준 번호만 사용하세요.
- 본인 주문을 볼 때는 customerPhone을 넣지 마세요(서버가 본인 번호로 처리합니다).
- 새 이용자의 번호로 주문을 등록하면 그 이후로는 그 이용자의 주문도 조회/변경/취소할 수 있게 됩니다.

[도구 사용 규칙]
- 주문번호(접수번호)를 모르면 먼저 get_my_orders로 확인한 다음 변경/취소를 시도하세요.
- 장소가 필요한 도구(요금조회/주문등록/경로변경)는 반드시 search_place 결과의 좌표를 그대로 쓰세요.
  좌표를 직접 만들어내면 안 됩니다.
- 후보 장소가 여러 개면 임의로 고르지 말고 고객에게 어느 곳인지 물어보세요.
- 등록/변경/취소는 호출해도 곧바로 실행되지 않습니다. 시스템이 확인 문구를 만들어 고객에게 보여주고
  동의를 받은 뒤 실행합니다. 그러니 **당신이 미리 "예약하시겠습니까?"라고 되묻지 말고**, 필요한 정보가
  모였으면 곧바로 해당 도구를 호출하세요.
- 필수 정보(예: 예약 주문의 예약시각, 출발지/도착지)가 없으면 도구를 억지로 부르지 말고 물어보세요.

[답변 작성 규칙]
- 도구 결과에 없는 사실을 만들어내지 마세요. 조회 결과가 없으면 없다고 그대로 말하세요.
- 주문을 안내할 때는 접수번호, 출발지→도착지, 예약/요청 시각, 상태(기사 배정 여부), 요금을 담으세요.
- 요금은 "12,000원"처럼 천단위 쉼표를 넣으세요.
- 배차/요금/취소 규정에 대한 일반 정책 질문이거나, 도구로 확인할 수 없는 요청이면 억지로 답하지 말고
  "상담원에게 연결해드릴까요?"라고 제안하세요.`;
}

// ---------------- 도구 실행(권한 주입 + 소유 확인) ----------------
function placeArg(place) {
  if (!place || typeof place !== 'object') return null;
  const xy = String(place.xy || '').trim();
  if (!xy) return null;
  return {
    name: String(place.name || '').trim(),
    region: String(place.region || '').trim(),
    xy,
    address: String(place.address || '').trim(),
  };
}

// 요금 인상 안내에는 "출발지 상세주소 → 도착지 상세주소" 형태로 보여준다(사용자 확정 문구) —
// 상세주소(address)가 비어 있는 장소도 있어 그때는 장소명으로 대체한다.
function placeLabel(place) {
  if (!place) return '-';
  const address = String(place.address || '').trim();
  const name = String(place.name || '').trim();
  if (address && name && address.indexOf(name) === -1) return `${name} ${address}`;
  return address || name || '-';
}

function pendingSignature(toolName, args) {
  return crypto.createHash('sha256').update(toolName + '|' + JSON.stringify(args || {})).digest('hex').slice(0, 32);
}

async function savePending(sessionId, pending) {
  if (!sessionId) return;
  try {
    await db.run('UPDATE chat_sessions SET mcp_pending_json = ? WHERE id = ?', [JSON.stringify(pending), sessionId]);
  } catch (e) {
    console.error('MCP 확인대기 상태 저장 실패:', e.message);
  }
}

async function clearPending(sessionId) {
  if (!sessionId) return;
  try {
    await db.run('UPDATE chat_sessions SET mcp_pending_json = NULL WHERE id = ?', [sessionId]);
  } catch (e) {
    console.error('MCP 확인대기 상태 삭제 실패:', e.message);
  }
}

async function loadPending(sessionId) {
  if (!sessionId) return null;
  let row;
  try {
    row = await db.get('SELECT mcp_pending_json FROM chat_sessions WHERE id = ?', [sessionId]);
  } catch (e) {
    // 마이그레이션 전이면 컬럼이 없다 — 확인 2단계 없이 동작하는 게 아니라, 변경 계열 도구를
    // 아예 실행하지 않는 쪽으로 안전하게 퇴화한다(executePending이 불릴 일이 없음).
    console.error('MCP 확인대기 상태 조회 실패:', e.message);
    return null;
  }
  if (!row || !row.mcp_pending_json) return null;
  try {
    const parsed = JSON.parse(row.mcp_pending_json);
    if (!parsed || !parsed.createdAt || (Date.now() - parsed.createdAt) > PENDING_TTL_MS) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

// 실제 MCP 호출로 이어지는 부분. 반환값은 그대로 모델에게 functionResponse로 주입된다.
async function runReadTool(ctx, sessionId, toolName, args) {
  if (toolName === 'search_place') {
    const keyword = String(args.keyword || '').trim();
    if (!keyword) return { ok: false, error: '검색할 장소명이 없습니다.' };
    const mcpTool = args.kind === 'origin' ? 'place.find.origin' : 'place.find.destination';
    const out = await mcp.callTool(mcpTool, { keyword });
    await access.logToolCall(ctx, sessionId, mcpTool, { keyword }, out.ok, out.error);
    if (!out.ok) return { ok: false, error: out.error };
    return { ok: true, hits: (out.data && out.data.hits) || [] };
  }

  if (toolName === 'get_my_orders') {
    const resolved = access.resolveCid(ctx, args.customerPhone);
    if (resolved.error) return { ok: false, error: resolved.error };
    const [profile, active] = await Promise.all([
      mcp.callTool('cust.get', { repNo: ctx.repNo, cid: resolved.cid }),
      mcp.callTool('call.list.active', { repNo: ctx.repNo, cid: resolved.cid }),
    ]);
    await access.logToolCall(ctx, sessionId, 'cust.get+call.list.active', { cid: resolved.cid }, profile.ok, profile.error);
    if (!profile.ok && !active.ok) {
      return { ok: false, error: profile.error || active.error, hint: '이 연락처는 배차 시스템에 등록된 고객이 아닙니다.' };
    }
    const customer = (profile.data && profile.data.customer) || null;
    return {
      ok: true,
      cid: resolved.cid,
      customer: customer ? {
        name: customer.name, grade: customer.grade, corpName: customer.corpName,
        availableCharge: customer.availableCharge, mileageBalance: customer.mileageBalance,
      } : null,
      capabilities: (profile.data && profile.data.capabilities) || null,
      activeOrders: (active.data && active.data.orders) || [],
    };
  }

  if (toolName === 'get_order_history') {
    const resolved = access.resolveCid(ctx, args.customerPhone);
    if (resolved.error) return { ok: false, error: resolved.error };
    const callArgs = { repNo: ctx.repNo, cid: resolved.cid, page: 1, pageSize: Math.min(Number(args.pageSize) || 10, 30) };
    if (args.startDate) callArgs.startDate = String(args.startDate).trim();
    if (args.endDate) callArgs.endDate = String(args.endDate).trim();
    const out = await mcp.callTool('call.list.history', callArgs);
    await access.logToolCall(ctx, sessionId, 'call.list.history', callArgs, out.ok, out.error);
    if (!out.ok) return { ok: false, error: out.error };
    return { ok: true, cid: resolved.cid, orders: (out.data && out.data.orders) || [] };
  }

  if (toolName === 'get_fare_quote') {
    const departure = placeArg(args.departure);
    const arrival = placeArg(args.arrival);
    if (!departure || !arrival) return { ok: false, error: '출발지와 도착지 좌표가 필요합니다. search_place로 먼저 확인하세요.' };
    const callArgs = { repNo: ctx.repNo, departure, arrival };
    const waypoints = Array.isArray(args.waypoints) ? args.waypoints.map(placeArg).filter(Boolean) : [];
    if (waypoints.length) callArgs.waypoints = waypoints;
    const out = await mcp.callTool('fare.get', callArgs);
    await access.logToolCall(ctx, sessionId, 'fare.get', callArgs, out.ok, out.error);
    return out.ok ? { ok: true, ...out.data } : { ok: false, error: out.error };
  }

  if (toolName === 'get_eta') {
    const callArgs = { fromXY: String(args.fromXY || '').trim(), toXY: String(args.toXY || '').trim() };
    if (!callArgs.fromXY || !callArgs.toXY) return { ok: false, error: '출발/도착 좌표가 필요합니다.' };
    if (args.viaXY) callArgs.viaXY = String(args.viaXY).trim();
    const out = await mcp.callTool('eta.get', callArgs);
    await access.logToolCall(ctx, sessionId, 'eta.get', callArgs, out.ok, out.error);
    return out.ok ? { ok: true, ...out.data } : { ok: false, error: out.error };
  }

  return { ok: false, error: '알 수 없는 도구입니다.' };
}

// 변경 계열 도구의 1단계: 실행하지 않고 인자를 검증해 확인 대기 상태로 저장한다.
// 여기서 이미 권한(cid 허용 여부/주문 소유)을 확인해두므로, 2단계 실행은 그대로 내보내도 안전하다.
async function prepareMutation(ctx, sessionId, toolName, args) {
  if (toolName === 'create_order') {
    const departure = placeArg(args.departure);
    const arrival = placeArg(args.arrival);
    if (!departure || !arrival) return { ok: false, error: '출발지와 도착지를 search_place로 먼저 확정해야 합니다.' };

    const resolved = access.resolveCid(ctx, args.customerPhone, { allowNew: true });
    if (resolved.error) return { ok: false, error: resolved.error };

    const serviceType = args.serviceType === 'scheduled' ? 'scheduled' : 'immediate';
    const scheduledAt = String(args.scheduledAt || '').trim();
    if (serviceType === 'scheduled' && !scheduledAt) {
      return { ok: false, error: '예약 주문은 예약 시각(YYYY-MM-DD HH:mm)이 필요합니다. 고객에게 물어보세요.' };
    }

    const callArgs = { repNo: ctx.repNo, cid: resolved.cid, serviceType, departure, arrival };
    if (scheduledAt) callArgs.scheduledAt = scheduledAt;
    const waypoints = Array.isArray(args.waypoints) ? args.waypoints.map(placeArg).filter(Boolean) : [];
    if (waypoints.length) callArgs.waypoints = waypoints;
    if (Number.isFinite(Number(args.fare)) && Number(args.fare) > 0) callArgs.fare = Math.round(Number(args.fare));
    if (args.notes) callArgs.notes = String(args.notes).slice(0, 200);

    return {
      ok: true,
      pending: {
        mcpTool: 'call.create',
        callArgs,
        linkCid: resolved.isNew ? resolved.cid : null,
        linkName: args.customerName ? String(args.customerName).slice(0, 40) : null,
        summary: {
          동작: '배차 주문 등록',
          이용고객: resolved.cid + (resolved.isNew ? ' (신규 이용고객으로 등록됩니다)' : ''),
          구분: serviceType === 'scheduled' ? '예약' : '즉시',
          예약시각: scheduledAt || null,
          출발지: departure.name,
          도착지: arrival.name,
          경유지: waypoints.map((w) => w.name),
          요금: callArgs.fare || null,
          메모: callArgs.notes || null,
        },
      },
    };
  }

  if (toolName === 'raise_fare') {
    const rcptNo = String(args.rcptNo || '').trim();
    const owned = await access.assertOwnedOrder(ctx, rcptNo);
    if (owned.error) return { ok: false, error: owned.error };
    const order = owned.order;
    if (order.isFareAdjustable === false) {
      return { ok: false, error: '이 주문은 현재 요금을 조정할 수 없는 상태입니다. 상담원 연결이 필요합니다.' };
    }
    const currentFare = Math.round(Number(order.fare) || 0);
    if (currentFare <= 0) {
      return { ok: false, error: '현재 요금을 확인할 수 없어 요금 인상을 진행할 수 없습니다. 상담원 연결이 필요합니다.' };
    }
    const raiseAmount = Math.round(Number(args.raiseAmount) > 0 ? Number(args.raiseAmount) : DEFAULT_RAISE_AMOUNT);
    return {
      ok: true,
      pending: {
        // call.raise는 낙관적 동시성 제어를 위해 currentFare를 함께 요구한다 — 우리가 방금 조회한
        // 요금과 콜마너의 현재 요금이 다르면(다른 경로로 이미 조정됨) 콜마너가 거부한다.
        mcpTool: 'call.raise',
        callArgs: { rcptNo, currentFare, raiseFare: raiseAmount },
        summary: {
          동작: '배차 요금 인상',
          접수번호: rcptNo,
          출발지: placeLabel(order.departure),
          도착지: placeLabel(order.arrival),
          현재요금: currentFare,
          인상금액: raiseAmount,
          인상후요금: currentFare + raiseAmount,
        },
      },
    };
  }

  if (toolName === 'update_order' || toolName === 'cancel_order') {
    const rcptNo = String(args.rcptNo || '').trim();
    const owned = await access.assertOwnedOrder(ctx, rcptNo);
    if (owned.error) return { ok: false, error: owned.error };
    const order = owned.order;

    if (toolName === 'cancel_order') {
      if (order.isCancellable === false) {
        return { ok: false, error: '이 주문은 현재 취소할 수 없는 상태입니다(이미 진행/완료됨). 상담원 연결이 필요합니다.' };
      }
      const callArgs = { rcptNo };
      if (args.reason) callArgs.reason = String(args.reason).slice(0, 100);
      return {
        ok: true,
        pending: {
          mcpTool: 'call.cancel',
          callArgs,
          summary: {
            동작: '배차 주문 취소',
            접수번호: rcptNo,
            경로: `${(order.departure && order.departure.name) || '-'} → ${(order.arrival && order.arrival.name) || '-'}`,
            예약시각: order.scheduledAt || order.requestedAt || null,
            사유: callArgs.reason || null,
          },
        },
      };
    }

    if (order.isModifiable === false) {
      return { ok: false, error: '이 주문은 현재 변경할 수 없는 상태입니다. 상담원 연결이 필요합니다.' };
    }
    const changes = {};
    if (args.scheduledAt) changes.scheduledAt = String(args.scheduledAt).trim();
    const newDeparture = placeArg(args.departure);
    const newArrival = placeArg(args.arrival);
    if (newDeparture) changes.departure = newDeparture;
    if (newArrival) changes.arrival = newArrival;
    if (Number.isFinite(Number(args.fare)) && Number(args.fare) > 0) changes.fare = Math.round(Number(args.fare));
    if (args.notes) changes.notes = String(args.notes).slice(0, 200);
    if (Object.keys(changes).length === 0) {
      return { ok: false, error: '무엇을 변경할지 확인되지 않았습니다. 변경할 항목(예약시각/출발지/도착지/요금/메모)을 고객에게 물어보세요.' };
    }

    return {
      ok: true,
      pending: {
        mcpTool: 'call.update',
        callArgs: { orderId: rcptNo, changes },
        summary: {
          동작: '배차 주문 변경',
          접수번호: rcptNo,
          변경내용: changes,
        },
      },
    };
  }

  return { ok: false, error: '알 수 없는 도구입니다.' };
}

// 콜마너는 등록되지 않은 연락처로는 주문을 접수해주지 않는다(call.create → CUSTOMER_NOT_FOUND,
// 실서버로 확인). MCP 도구 카탈로그에 고객 등록 도구가 없어서 우리가 그 번호를 새로 만들 수도 없다.
// 그래서 제3자(실제 이용고객) 번호가 미등록이면, 등록고객 본인 명의로 접수하고 실제 이용고객
// 연락처를 메모에 남기는 대안을 한 번 더 확인받는다(조용히 바꿔치기하지 않는다).
function buildUnregisteredCidFallback(ctx, pending) {
  if (pending.mcpTool !== 'call.create' || !pending.linkCid || !ctx.primaryCid) return null;
  if (pending.fallbackOf) return null; // 이미 대안으로 만들어진 건 다시 대안을 만들지 않는다
  const memo = `실제 이용고객 연락처 ${pending.linkCid}`;
  const notes = pending.callArgs.notes ? `${pending.callArgs.notes} / ${memo}` : memo;
  return {
    ...pending,
    fallbackOf: 'unregistered_cid',
    linkCid: null,
    callArgs: { ...pending.callArgs, cid: ctx.primaryCid, notes },
    summary: { ...pending.summary, 이용고객: `${ctx.primaryCid} (접수자 명의) / 실제 이용고객 ${pending.linkCid}`, 메모: notes },
  };
}

// 변경 계열 도구의 2단계: 사용자가 동의한 뒤 서버가 직접 실행한다.
async function executePending(ctx, sessionId, pending) {
  const out = await mcp.callTool(pending.mcpTool, pending.callArgs, { timeoutMs: 20000 });
  await access.logToolCall(ctx, sessionId, pending.mcpTool, pending.callArgs, out.ok, out.error);
  if (!out.ok) {
    if (/CUSTOMER_NOT_FOUND/i.test(String(out.error || ''))) {
      const fallback = buildUnregisteredCidFallback(ctx, pending);
      if (fallback) return { ok: false, error: out.error, fallback };
    }
    return { ok: false, error: out.error };
  }
  if (pending.linkCid) await access.linkCustomerCid(ctx, pending.linkCid, pending.linkName);
  return { ok: true, data: out.data || {} };
}

function formatFare(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n.toLocaleString('ko-KR') + '원';
}

// 확인 질문도 서버가 직접 만든다. 처음에는 도구 결과(needsConfirmation)를 모델에게 돌려주고
// 모델이 확인 문구를 쓰게 했는데, 실제로 "예약 접수되었습니다. 이대로 진행할까요?"처럼 아직
// 실행되지 않은 일을 완료된 것처럼 쓰는 응답이 나왔다(시뮬레이션에서 재현). 되돌리기 어려운
// 행위의 확인/결과 문구만큼은 모델에게 맡기지 않는다.
function describeConfirmation(pending, options) {
  const s = pending.summary || {};
  const lines = [];
  // omitHeader: 앞에 이미 상황 설명 문장을 붙인 경우(미등록 번호 대안 안내 등) 머리말을 생략한다.
  const header = (text) => { if (!(options && options.omitHeader)) lines.push(text); };
  if (pending.mcpTool === 'call.create') {
    header('아래 내용으로 배차 주문을 등록할까요?');
    lines.push(`▪ 이용고객: ${s.이용고객 || '-'}`);
    lines.push(`▪ 구분: ${s.구분 || '-'}${s.예약시각 ? ' / ' + s.예약시각 : ''}`);
    lines.push(`▪ 경로: ${s.출발지 || '-'} → ${s.도착지 || '-'}`);
    if (Array.isArray(s.경유지) && s.경유지.length) lines.push(`▪ 경유지: ${s.경유지.join(', ')}`);
    const fare = formatFare(s.요금);
    if (fare) lines.push(`▪ 요금: ${fare}`);
    if (s.메모) lines.push(`▪ 메모: ${s.메모}`);
  } else if (pending.mcpTool === 'call.cancel') {
    header('아래 주문을 취소할까요?');
    lines.push(`▪ 접수번호: ${s.접수번호 || '-'}`);
    lines.push(`▪ 경로: ${s.경로 || '-'}`);
    if (s.예약시각) lines.push(`▪ 예약시각: ${s.예약시각}`);
    if (s.사유) lines.push(`▪ 사유: ${s.사유}`);
  } else if (pending.mcpTool === 'call.update') {
    header('아래 내용으로 주문을 변경할까요?');
    lines.push(`▪ 접수번호: ${s.접수번호 || '-'}`);
    const changes = s.변경내용 || {};
    if (changes.scheduledAt) lines.push(`▪ 예약시각: ${changes.scheduledAt}`);
    if (changes.departure) lines.push(`▪ 출발지: ${changes.departure.name}`);
    if (changes.arrival) lines.push(`▪ 도착지: ${changes.arrival.name}`);
    const fare = formatFare(changes.fare);
    if (fare) lines.push(`▪ 요금: ${fare}`);
    if (changes.notes) lines.push(`▪ 메모: ${changes.notes}`);
  } else if (pending.mcpTool === 'call.raise') {
    // 사용자가 지정한 문구 형식: "출발지 → 도착지, 요금 00000원에 배차중인데 지연되고 있으니
    // 요금을 5,000원 인상된 00000원으로 수정하시겠습니까?"
    lines.push(`${s.출발지 || '-'} → ${s.도착지 || '-'}, 요금 ${formatFare(s.현재요금) || '-'}에 배차중인데 지연되고 있으니`
      + ` 요금을 ${formatFare(s.인상금액)} 인상된 ${formatFare(s.인상후요금)}으로 수정하시겠습니까?`);
    lines.push('진행하시려면 "네"라고 답해주세요.');
    return lines.join('\n');
  } else {
    lines.push('이대로 진행할까요?');
  }
  lines.push('진행하시려면 "네"라고 답해주세요.');
  return lines.join('\n');
}

// 실행 결과 안내 문구는 LLM에게 다시 물어보지 않고 서버가 직접 만든다 — 되돌리기 어려운 행위의
// 결과만큼은 모델이 표현을 바꿔 말하거나 사실을 덧붙일 여지를 두지 않는 편이 안전하다.
function describeExecution(pending, result) {
  if (!result.ok) {
    return `요청을 처리하지 못했습니다. (${result.error})\n상담원 연결이 필요하면 "상담원 연결"이라고 말씀해주세요.`;
  }
  const data = result.data || {};
  if (pending.mcpTool === 'call.create') {
    const lines = ['배차 주문을 등록했습니다.'];
    if (data.rcptNo) lines.push(`▪ 접수번호: ${data.rcptNo}`);
    const s = pending.summary || {};
    lines.push(`▪ 경로: ${s.출발지 || '-'} → ${s.도착지 || '-'}`);
    if (data.scheduledAt || s.예약시각) lines.push(`▪ 예약시각: ${data.scheduledAt || s.예약시각}`);
    const fare = formatFare(data.fare != null ? data.fare : s.요금);
    if (fare) lines.push(`▪ 요금: ${fare}`);
    if (data.etaSeconds) lines.push(`▪ 예상 도착: 약 ${Math.round(Number(data.etaSeconds) / 60)}분`);
    if (data.message) lines.push(data.message);
    return lines.join('\n');
  }
  if (pending.mcpTool === 'call.cancel') {
    return `접수번호 ${data.rcptNo || (pending.callArgs && pending.callArgs.rcptNo)} 주문을 취소했습니다.${data.message ? '\n' + data.message : ''}`;
  }
  if (pending.mcpTool === 'call.update') {
    return `접수번호 ${(pending.callArgs && pending.callArgs.orderId) || ''} 주문을 변경했습니다.`;
  }
  if (pending.mcpTool === 'call.raise') {
    // 인상 후 요금은 콜마너 응답(newFare)을 우선 쓰고, 없으면 우리가 계산한 값으로 안내한다.
    const newFare = formatFare(data.newFare != null ? data.newFare : (pending.summary && pending.summary.인상후요금));
    return `요금이 ${newFare || '-'}으로 수정되어 배차 진행하고 있습니다.`;
  }
  return '요청을 처리했습니다.';
}

// ---------------- 확인 응답(예/아니오) 판정 ----------------
// 클라이언트(public/js/ai-intake.js)의 isAffirmative/isNegative와 같은 취지의 서버 측 판정.
// 확인 대기 중일 때만 쓰이므로 짧은 단답을 넓게 인정한다.
//
// "그 행동을 가리키는 동사"는 대기 중인 행동에 맞춰서만 긍정으로 본다 — 예를 들어 "취소해주세요"는
// 취소 확인 중이면 동의이지만, 등록 확인 중이면 오히려 "그 요청을 취소해 달라"는 뜻이다
// (일반 패턴에 넣어두면 접수 확인 중 "취소해주세요"가 접수 실행으로 이어진다).
const ACTION_AFFIRM_RE = {
  'call.create': /(등록|접수|예약)\s*(해|할|하)/,
  'call.cancel': /취소\s*(해|할|하)/,
  'call.update': /(변경|수정)\s*(해|할|하)/,
  'call.raise': /(인상|올려|올리|수정)\s*(해|할|하|줘|주)/,
};

function isAffirmativeReply(text, mcpTool) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (isNegativeReply(s)) return false;
  // 문장이 긍정어로 시작하면 뒤에 무슨 말이 붙어도 동의로 본다("네 그렇게 해주세요" 등).
  if (/^(네|넵|예|응|어|그래|그럼|좋아|좋습니다|괜찮|오케이|콜|ok|okay|yes|y)([\s,.!~]|$)/i.test(s)) return true;
  if (/(그대로\s*(진행|해)|그렇게\s*(해|진행|부탁)|진행\s*(해|할|하)|맞습니다|맞아요|부탁\s*(해|드립|합니다|드려))/.test(s)) return true;
  const actionRe = ACTION_AFFIRM_RE[mcpTool];
  return !!(actionRe && actionRe.test(s));
}

function isNegativeReply(text) {
  return /(아니|아뇨|안\s?[돼되]|하지\s?마|그만|나중에|보류|필요\s?없|됐어|취소하지\s?마)/.test(String(text || ''));
}

// ---------------- 에이전트 진입점 ----------------
// history: [{ sender: 'user'|'bot', message }] — 오래된 것부터. 확인 응답("네")처럼 맥락이 없으면
// 뜻을 알 수 없는 짧은 답을 처리하기 위해 필요하다.
async function runDispatchAgent({ user, sessionId, text, history }) {
  if (!mcp.isConfigured()) {
    return { handled: false, reason: 'not_configured' };
  }
  const ctx = await access.loadDispatchContext(user);
  if (!ctx.repNo) return { handled: false, reason: 'no_rep_no' };
  if (!ctx.primaryCid && ctx.allowedCids.length === 0) return { handled: false, reason: 'no_customer_phone' };

  // 1) 확인 대기 중이면 이번 메시지를 먼저 그 확인 응답으로 해석한다.
  const pending = await loadPending(sessionId);
  if (pending) {
    // 로컬 패턴으로 예/아니오가 안 갈리면(표현이 다양해서 실제로 놓치는 경우가 있었다) 오더접수
    // 확인 단계에서 이미 쓰고 있는 Gemini 단문 분류기로 한 번 더 판정한다.
    let decided = isAffirmativeReply(text, pending.mcpTool) ? 'yes' : (isNegativeReply(text) ? 'no' : null);
    if (!decided) {
      try {
        const classified = await classifyPhaseReply(text, 'confirming');
        decided = (classified && classified.action) || 'unclear';
      } catch (e) {
        console.error('확인 응답 분류 실패(대기 상태 해제):', e.message);
        decided = 'unclear';
      }
      if (decided === 'agent') {
        await clearPending(sessionId);
        return { handled: false, reason: 'agent_requested' };
      }
    }

    if (decided === 'yes') {
      await clearPending(sessionId);
      const result = await executePending(ctx, sessionId, pending);
      // 미등록 연락처 때문에 실패한 접수는 대안(접수자 명의 + 메모)을 한 번 더 확인받는다.
      if (result.fallback) {
        const signature = pendingSignature(result.fallback.mcpTool, result.fallback.callArgs);
        await savePending(sessionId, { ...result.fallback, signature, createdAt: Date.now() });
        const original = pending.linkCid;
        return {
          handled: true,
          message: `${original} 번호는 배차 시스템에 고객으로 등록되어 있지 않아 그 번호로는 접수할 수 없습니다.\n`
            + `대신 고객님(${ctx.primaryCid}) 명의로 접수하고 실제 이용고객 연락처를 메모에 남기는 방식으로 등록할까요?\n`
            + describeConfirmation(result.fallback, { omitHeader: true }),
          awaitingConfirmation: true,
          expectsReply: true,
        };
      }
      return { handled: true, message: describeExecution(pending, result), executed: pending.mcpTool, ok: result.ok };
    }
    if (decided === 'no') {
      await clearPending(sessionId);
      return { handled: true, message: '요청을 진행하지 않았습니다. 다른 도움이 필요하시면 말씀해주세요.' };
    }
    // 확인도 거절도 아닌 새 요청이면 대기 상태를 버리고 아래 일반 처리로 넘어간다 —
    // 남겨두면 나중에 온 "네"가 엉뚱한 행위의 동의로 소비될 수 있다.
    await clearPending(sessionId);
  }

  // 2) 대화 히스토리 + 이번 메시지로 도구 호출 루프를 돈다.
  const contents = [];
  (history || []).slice(-MAX_HISTORY_MESSAGES).forEach((m) => {
    if (!m || !m.message) return;
    contents.push({ role: m.sender === 'user' ? 'user' : 'model', parts: [{ text: String(m.message).slice(0, 1500) }] });
  });
  contents.push({ role: 'user', parts: [{ text }] });

  const systemInstruction = buildSystemInstruction(ctx);
  const usedTools = [];
  let pendingSaved = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const turn = await generateWithTools({ systemInstruction, contents, tools: TOOL_DECLARATIONS });

    if (!turn.functionCalls.length) {
      const message = turn.text;
      if (!message) return { handled: false, reason: 'empty_response', usedTools };
      // 확인을 기다리거나 되물은 답변이면, 다음 사용자 메시지도 이 도우미가 먼저 받아야 한다
      // (클라이언트가 이 두 플래그로 판단한다 — public/js/ai-intake.js의 dispatchAgentActive).
      return {
        handled: true,
        message,
        usedTools,
        awaitingConfirmation: pendingSaved,
        expectsReply: /[?？]|까요|해드릴까|알려주|말씀해/.test(message),
      };
    }

    contents.push({ role: 'model', parts: turn.parts });

    const responseParts = [];
    for (const call of turn.functionCalls) {
      const name = call.name;
      const args = call.args || {};
      usedTools.push(name);

      let response;
      if (MUTATING_TOOLS.has(name)) {
        const prepared = await prepareMutation(ctx, sessionId, name, args);
        if (!prepared.ok) {
          response = { ok: false, error: prepared.error };
        } else {
          // 확인 대기 상태를 저장하고, 확인 질문은 서버가 만든 문구를 그대로 내보내며 이 턴을 끝낸다
          // (모델에게 되돌려 문장을 쓰게 하면 실행되지 않은 일을 완료된 것처럼 쓰는 경우가 있었다).
          const signature = pendingSignature(prepared.pending.mcpTool, prepared.pending.callArgs);
          await savePending(sessionId, { ...prepared.pending, signature, createdAt: Date.now() });
          pendingSaved = true;
          return {
            handled: true,
            message: describeConfirmation(prepared.pending),
            usedTools,
            awaitingConfirmation: true,
            expectsReply: true,
          };
        }
      } else {
        try {
          response = await runReadTool(ctx, sessionId, name, args);
        } catch (e) {
          console.error(`MCP 도구 실행 실패(${name}):`, e.message);
          response = { ok: false, error: 'MCP 서버 호출에 실패했습니다: ' + e.message };
        }
      }

      responseParts.push({ functionResponse: { name, response } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  // 도구 호출만 반복하고 문장을 못 만든 경우 — 상담원으로 넘긴다.
  return { handled: false, reason: 'tool_loop_exhausted', usedTools };
}

// ---------------- 배차 지연 감지 → 요금 인상 선제 제안 ----------------
// 콜마너가 내려주는 시각 문자열의 정확한 형식이 문서에 없어(스웨거에 예시 없음) 여러 형태를 받아준다.
// 오프셋이 없는 문자열은 KST로 해석한다 — 서버(Vercel)는 UTC로 돌아서 그냥 new Date()에 넘기면
// 9시간 어긋나 "이미 5분 지났다"고 잘못 판정할 수 있다.
function parseKstDateTime(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const withOffset = new Date(s);
    return Number.isNaN(withOffset.getTime()) ? null : withOffset;
  }
  let m = s.match(/^(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})[T\s]?(\d{2}):?(\d{2})(?::?(\d{2}))?/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+09:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// 배차 대기가 시작된 기준 시각 — 예약콜은 예약시각부터 배차가 붙으므로 그쪽을 기준으로 본다
// (예약시각이 아직 안 됐으면 지연이 아니다).
function dispatchWaitStartedAt(order) {
  const scheduled = parseKstDateTime(order.scheduledAt);
  const requested = parseKstDateTime(order.requestedAt);
  if (scheduled && requested) return scheduled.getTime() > requested.getTime() ? scheduled : requested;
  return scheduled || requested || null;
}

async function alreadyOfferedRaise(ctx, rcptNo) {
  try {
    const row = await db.get(
      `SELECT id FROM mcp_tool_calls
       WHERE user_id = ? AND tool_name IN ('fare.raise.offer', 'call.raise') AND arguments_json LIKE ?
       LIMIT 1`,
      [ctx.userId, '%' + rcptNo + '%']
    );
    return !!row;
  } catch (e) {
    // 감사 테이블이 아직 없으면(마이그레이션 전) 중복 제안 방지를 보장할 수 없다 —
    // 반복 제안으로 고객을 성가시게 하는 쪽보다 아예 제안하지 않는 쪽이 안전하다.
    console.error('요금인상 제안 이력 조회 실패(제안 보류):', e.message);
    return true;
  }
}

// 챗봇이 주기적으로 호출한다(routes/chat.js의 /dispatch-delay-check). 기사 미배정 상태로
// 기준 시각에서 5분이 지난 진행 중 주문이 있으면, 요금 인상 확인 대기를 저장하고 질문 문구를 돌려준다.
// 실행은 사용자가 "네"라고 답할 때 runDispatchAgent의 확인 처리 경로가 담당한다.
async function checkDispatchDelay({ user, sessionId }) {
  if (!mcp.isConfigured()) return { offer: false, reason: 'not_configured' };
  const ctx = await access.loadDispatchContext(user);
  if (!ctx.repNo) return { offer: false, reason: 'no_rep_no' };
  if (!ctx.primaryCid && ctx.allowedCids.length === 0) return { offer: false, reason: 'no_customer_phone' };

  // 이미 다른 확인(취소/변경 등)을 기다리는 중이면 끼어들지 않는다.
  if (await loadPending(sessionId)) return { offer: false, reason: 'pending_exists' };

  const { orders } = await access.loadOwnedOrders(ctx, { includeHistory: false });
  const now = Date.now();
  const thresholdMs = DELAY_OFFER_MINUTES * 60 * 1000;

  for (const order of orders) {
    if (!order || !order.rcptNo) continue;
    if (order.driver && order.driver.matched === true) continue; // 이미 기사 배정됨
    if (order.isFareAdjustable === false) continue;
    const startedAt = dispatchWaitStartedAt(order);
    if (!startedAt) continue;
    if (now - startedAt.getTime() < thresholdMs) continue;
    if (await alreadyOfferedRaise(ctx, order.rcptNo)) continue;

    const prepared = await prepareMutation(ctx, sessionId, 'raise_fare', { rcptNo: order.rcptNo });
    if (!prepared.ok) continue;

    const signature = pendingSignature(prepared.pending.mcpTool, prepared.pending.callArgs);
    await savePending(sessionId, { ...prepared.pending, signature, createdAt: Date.now() });
    await access.logToolCall(ctx, sessionId, 'fare.raise.offer', prepared.pending.callArgs, true, null);

    return {
      offer: true,
      rcptNo: order.rcptNo,
      message: '현재 배차가 지연되고 있습니다.\n' + describeConfirmation(prepared.pending),
    };
  }
  return { offer: false, reason: 'no_delayed_order' };
}

module.exports = {
  runDispatchAgent,
  checkDispatchDelay,
  TOOL_DECLARATIONS,
  // 테스트/진단용
  isAffirmativeReply,
  isNegativeReply,
  buildSystemInstruction,
  parseKstDateTime,
  dispatchWaitStartedAt,
};
