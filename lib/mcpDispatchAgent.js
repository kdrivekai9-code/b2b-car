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
const { lookupRegion } = require('./kakaoRegion');
const { generateWithTools } = require('./vertexAi');
const { classifyPhaseReply } = require('./hybridChat');
// 주소 + 상세주소를 합쳐 보여주기 위한 공용 규칙(lib/intakeSummary.js).
const { joinAddress } = require('./intakeSummary');
const { logIntegrationErrorAsync } = require('./integrationLog');
const { kstNow, toDateStr } = require('./period');
// routes/orders.js가 export하는 updateOrderWithCallmaner를 재사용한다(순환참조 없음 — 그쪽은
// 이 파일을 require하지 않는다, routes/chat.js만 이 파일을 쓴다).
const { updateOrderWithCallmaner } = require('../routes/orders');

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
    description: '현재 진행 중인 배차 주문(접수/대기/예약/기사배정)과 고객 정보를 조회합니다. "내 주문 어떻게 됐어요", "기사 배정됐나요" 같은 현재 상태 질문에 쓰세요. 지난 이력이나 날짜 조건이 붙은 질문은 get_order_history를 쓰세요.',
    parameters: {
      type: 'OBJECT',
      properties: {
        customerPhone: { type: 'STRING', description: '실제 이용 고객의 연락처. 본인 주문을 볼 때는 넣지 마세요. 직접 접수해준 다른 이용자의 주문을 볼 때만 그 번호를 넣으세요.' },
      },
    },
  },
  {
    name: 'get_order_history',
    description: '주문 이력을 조회합니다. 진행 중인 주문과 지난 이력을 함께 돌려주므로, "오늘 접수한 건 있어?", "이번 달 이용 내역" 같은 기간·날짜 질문에는 이 도구를 쓰세요. 각 주문의 구분 필드로 진행중/지난이력을 알 수 있습니다.',
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
        scheduledAt: { type: 'STRING', description: '예약 시각 "YYYY-MM-DD HH:mm" (한국시간 KST 기준, serviceType이 scheduled면 필수)' },
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
        scheduledAt: { type: 'STRING', description: '변경할 예약 시각 "YYYY-MM-DD HH:mm" (한국시간 KST 기준)' },
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

// 배차 지연 판정 기준(사용자 확정):
//  - "접수" 상태에서 5분이 지난 건만 지연으로 본다. 대기(waiting)·예약(scheduled) 상태는 제외.
//  - 기사가 이미 배정된 건도 제외.
//  - 예약시간이 아직 10분 이상 남은 건은 제외한다(예약 시각이 임박해야 배차가 도므로).
const DELAY_OFFER_MINUTES = Number(process.env.MCP_DISPATCH_DELAY_MINUTES || 5);
const SCHEDULED_LEAD_MINUTES = Number(process.env.MCP_DISPATCH_SCHEDULED_LEAD_MINUTES || 10);
const DEFAULT_RAISE_AMOUNT = Number(process.env.MCP_DISPATCH_FARE_RAISE_AMOUNT || 5000);

// ---------------- 시스템 프롬프트 ----------------
function buildSystemInstruction(ctx) {
  const now = kstNow();
  const pad = (n) => String(n).padStart(2, '0');
  const todayISO = toDateStr(now);
  const nowHHmm = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
  const mask = access.maskPhone;
  const linkedList = ctx.linkedCids.length
    ? ctx.linkedCids.map((c) => `${mask(c)}${ctx.linkNames[c] ? '(' + ctx.linkNames[c] + ')' : ''}`).join(', ')
    : '없음';

  return `당신은 B2B 배차(대리운전) 플랫폼의 주문 상담 챗봇입니다. 고객의 요청을 읽고 필요한 도구를 호출해
실제 데이터를 확인한 뒤, 한국어로 간결하게(3~5줄 이내) 답하세요.

[지금 시각] ${todayISO} ${nowHHmm} (KST). "오늘/내일/이번 주 토요일" 같은 표현은 이 시각 기준으로 계산하세요.
예약 시각은 항상 한국시간(KST) 기준으로 적으세요 — 배차 시스템도 KST로 처리합니다.

[상담 중인 고객]
- 이름: ${ctx.userName}
- 소속 지사: ${ctx.branchName || '미지정'}
- 본인 연락처(기본 조회 대상): ${ctx.primaryCid ? mask(ctx.primaryCid) : '미등록'}
- 이 고객이 대신 접수해준 실제 이용 고객 연락처: ${linkedList}
- 최근 접수건의 실제 이용고객(출발지) 연락처: ${ctx.usageCids.length ? ctx.usageCids.map(mask).join(', ') : '없음'}
  (조회는 이 번호들로 먼저 하고, 없으면 접수자 본인 번호로 자동 재조회합니다 — 당신이 번호를
   지정하지 않으면 서버가 이 순서대로 처리하니, 고객이 특정 번호를 말한 경우가 아니면
   customerPhone을 비워두세요.)

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

[취소된 주문을 다시 살려달라고 할 때]
- 취소된 주문은 되살릴 수 없습니다. 그건 사실대로 알리세요.
- 다만 거기서 **상담원 연결을 제안하지 마세요.** 같은 내용으로 새로 접수하는 것은 도구로 할 수 있는
  일입니다. "취소된 주문은 되살릴 수 없습니다. 동일한 내용으로 새로 접수해 드릴까요?"처럼 물으세요.
- 고객이 동의하면 그 주문의 **출발지·도착지·차종·차량번호를 조회 결과에서 그대로** 가져와
  search_place로 좌표를 확정한 뒤 create_order를 호출하세요. 시스템이 접수 내역을 보여주고
  "등록할까요?"라고 한 번 더 확인합니다 — 그러니 당신이 미리 되묻지 마세요.
- 예약시각만은 그대로 쓰면 안 됩니다. 취소된 주문의 예약시각은 이미 지난 시각입니다.
  "언제로 접수해 드릴까요?"라고 물어 새 시각을 받으세요.

[답변 작성 규칙]
- 도구 결과에 없는 사실을 만들어내지 마세요. 조회 결과가 없으면 없다고 그대로 말하세요.
- 접수번호는 **어떤 답변에서든** 도구가 돌려준 "접수번호" 필드 값을 그대로 쓰세요
  (예: "접수번호 OID1132(179098847)"). 우리 오더번호와 콜마너 번호를 함께 보여줘야 고객이
  자기 주문을 찾을 수 있습니다. 우리 오더번호가 없는 건은 콜마너 번호만 들어 있으니 그대로 쓰면 됩니다.
- 도구를 호출할 때 rcptNo에는 "도구용접수번호"(숫자만)를 넣으세요. "접수번호" 값을 넣으면 안 됩니다.
- "배차 지연" 여부는 반드시 도구가 준 "배차지연" 값으로만 판단하세요. 직접 시각을 계산해서
  지연이라고 말하지 마세요. 예약 건은 예약시각이 임박하기 전까지 지연이 아닙니다.
  지연 건이 없으면 "현재 배차가 지연되고 있는 주문은 없습니다"라고 답하세요.
- 목록을 안내할 때는 **첫 줄에 도구가 준 "조회조건" 값을 그대로 밝히고** 건수를 말하세요.
  ("총 3건입니다"만 말하면 고객은 그게 오늘 건인지 전체인지, 취소된 건도 포함인지 알 수 없습니다.)
  예: "진행 중인 주문 전체(완료/취소 제외) 기준으로 3건입니다."
- 주문을 안내할 때는 **접수번호, 예약시간, 출발지, 도착지, 출발지 연락처**를 반드시 모두 넣으세요.
  예약시간 자리에는 도구가 준 "예약시간" 값을 그대로 쓰고, 그 값이 예약이 아니라 접수시간이면
  ("시각구분"이 "접수시간(즉시)") "접수시간"이라고 이름을 붙여 안내하세요(즉시 처리 건입니다).
  상태(기사 배정 여부)와 요금도 함께 알려주면 좋습니다.
- **상세 정보를 물으면**("○○ 주문 상세정보", "자세히 알려줘") 항목을 한 줄씩 나열하되 순서를 지키세요.
  접수번호 → 예약시간 → 출발지 → 출발지 연락처 → 도착지 → 도착지 연락처 → 요청사항 → 상태 → 요금.
  **연락처는 각각 해당 장소 바로 아래**에 붙입니다(출발지 연락처를 도착지 아래에 쓰지 마세요).
  "도착지연락처"·"요청사항" 값이 없으면(null) 그 줄은 아예 빼세요 — "없음"이라고 쓰지 마세요.
- 고객이 목록의 순번으로 지목하면("1번 주문 상세정보", "두 번째 건") **직전 답변에서 그 순번에
  해당하는 주문**을 뜻합니다. 접수번호를 다시 묻지 말고, 그 주문의 접수번호로 도구를 호출해
  최신 값을 확인한 뒤 상세를 안내하세요.
- 연락처는 가운데 자리를 가린 형태(010-****-1240)로 안내하세요. 도구가 돌려주는 번호는 이미
  그렇게 가려져 있으니 **그 값을 그대로 쓰면 됩니다**(임의로 복원하거나 다른 형태로 바꾸지 마세요).
  단, customerPhone 인자에는 고객이 말한 번호 원문을 넣으세요 — 가려진 번호를 넣으면 안 됩니다.
- **"기사연락처"만은 예외로 가리지 않은 원본입니다.** 고객이 배정된 기사에게 직접 연락해야 하는
  번호라, 가리면 쓸 수가 없습니다. 도구가 준 값을 그대로 안내하세요.
  "기사명"/"기사연락처" 필드가 아예 없으면 아직 배차 전이라는 뜻입니다 — "연락처가 없다"가 아니라
  "아직 기사가 배정되지 않았다"고 답하세요.
- 이전 답변에 없던 항목(접수시각 등)을 고객이 되물으면 기억에 의존해 "확인이 어렵다"고 하지 말고
  **도구를 다시 호출해서** 확인한 뒤 답하세요. 도구 결과에는 접수시각·예약시각이 들어 있습니다.
- 요금은 "12,000원"처럼 천단위 쉼표를 넣으세요.
- 배차/요금/취소 규정에 대한 일반 정책 질문이거나, 도구로 확인할 수 없는 요청이면 억지로 답하지 말고
  "상담원에게 연결해드릴까요?"라고 제안하세요. 단 **도구로 할 수 있는 일에는 상담원을 제안하지
  마세요** — 취소된 주문의 재접수처럼 create_order로 처리되는 요청이 여기 해당합니다.`;
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

// 콜마너가 받아들이는 예약 시각 형식은 ISO 8601의 "YYYY-MM-DDTHH:mm:ss"다(KST 고정, 오프셋 없음).
// 공백 구분자 "2027-07-27 16:50"로 보냈더니 에러 없이 조용히 무시되고 즉시 호출로 접수됐고,
// "2027-07-27T16:50:00"로 보내니 "예약 접수가 생성되었습니다"(st=scheduled)로 정상 등록됐다 —
// 실서버로 확인한 사실이라 모델이 어떤 형태로 채워 넣든 서버가 이 형식으로 맞춰서 보낸다.
function toCallmanerDateTime(raw) {
  const m = String(raw || '').trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(m[4])}:${m[5]}:${m[6] || '00'}`;
}

// 콜마너가 돌려준 주문을 챗봇이 안내하기 좋은 형태로 정리한다.
//  - 표시번호: 우리 오더번호가 있으면 "OID1132(179098847)", 없으면 콜마너 번호만
//  - 필드 이름을 한글로 바꾼다 — requestedAt 같은 영문 키를 그대로 주면 모델이 "접수 시각은
//    확인이 어렵습니다"라고 답해버리는 일이 실제로 있었다(값은 응답에 들어 있었는데도).
const ORDER_STATE_LABELS = {
  queued: '접수(배차 대기)', waiting: '대기', scheduled: '예약', matched: '기사 배정',
  cancelled: '취소', canceled: '취소', done: '완료', completed: '완료', finished: '완료',
};

// 배차 지연 판정 — 조회 결과 표시와 선제 제안이 같은 기준을 쓰도록 한 곳에 모았다.
// 접수시각/예약시각은 이미 "YYYY-MM-DD HH:mm"로 정리된 값을 받는다(KST).
function evaluateDispatchDelay({ st, statusCode, matched, 접수시각, 예약시각 }, nowMs, options) {
  const now = nowMs || Date.now();
  const delayMinutes = (options && options.delayMinutes) || DELAY_OFFER_MINUTES;
  const state = String(st || '').toLowerCase();
  // 콜마너 상태: queued(접수, statusCode 0) / waiting(대기) / scheduled(예약, R) / cancelled 등
  const isQueued = state === 'queued' || state === '접수' || String(statusCode || '') === '0';
  if (!isQueued) return { 지연: false, 사유: '접수 상태가 아님(' + (st || '-') + ')' };
  if (matched === true) return { 지연: false, 사유: '기사 배정됨' };

  const requested = parseKstDateTime(접수시각);
  if (!requested) return { 지연: false, 사유: '접수시각 불명' };
  const elapsedMin = Math.floor((now - requested.getTime()) / 60000);
  if (elapsedMin < delayMinutes) {
    return { 지연: false, 사유: `접수 후 ${elapsedMin}분 경과(기준 ${delayMinutes}분)` };
  }

  const scheduled = parseKstDateTime(예약시각);
  if (scheduled) {
    const remainMin = Math.floor((scheduled.getTime() - now) / 60000);
    if (remainMin >= SCHEDULED_LEAD_MINUTES) {
      return { 지연: false, 사유: `예약시간까지 ${remainMin}분 남음(기준 ${SCHEDULED_LEAD_MINUTES}분)` };
    }
  }
  return { 지연: true, 사유: `접수 후 ${elapsedMin}분 경과, 기사 미배정` };
}

// "지금 어디쯤인가요?" 응대 — 콜마너에 기사 위치 전용 도구는 없고, 진행 중 주문(call.list.active)의
// driver 필드에 좌표(xy)와 픽업까지 거리/ETA가 실려 온다. 그 좌표를 행정구역으로 바꿔 안내한다.
// 번지까지 노출하지 않는 건 의도적이다 — 기사의 정확한 현재 위치는 고객에게 필요한 정보가 아니다.
const LOCATION_QUESTION_RE = /(어디\s*쯤|어디\s*(에|까지)?\s*(있|왔|오|가고)|어디야|어디인가|어디입니|(기사|기사님|지금|현재|차량|차)\s*위치|얼마나\s*(남|걸리)|언제\s*(쯤|도착|와)|도착\s*(예정|시간|언제)|몇\s*시\s*(쯤|에)?\s*(도착|와))/;
// "출발지 위치를 강남역으로 변경해주세요"처럼 변경 요청에 위치 표현이 섞이는 경우가 있어,
// 변경/취소/접수 의도가 보이면 위치 문의로 가로채지 않고 원래의 도구 호출 경로로 보낸다.
const MUTATION_HINT_RE = /(변경|수정|바꿔|바꾸|취소|캔슬|접수|등록|예약해|잡아줘|올려줘)/;

function isLocationQuestion(text) {
  const t = String(text || '');
  if (MUTATION_HINT_RE.test(t)) return false;
  return LOCATION_QUESTION_RE.test(t);
}

// driver.xy는 "위도,경도" 문자열이다(place.find 응답과 같은 순서 — 실측 확인).
async function describeDriverPlace(xy) {
  const parts = String(xy || '').split(',').map((v) => Number(String(v).trim()));
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  const region = await lookupRegion(parts[0], parts[1]);
  if (!region) return null;
  return [region.sido, region.sigugun, region.dong].filter(Boolean).join(' ') || null;
}

function formatEtaMinutes(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.round(n / 60));
}

function summarizeOrders(orders, oidMap) {
  return (orders || []).map((o) => {
    const rcptNo = String(o.rcptNo || '').trim();
    const mine = oidMap && oidMap.get(rcptNo);
    const place = (p) => (p ? (p.address || p.name || '-') : '-');
    const 접수시각 = formatDateTime(o.requestedAt || (mine && mine.created_at));
    // 콜마너 진행 중 목록에는 scheduledAt이 실리지 않는다(이력 조회에만 있음). 그 탓에 예약 건이
    // 접수시간으로 안내되던 문제가 있어서, 우리 오더가 매칭되면 우리가 가진 예약일시로 채운다.
    const 우리예약 = mine && mine.reserved_date
      ? `${mine.reserved_date} ${String(mine.reserved_time || '').slice(0, 5)}`.trim()
      : null;
    const 예약시각 = formatDateTime(o.scheduledAt) || formatDateTime(우리예약);
    return {
      // 화면에 쓸 값과 도구 인자로 쓸 값을 이름부터 갈라둔다 — 둘 다 "접수번호"라고 부르면
      // 모델이 원본 숫자를 그대로 안내 문구에 써버린다.
      접수번호: mine && mine.oid ? `${mine.oid}(${rcptNo})` : rcptNo,
      도구용접수번호: rcptNo,
      우리오더번호: (mine && mine.oid) || null,
      __groupId: (mine && mine.requester_group_id) || null,
      __orderType: (mine && mine.order_type) || null,
      __st: o.st || null,
      __statusCode: o.statusCode || null,
      // 예약 건은 예약시간을, 예약이 아닌(즉시 처리) 건은 접수시간을 그 자리에 보여준다.
      예약시간: 예약시각 || 접수시각,
      시각구분: 예약시각 ? '예약시간' : '접수시간(즉시)',
      // 우리 오더가 매칭되면 우리 주소를 쓴다 — 콜마너 응답 주소는 잘려서 온다.
      // 주소는 상세주소와 나눠 저장돼 있어(splitRoadAddress) 안내할 때는 합쳐서 보여준다.
      출발지: (mine && joinAddress(mine.origin_address, mine.origin_address_detail)) || place(o.departure),
      도착지: (mine && joinAddress(mine.destination_address, mine.destination_address_detail)) || place(o.arrival),
      // 출발지 연락처 = 실제 차량을 이용하는 고객의 번호(콜마너 cid와 같은 값).
      // 우리 오더가 매칭되면 그 값을, 아니면 조회에 쓴 cid를 호출부가 채운다.
      출발지연락처: mine && mine.origin_contact ? access.maskPhone(mine.origin_contact) : null,
      // 도착지 연락처·요청사항은 콜마너 응답에 없다 — 우리 오더가 매칭될 때만 채워진다.
      도착지연락처: mine && mine.destination_contact ? access.maskPhone(mine.destination_contact) : null,
      요청사항: (mine && String(mine.memo_customer || '').trim()) || null,
      접수시각,
      예약시각,
      상태: ORDER_STATE_LABELS[o.st] || o.st || null,
      요금: o.fare != null ? o.fare : null,
      기사배정: !!(o.driver && o.driver.matched),
      // 기사 이름·연락처는 배차된 뒤에만 채워진다. 배차 전에 빈 값을 실어 보내면 모델이
      // "연락처가 없습니다"라고 단정하는데, 실제로는 아직 배차가 안 된 것뿐이라 뜻이 다르다.
      ...(() => {
        const name = mine && String(mine.callmaner_driver_name || '').trim();
        const phone = mine && String(mine.callmaner_driver_phone || '').trim();
        if (!name && !phone) return {};
        return { 기사명: name || null, 기사연락처: phone || null };
      })(),
      ...(() => {
        const verdict = evaluateDispatchDelay({
          st: o.st, statusCode: o.statusCode,
          matched: !!(o.driver && o.driver.matched),
          접수시각, 예약시각,
        });
        return { 배차지연: verdict.지연, 지연판정: verdict.사유 };
      })(),
      취소가능: o.isCancellable !== false,
      변경가능: o.isModifiable !== false,
      요금조정가능: o.isFareAdjustable !== false,
    };
  });
}

// 접수번호 안내 규칙(사용자 확정): 우리 오더번호가 있으면 "OID1133(179179804)",
// 없으면(콜마너에서만 접수된 건) 콜마너 접수번호만 표시한다.
async function displayReceiptNo(rcptNo) {
  const key = String(rcptNo || '').trim();
  if (!key) return '';
  const map = await access.loadOidsByCallmanerSlips([key]);
  const mine = map.get(key);
  return mine && mine.oid ? `${mine.oid}(${key})` : key;
}

async function withOidLabels(orders) {
  const oidMap = await access.loadOidsByCallmanerSlips((orders || []).map((o) => o && o.rcptNo));
  return summarizeOrders(orders, oidMap);
}

// 모델에게 돌려줄 때는 서버 전용 필드(__로 시작)를 뺀다. 배차지연 선제 제안(checkDispatchDelay)이
// 같은 행에서 쓰는 값이라 summarizeOrders에서는 만들어두되, 모델은 쓸 일이 없다 — 실려 나가면
// 토큰만 늘고(응답이 그만큼 느려진다) 모델이 내부 코드값을 답변에 옮겨 적을 위험도 생긴다.
function stripInternal(rows) {
  return (rows || []).map((row) => {
    const out = {};
    Object.keys(row).forEach((k) => { if (k.indexOf('__') !== 0) out[k] = row[k]; });
    return out;
  });
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
// 고객이 말하지도 않은 번호를 모델이 customerPhone에 넣는 경우를 막는다.
//
// 프롬프트에 "본인 주문을 볼 때는 customerPhone을 넣지 마세요"라고 적어뒀지만 실측에서 지키지
// 않았다 — "1번주문 상세정보"에 연결된 이용고객 번호 하나를 임의로 골라 넣는 바람에, 주문이
// 있는데도 "0건입니다"라고 답했다(그 번호에는 진행 중 주문이 없었다). 권한 위반은 아니지만
// (허용된 번호 안에서 고른 것) 답이 틀린다.
//
// 판단은 간단하다 — 이번 발화에 전화번호가 한 번도 나오지 않았으면 모델이 지어낸 것이므로
// 무시하고 기본 조회 대상(ctx.lookupOrder 전체)으로 돌린다. 고객이 실제로 번호를 말한 경우에는
// 그대로 존중한다(그때만 특정 이용고객을 지목한 것이다).
const PHONE_IN_TEXT_RE = /01\d\s*-?\s*\d{3,4}\s*-?\s*\d{4}/;

// 장소명 완전일치 비교용 — 공백 유무 차이만 없앤다(그 이상 강하게 정규화하면 진짜 다른
// 장소끼리도 같다고 오판할 수 있다. "사당역" vs "사당역 4호선"은 여전히 달라야 한다).
function normalizePlaceName(v) {
  return String(v || '').replace(/\s+/g, '');
}

function sanitizeCustomerPhoneArg(ctx, args) {
  if (!args || !args.customerPhone) return args;
  if (PHONE_IN_TEXT_RE.test(String((ctx && ctx.turnText) || ''))) return args;
  const cleaned = { ...args };
  delete cleaned.customerPhone;
  return cleaned;
}

async function runReadTool(ctx, sessionId, toolName, rawArgs) {
  const args = (toolName === 'get_my_orders' || toolName === 'get_order_history')
    ? sanitizeCustomerPhoneArg(ctx, rawArgs)
    : rawArgs;
  if (toolName === 'search_place') {
    const keyword = String(args.keyword || '').trim();
    if (!keyword) return { ok: false, error: '검색할 장소명이 없습니다.' };
    const mcpTool = args.kind === 'origin' ? 'place.find.origin' : 'place.find.destination';
    const out = await mcp.callTool(mcpTool, { keyword });
    await access.logToolCall(ctx, sessionId, mcpTool, { keyword }, out.ok, out.error);
    if (!out.ok) return { ok: false, error: out.error };
    const hits = (out.data && out.data.hits) || [];
    // 검색어와 이름이 완전히 같은 후보만 남긴다(1개로 좁혀지면 모델이 되묻지 않고 바로 쓴다 —
    // 시스템 프롬프트의 "후보가 여러 개면 물어보라"는 규칙과 자연스럽게 맞물린다).
    // "사당역"을 검색하면 승강장별로 좌표만 다르게 완전일치 후보가 두 개 오는 등, MCP 서버가
    // 이름이 똑같은 히트를 여러 개 주는 경우가 실측으로 확인됐다(콜마너 place.find 응답) —
    // 그래도 전부 같은 장소를 가리키므로 첫 번째만 쓴다. "판교알파돔타워"처럼 검색어와 정확히
    // 일치하는 이름이 없으면(부분 일치뿐이면) 원래대로 전체 후보를 돌려줘 고객에게 확인받는다.
    const exact = hits.filter((h) => normalizePlaceName(h && h.name) === normalizePlaceName(keyword));
    return { ok: true, hits: exact.length ? exact.slice(0, 1) : hits };
  }

  if (toolName === 'get_my_orders') {
    // cid를 지정하지 않았으면 실제 이용고객(최근 접수건의 출발지 연락처)으로 1차 조회하고,
    // 거기서 못 찾으면 접수자 본인 번호로 2차 조회한다(사용자 확정 규칙). 요청자가 대신
    // 접수하는 경우가 많아 콜마너에 고객으로 잡혀 있는 쪽이 접수자가 아닐 수 있기 때문이다.
    let candidates;
    if (args.customerPhone) {
      const resolved = access.resolveCid(ctx, args.customerPhone);
      if (resolved.error) return { ok: false, error: resolved.error };
      candidates = [resolved.cid];
    } else {
      candidates = ctx.lookupOrder.slice();
      if (!candidates.length) return { ok: false, error: '조회할 고객 연락처를 확인할 수 없습니다.' };
    }

    // 후보를 전부 병렬로 조회해 진행 중 주문을 합친다 — 한 회사에 이용고객이 여럿일 때
    // 첫 적중에서 멈추면 다른 이용고객의 진행 중 주문이 빠진 목록을 "전부"인 것처럼 안내하게 된다.
    // 고객 프로필(cust.get)은 첫 후보 한 번만 부른다 — 아래에서 firstCustomer 하나만 쓰는데
    // 후보 수만큼 부르면(실측 4명) 나머지 결과는 그대로 버려진다. cust.get이 call.list.active보다
    // 느려서(1.2s vs 0.8s) 이 왕복이 조회 전체의 대기시간을 결정하고 있었다.
    const perCid = await Promise.all(candidates.map(async (cid, i) => {
      const [profile, active] = await Promise.all([
        i === 0 ? mcp.callTool('cust.get', { repNo: ctx.repNo, cid }) : Promise.resolve({ ok: false, data: null }),
        mcp.callTool('call.list.active', { repNo: ctx.repNo, cid }),
      ]);
      await access.logToolCall(ctx, sessionId, 'cust.get+call.list.active', { cid }, profile.ok || active.ok, profile.error);
      return { cid, profile, active };
    }));

    const merged = [];
    const seen = new Set();
    let lastError = null;
    let firstCustomer = null;
    let anyOk = false;
    perCid.forEach(({ cid, profile, active }) => {
      if (!profile.ok && !active.ok) { lastError = profile.error || active.error; return; }
      anyOk = true;
      const customer = (profile.data && profile.data.customer) || null;
      if (customer && !firstCustomer) {
        firstCustomer = {
          customer: {
            name: customer.name, grade: customer.grade, corpName: customer.corpName,
            availableCharge: customer.availableCharge, mileageBalance: customer.mileageBalance,
          },
          capabilities: (profile.data && profile.data.capabilities) || null,
        };
      }
      ((active.data && active.data.orders) || []).forEach((o) => {
        const key = String((o && o.rcptNo) || '');
        if (!o || (key && seen.has(key))) return;
        if (key) seen.add(key);
        merged.push({ ...o, __cid: cid });
      });
    });

    if (anyOk) {
      const labeled = await withOidLabels(merged);
      labeled.forEach((row, i) => {
        const masked = access.maskPhone(merged[i].__cid);
        row.이용고객 = masked;
        if (!row.출발지연락처) row.출발지연락처 = masked;
      });
      return {
        ok: true,
        // 어떤 범위를 본 결과인지 답변에 그대로 밝히게 한다. "총 3건입니다"만 나가면 고객은
        // 그게 오늘 건인지 전체인지 알 수 없다(실사용 지적) — 조건 없이 건수만 말하면
        // 취소·완료된 건이 빠진 것도 드러나지 않는다.
        조회조건: `진행 중인 주문 전체(접수·대기·예약·배차완료 — 완료/취소 건은 제외), 이용고객 ${candidates.map(access.maskPhone).join(', ')} 기준`,
        조회한연락처: candidates.map(access.maskPhone),
        customer: firstCustomer ? firstCustomer.customer : null,
        capabilities: firstCustomer ? firstCustomer.capabilities : null,
        activeOrders: stripInternal(labeled),
      };
    }

    return {
      ok: false,
      error: lastError,
      notRegistered: /CUSTOMER_NOT_FOUND/i.test(String(lastError || '')),
      조회시도: candidates.map(access.maskPhone),
      hint: '조회한 연락처가 배차 시스템에 등록된 고객이 아닙니다.',
    };
  }

  if (toolName === 'get_order_history') {
    let candidates;
    if (args.customerPhone) {
      const resolved = access.resolveCid(ctx, args.customerPhone);
      if (resolved.error) return { ok: false, error: resolved.error };
      candidates = [resolved.cid];
    } else {
      candidates = ctx.lookupOrder.slice();
      if (!candidates.length) return { ok: false, error: '조회할 고객 연락처를 확인할 수 없습니다.' };
    }

    // 후보(실제 이용고객들 → 접수자)를 전부 병렬로 조회해 합친다. 예전에는 첫 적중에서 멈춰서,
    // 한 회사에 이용고객이 여럿일 때 다른 이용고객의 주문이 통째로 빠진 목록을 "전부"인 것처럼
    // 안내했다(어제 취소건 OID1132가 안 보이던 문제). 또 이력(history)에는 오늘 접수한 건이
    // 올라오지 않아서 진행 중 목록까지 함께 본다(실측: 오늘 접수건은 active에만 있음).
    const pageSize = Math.min(Number(args.pageSize) || 10, 30);
    const perCid = await Promise.all(candidates.map(async (cid) => {
      const callArgs = { repNo: ctx.repNo, cid, page: 1, pageSize };
      if (args.startDate) callArgs.startDate = String(args.startDate).trim();
      if (args.endDate) callArgs.endDate = String(args.endDate).trim();
      const [history, active] = await Promise.all([
        mcp.callTool('call.list.history', callArgs),
        mcp.callTool('call.list.active', { repNo: ctx.repNo, cid }),
      ]);
      await access.logToolCall(ctx, sessionId, 'call.list.history+active', callArgs, history.ok || active.ok, history.error);
      return { cid, history, active };
    }));

    const merged = [];
    const seen = new Set();
    let lastError = null;
    let anyOk = false;
    perCid.forEach(({ cid, history, active }) => {
      if (!history.ok && !active.ok) { lastError = history.error || active.error; return; }
      anyOk = true;
      const push = (list, 구분) => (list || []).forEach((o) => {
        const key = String((o && o.rcptNo) || '');
        if (!o || (key && seen.has(key))) return;
        if (key) seen.add(key);
        merged.push({ ...o, __구분: 구분, __cid: cid });
      });
      push((active.data && active.data.orders) || [], '진행중');
      push((history.data && history.data.orders) || [], '지난이력');
    });

    if (anyOk) {
      const labeled = await withOidLabels(merged);
      labeled.forEach((row, i) => {
        const masked = access.maskPhone(merged[i].__cid);
        row.구분 = merged[i].__구분;
        row.이용고객 = masked;
        if (!row.출발지연락처) row.출발지연락처 = masked;
      });
      const 기간 = (args.startDate || args.endDate)
        ? `${args.startDate || '처음'} ~ ${args.endDate || '오늘'}`
        : `기간 지정 없음(최근 ${pageSize}건)`;
      return {
        ok: true,
        조회조건: `주문 이력 ${기간}, 이용고객 ${candidates.map(access.maskPhone).join(', ')} 기준 (진행중 + 지난이력 모두 포함)`,
        orders: stripInternal(labeled),
        조회한연락처: candidates.map(access.maskPhone),
      };
    }

    return {
      ok: false,
      error: lastError,
      notRegistered: /CUSTOMER_NOT_FOUND/i.test(String(lastError || '')),
      조회시도: candidates.map(access.maskPhone),
    };
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
    const scheduledAt = args.scheduledAt ? toCallmanerDateTime(args.scheduledAt) : null;
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
          이용고객: access.maskPhone(resolved.cid) + (resolved.isNew ? ' (신규 이용고객으로 등록됩니다)' : ''),
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
        // raiseFare는 "인상분"이 아니라 "인상 후 총액"이다 — 인상분(5000)을 보냈더니 실서버가
        // FARE_RAISE_INVALID("raised fare must be greater than current fare")로 거부했다.
        mcpTool: 'call.raise',
        callArgs: { rcptNo, currentFare, raiseFare: currentFare + raiseAmount },
        summary: {
          동작: '배차 요금 인상',
          접수번호: await displayReceiptNo(rcptNo),
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
            접수번호: await displayReceiptNo(rcptNo),
            경로: `${placeLabel(order.departure)} → ${placeLabel(order.arrival)}`,
            접수시각: formatDateTime(order.requestedAt),
            예약시각: formatDateTime(order.scheduledAt),
            사유: callArgs.reason || null,
          },
        },
      };
    }

    if (order.isModifiable === false) {
      return { ok: false, error: '이 주문은 현재 변경할 수 없는 상태입니다. 상담원 연결이 필요합니다.' };
    }
    const changes = {};
    if (args.scheduledAt) {
      const normalized = toCallmanerDateTime(args.scheduledAt);
      if (!normalized) return { ok: false, error: '예약 시각을 이해하지 못했습니다. "2026-08-10 14:00"처럼 알려주세요.' };
      changes.scheduledAt = normalized;
    }
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
          접수번호: await displayReceiptNo(rcptNo),
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
    summary: {
      ...pending.summary,
      이용고객: `${access.maskPhone(ctx.primaryCid)} (접수자 명의) / 실제 이용고객 ${access.maskPhone(pending.linkCid)}`,
      메모: notes,
    },
  };
}

// call.update가 ok:true를 돌려줘도, 콜마너 MCP 프록시가 예약시각 변경을 실제로는 반영하지
// 않는 사례가 실측으로 확인됐다(updatedAt은 갱신되지만 예약시각 자체는 그대로였음 — 콜마너
// 쪽 응답에는 reservation_time을 되읽어볼 방법이 없어 우리 쪽에서 재확인은 불가능하다).
// 이 도구가 다루는 rcptNo가 우리 orders 테이블의 오더이기도 하면(callmaner_conf_slip 일치),
// MCP 프록시의 결과를 신뢰하지 않고 우리 DB를 직접 갱신한 뒤, 이미 검증된 우리 자체 연동
// (updateOrderWithCallmaner → OrderModify)으로 콜마너에도 한 번 더 확실히 반영한다.
async function syncLocalOrderAfterMcpUpdate(changes, rcptNo) {
  try {
    const order = await db.get('SELECT * FROM orders WHERE callmaner_conf_slip = ?', [rcptNo]);
    if (!order) return; // 우리 시스템 밖에서 만들어진 콜(전화/앱 직접접수)일 수 있음 — 할 일 없음.

    const sets = [];
    const params = [];

    if (changes.scheduledAt) {
      const m = String(changes.scheduledAt).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
      if (m) { sets.push('reserved_date = ?', 'reserved_time = ?'); params.push(m[1], m[2]); }
    }
    if (Number.isFinite(Number(changes.fare)) && Number(changes.fare) > 0) {
      sets.push('fare_amount = ?');
      params.push(Math.round(Number(changes.fare)));
    }
    if (changes.notes) {
      sets.push('memo_customer = ?');
      params.push(String(changes.notes).slice(0, 500));
    }

    async function placeUpdate(place, prefix) {
      if (!place) return;
      const xy = String(place.xy || '').split(',').map((s) => Number(s.trim()));
      const lat = xy[0]; const lng = xy[1];
      const address = place.address || place.name || null;
      if (address) { sets.push(`${prefix}_address = ?`); params.push(address); }
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        sets.push(`${prefix}_lat = ?`, `${prefix}_lon = ?`);
        params.push(lat, lng);
        const region = await lookupRegion(lat, lng).catch(() => null);
        if (region && region.sido) {
          sets.push(`${prefix}_sido = ?`, `${prefix}_sigugun = ?`, `${prefix}_dong = ?`);
          params.push(region.sido, region.sigugun, region.dong);
        }
      }
    }
    await placeUpdate(changes.departure, 'origin');
    await placeUpdate(changes.arrival, 'destination');

    if (sets.length === 0) return;

    sets.push(`updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')`);
    params.push(order.id);
    await db.run(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, params);
    await db.run(
      `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note) VALUES (?, NULL, ?, ?, ?)`,
      [order.id, order.status, order.status, `[MCP 챗봇] 주문 변경: ${Object.keys(changes).join(', ')}`]
    );

    // 이미 검증된 우리 자체 연동으로 콜마너에도 한 번 더 확실히 반영한다.
    await updateOrderWithCallmaner(order.id, order.branch_id);
  } catch (e) {
    console.error('MCP 변경 이후 로컬 DB 반영 실패:', e.message);
  }
}

// 변경 계열 도구의 2단계: 사용자가 동의한 뒤 서버가 직접 실행한다.
async function executePending(ctx, sessionId, pending) {
  if (pending.action === 'locate') return runLocate(ctx, sessionId, pending);
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
  if (pending.mcpTool === 'call.update' && pending.callArgs && pending.callArgs.changes) {
    await syncLocalOrderAfterMcpUpdate(pending.callArgs.changes, pending.callArgs.orderId);
  }
  return { ok: true, data: out.data || {} };
}

// "2026-08-06T11:49:03+09:00" → "2026-08-06 11:49" (KST 고정이라 오프셋은 떼고 보여준다)
function formatDateTime(raw) {
  const m = String(raw || '').trim().match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : (String(raw || '').trim() || null);
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
    else if (s.접수시각) lines.push(`▪ 접수시각: ${s.접수시각}`);
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
    if (s.접수번호) lines.push(`▪ 접수번호: ${s.접수번호}`);
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
    // 방금 콜마너에 만든 건이라 우리 오더번호가 아직 없다 — 규칙대로 콜마너 접수번호만 안내한다.
    if (data.rcptNo) lines.push(`▪ 접수번호: ${data.rcptNo}`);
    const s = pending.summary || {};
    lines.push(`▪ 경로: ${s.출발지 || '-'} → ${s.도착지 || '-'}`);
    if (data.scheduledAt || s.예약시각) lines.push(`▪ 예약시각: ${data.scheduledAt || s.예약시각}`);
    const fare = formatFare(data.fare != null ? data.fare : s.요금);
    if (fare) lines.push(`▪ 요금: ${fare}`);
    if (data.etaSeconds) lines.push(`▪ 예상 도착: 약 ${Math.round(Number(data.etaSeconds) / 60)}분`);
    if (data.message) lines.push(data.message);
    // 예약 반영 여부는 응답의 serviceType이 아니라 st로 판단한다 — 예약이 정상 등록돼도
    // serviceType은 "immediate"로 돌아오고(응답 필드가 실제 상태를 반영하지 않음), 실제 상태는
    // st="scheduled" / statusCode="R" / message="예약 접수가 생성되었습니다"로 나타난다.
    if (pending.callArgs && pending.callArgs.scheduledAt
        && data.st !== 'scheduled' && !/예약/.test(String(data.message || ''))) {
      lines.push('※ 예약 시각이 반영되지 않고 즉시 호출로 접수되었습니다. 예약을 원하시면 상담원 확인이 필요합니다.');
    }
    return lines.join('\n');
  }
  if (pending.mcpTool === 'call.cancel') {
    const shown = (pending.summary && pending.summary.접수번호) || data.rcptNo || (pending.callArgs && pending.callArgs.rcptNo);
    return `접수번호 ${shown} 주문을 취소했습니다.${data.message ? '\n' + data.message : ''}`;
  }
  if (pending.mcpTool === 'call.update') {
    const changes = (pending.callArgs && pending.callArgs.changes) || {};
    const shown = (pending.summary && pending.summary.접수번호) || (pending.callArgs && pending.callArgs.orderId) || '';
    const lines = [`접수번호 ${shown} 주문을 변경했습니다.`];
    if (changes.scheduledAt) lines.push(`▪ 예약시각: ${String(changes.scheduledAt).replace('T', ' ')}`);
    if (changes.departure) lines.push(`▪ 출발지: ${changes.departure.name}`);
    if (changes.arrival) lines.push(`▪ 도착지: ${changes.arrival.name}`);
    const changedFare = formatFare(changes.fare);
    if (changedFare) lines.push(`▪ 요금: ${changedFare}`);
    if (changes.notes) lines.push(`▪ 메모: ${changes.notes}`);
    // 콜마너는 어떤 필드가 실제로 반영됐는지 changes.applied로 알려준다. 우리가 바꾸려던 값이
    // 거기에 없으면 반영되지 않은 것이므로 "변경했다"고만 말하고 끝내지 않는다.
    const applied = (data.changes && Array.isArray(data.changes.applied)) ? data.changes.applied : null;
    if (applied) {
      const notApplied = Object.keys(changes).filter((k) => applied.indexOf(k) < 0);
      if (notApplied.length) {
        lines.push(`※ 다음 항목은 반영되지 않았습니다: ${notApplied.join(', ')}. 상담원 확인이 필요합니다.`);
      }
    }
    return lines.join('\n');
  }
  if (pending.mcpTool === 'call.raise') {
    // 인상 후 요금은 콜마너 응답(newFare)을 우선 쓰고, 없으면 우리가 계산한 값으로 안내한다.
    const newFare = formatFare(data.newFare != null ? data.newFare : (pending.summary && pending.summary.인상후요금));
    const shown = (pending.summary && pending.summary.접수번호) || data.rcptNo || '';
    return (shown ? `접수번호 ${shown}\n` : '') + `요금이 ${newFare || '-'}으로 수정되어 배차 진행하고 있습니다.`;
  }
  return '요청을 처리했습니다.';
}

// ---------------- 고정 질문 빠른 응답(모델을 거치지 않는 내부 함수) ----------------
// "접수내역 알려줘"처럼 뜻이 하나뿐인 조회는 서버가 직접 답한다. 모델 경로는 도구 선택과 답변
// 작성으로 Gemini를 두 번 왕복해서(실측 5초대) 이 한 문장에 쓰기엔 과하고, 답변 형식도 실행할
// 때마다 달라진다(같은 질문에 어떤 때는 불릿, 어떤 때는 번호).
//
// 안전 설계 — 이 경로가 사고를 내지 않도록 세 가지를 지킨다.
//  1) **조회 전용이다.** 부를 수 있는 도구가 get_my_orders 하나로 코드에 박혀 있어, 취소·변경·
//     요금인상 같은 변경 도구에는 구조적으로 도달할 수 없다(모델이 관여하지 않으므로 도구를
//     잘못 고를 여지 자체가 없다).
//  2) **권한·마스킹은 모델 경로와 같은 코드를 쓴다.** runReadTool을 그대로 호출하므로 조회 대상
//     연락처 제한(ctx.lookupOrder)·전화번호 마스킹·호출 로깅이 동일하게 적용된다. 여기서만
//     보이는 데이터는 없다.
//  3) **조금이라도 애매하면 넘기지 않는다.** 아래 허용 패턴에 정확히 들어맞고 금지어가 하나도
//     없을 때만 탄다. 실패하거나 애매하면 null을 돌려 기존 모델 경로가 그대로 처리한다 —
//     이 경로가 있어서 못 하게 되는 일은 없다.
//
// 허용: "접수내역", "주문 내역 알려줘", "접수 현황 좀 보여줘", "진행중인 주문" 정도의 짧은 문장.
const FIXED_ACTIVE_LIST_RE = /^(내|제|나의)?\s*(진행\s*중(인)?\s*)?(접수|주문|오더|배차)\s*(내역|현황|목록|리스트|상황)?\s*(을|를|은|는|좀)?\s*(알려|보여|확인|조회|말해)?\s*(줘|주세요|주실래요|해줘|해주세요|줄래|드릴까요|부탁해|부탁드려요)?\s*[?？.!~]*$/;

// 금지어 — 하나라도 있으면 모델에게 넘긴다.
//  · 기간/날짜: 이력 조회(get_order_history)로 가야 하는 질문이다.
//  · 변경 동사: 조회로 답하면 안 되는 요청이다(취소·변경·요금인상·신규접수).
//  · 특정 항목 질문: 기사/요금/위치처럼 답의 초점이 목록이 아닌 경우.
//  · 접수번호/순번 지목: 특정 건 상세라 목록으로 답하면 안 된다.
const FIXED_QUERY_BLOCKERS_RE = new RegExp([
  '오늘|어제|내일|모레|이번\\s*주|지난\\s*주|이번\\s*달|지난\\s*달|저번|최근|\\d+\\s*(월|일|주|개월)|기간|부터|까지',
  '취소|변경|수정|바꿔|올려|인상|낮춰|등록|접수해|접수하|예약해|불러|배차해',
  '기사|요금|얼마|가격|위치|어디|언제|도착|출발\\s*했|연락처|전화번호',
  '상세|자세|détail|\\d+\\s*번|접수번호|주문번호|OID',
].join('|'), 'i');

// 질문이 이 고정 조회 하나만 담고 있는지. 여러 요청이 한 문장에 섞이면(예: "접수내역 알려주고
// 2번은 취소해줘") 모델이 판단해야 한다 — 길이와 문장부호로 거른다.
function matchFixedQuery(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 30) return null;
  if (/[,\n]|그리고|하고\s|또한|및\s/.test(t)) return null;
  if (FIXED_QUERY_BLOCKERS_RE.test(t)) return null;
  if (!FIXED_ACTIVE_LIST_RE.test(t)) return null;
  // "주문"처럼 명사 하나만 온 경우는 무슨 뜻인지 알 수 없다 — 모델에게 넘긴다.
  if (!/(내역|현황|목록|리스트|상황|알려|보여|확인|조회|진행)/.test(t)) return null;
  return 'active_list';
}

// 진행 중 목록을 서버가 직접 문장으로 만든다. 항목과 순서는 모델에게 지시한 규칙
// (buildSystemInstruction의 답변 작성 규칙)과 같게 맞춘다 — 같은 질문에 경로에 따라 다른
// 모양이 나오면 그것대로 혼란스럽다.
// 한 번에 보여줄 주문 건수. 카카오 말풍선은 길면 접히고, 5건이 넘어가면 고객이 스크롤로만
// 확인하게 된다 — 5건씩 끊고 "다음"으로 이어보게 한다(사용자 확정 규칙).
const LIST_PAGE_SIZE = 5;

function formatActiveListAnswer(result, offset) {
  const all = (result && result.activeOrders) || [];
  const 조건 = (result && result.조회조건) || '진행 중인 주문';
  if (!all.length) return `${조건}으로 조회된 주문이 없습니다.`;

  const start = Math.max(0, Number(offset) || 0);
  const orders = all.slice(start, start + LIST_PAGE_SIZE);
  if (!orders.length) return '더 보여드릴 주문이 없습니다.';

  const blocks = orders.map((o, i) => {
    const lines = [`${start + i + 1}. 접수번호 ${o.접수번호}`];
    if (o.예약시간) lines.push(`   ${o.시각구분 === '접수시간(즉시)' ? '접수시간' : '예약시간'}: ${o.예약시간}`);
    lines.push(`   출발지: ${o.출발지}${o.출발지연락처 ? ` (${o.출발지연락처})` : ''}`);
    lines.push(`   도착지: ${o.도착지}${o.도착지연락처 ? ` (${o.도착지연락처})` : ''}`);
    lines.push(`   상태: ${o.상태 || '-'}${o.기사배정 ? ' (기사 배정됨)' : ' (기사 미배정)'}`);
    const fare = formatFare(o.요금);
    if (fare) lines.push(`   요금: ${fare}`);
    return lines.join('\n');
  });

  const delayed = all.filter((o) => o.배차지연);
  const tail = delayed.length
    ? `배차가 지연되고 있는 주문이 ${delayed.length}건 있습니다 (${delayed.map((o) => o.접수번호).join(', ')}). 요금을 올려 배차를 서두를 수 있습니다.`
    : '현재 배차가 지연되고 있는 주문은 없습니다.';

  const shownTo = start + orders.length;
  const head = all.length > LIST_PAGE_SIZE
    ? `${조건}으로 ${all.length}건입니다. (${start + 1}~${shownTo}번)`
    : `${조건}으로 ${all.length}건입니다.`;

  const parts = [head, '', blocks.join('\n\n'), ''];
  // 남은 게 있을 때만 안내한다 — 더 볼 게 없는데 "다음"을 안내하면 눌러도 아무것도 안 나온다.
  if (shownTo < all.length) {
    parts.push(`${all.length}건 중 ${shownTo}건까지 보여드렸습니다. "다음"을 입력하시면 추가로 보여집니다.`);
  }
  parts.push(tail);
  return parts.join('\n');
}

// "다음"으로 이어볼 수 있게 남겨두는 상태. 확인 대기(mcp_pending_json)와 같은 칸을 쓰지만
// action으로 구분하고, 확인 응답(예/아니오) 판정보다 먼저 처리해 서로 간섭하지 않게 한다.
const LIST_MORE_RE = /^\s*(다음|더|더\s*보여|다음\s*(건|것|페이지)?|next)\s*[.!?~]*\s*$/i;

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
// 위치 질문 전용 경로 — 최신 진행 건 하나를 짚어 "이 건을 조회해드릴까요?"까지만 하고 멈춘다.
// 모델에게 맡기지 않고 서버가 직접 처리하는 이유는, 확인 없이 곧장 기사 위치를 읊어버리거나
// 엉뚱한 주문을 골라 답하는 걸 막기 위해서다.
const ASK_RECEIPT_NO = '접수번호를 말씀해 주시면 조회해 드립니다.';

async function offerLocateLatestOrder(ctx, sessionId) {
  const cids = ctx.lookupOrder.slice();
  if (!cids.length) return { handled: true, message: ASK_RECEIPT_NO, expectsReply: true };

  const results = await Promise.all(cids.map(async (cid) => {
    const out = await mcp.callTool('call.list.active', { repNo: ctx.repNo, cid });
    await access.logToolCall(ctx, sessionId, 'call.list.active', { cid }, out.ok, out.error);
    return out;
  }));

  const orders = [];
  const seen = new Set();
  results.forEach((out) => {
    if (!out.ok) return;
    ((out.data && out.data.orders) || []).forEach((o) => {
      const key = String(o.rcptNo || '');
      if (key && !seen.has(key)) { seen.add(key); orders.push(o); }
    });
  });

  if (!orders.length) return { handled: true, message: '진행 중인 주문이 없습니다.\n' + ASK_RECEIPT_NO, expectsReply: true };

  // 가장 최근 건 = 접수시각이 가장 늦은 건. 값이 없으면 목록 순서를 그대로 신뢰한다.
  const latest = orders.slice().sort((a, b) => String(b.requestedAt || '').localeCompare(String(a.requestedAt || '')))[0];
  const [summary] = await withOidLabels([latest]);

  const lines = [
    '가장 최근 주문은 아래와 같습니다.',
    `· 접수번호: ${summary.접수번호}`,
    `· ${summary.시각구분}: ${summary.예약시간 || '-'}`,
    `· 출발지: ${summary.출발지}`,
    `· 도착지: ${summary.도착지}`,
    `· 상태: ${summary.상태 || '-'}`,
    '',
    '위 주문건을 조회해 드릴까요?',
  ];
  await savePending(sessionId, {
    action: 'locate',
    mcpTool: 'call.list.active',
    callArgs: { rcptNo: summary.도구용접수번호 },
    rcptNo: summary.도구용접수번호,
    signature: pendingSignature('locate', { rcptNo: summary.도구용접수번호 }),
    createdAt: Date.now(),
  });
  return { handled: true, message: lines.join('\n'), awaitingConfirmation: true, expectsReply: true };
}

// 확인을 받은 뒤 실제 위치를 안내한다.
async function runLocate(ctx, sessionId, pending) {
  const rcptNo = String(pending.rcptNo || '');
  const results = await Promise.all(ctx.lookupOrder.map(async (cid) => {
    const out = await mcp.callTool('call.list.active', { repNo: ctx.repNo, cid });
    await access.logToolCall(ctx, sessionId, 'call.list.active', { cid }, out.ok, out.error);
    return out;
  }));
  let order = null;
  results.forEach((out) => {
    if (!out.ok || order) return;
    order = ((out.data && out.data.orders) || []).find((o) => String(o.rcptNo || '') === rcptNo) || order;
  });
  if (!order) {
    return { ok: false, message: '해당 주문을 다시 조회하지 못했습니다. 잠시 후 다시 시도해주세요.' };
  }

  const [summary] = await withOidLabels([order]);
  const driver = order.driver || {};
  const head = `${summary.접수번호} 주문입니다.`;

  if (!driver.matched) {
    return { ok: true, message: `${head}\n아직 기사님이 배정되지 않았습니다. 배정되는 대로 안내드리겠습니다.` };
  }

  const place = await describeDriverPlace(driver.xy);
  const etaMin = formatEtaMinutes(driver.etaSecondsToPickup);
  const distKm = Number(driver.distanceKmToPickup);

  const lines = [head, '해당 주문은 기사님이 배차되어 진행 중입니다.'];
  lines.push(place ? `현재 기사님 위치는 ${place} 입니다.` : '현재 기사님 위치는 확인되지 않습니다.');
  const extra = [];
  if (Number.isFinite(distKm) && distKm > 0) extra.push(`출발지까지 약 ${distKm.toFixed(1)}km`);
  if (etaMin) extra.push(`약 ${etaMin}분 소요 예상`);
  if (extra.length) lines.push(extra.join(' · '));
  if (driver.lastFixAt) lines.push(`(위치 기준 시각 ${formatDateTime(driver.lastFixAt) || driver.lastFixAt})`);
  return { ok: true, message: lines.join('\n') };
}

// viewerCid — 조회 범위를 "지금 말하고 있는 사람 본인"으로 좁힐 때 그 확인된 번호. 웹(로그인
// 사용자)은 쓰지 않고, 카카오처럼 매핑 계정 자격으로 도는 채널만 넘긴다(routes/kakaoConsult.js).
async function runDispatchAgent({ user, sessionId, text, history, viewerCid, requesterGroupId }) {
  if (!mcp.isConfigured()) {
    return { handled: false, reason: 'not_configured' };
  }
  const ctx = await access.loadDispatchContext(user, { viewerCid, requesterGroupId });
  if (!ctx.repNo) return { handled: false, reason: 'no_rep_no' };
  if (!ctx.primaryCid && ctx.allowedCids.length === 0) {
    // 연락처를 모르면 주문을 특정할 수 없다. 다만 위치/도착 문의는 상담원으로 넘기기 전에
    // 접수번호를 물어보는 편이 고객에게 한 번의 왕복을 덜어준다(사용자 확정 규칙).
    if (isLocationQuestion(text)) return { handled: true, message: ASK_RECEIPT_NO, expectsReply: true };
    return { handled: false, reason: 'no_customer_phone' };
  }

  // 이번 발화를 ctx에 실어둔다 — 도구 인자 검증(sanitizeCustomerPhoneArg)이 "고객이 실제로
  // 번호를 말했는지"를 봐야 하기 때문이다.
  ctx.turnText = text;

  // 0) "다음" — 앞서 5건까지만 보여준 목록의 이어보기. 확인 응답 판정보다 먼저 처리한다
  // (그쪽으로 흘러가면 "다음"이 예/아니오 어느 쪽도 아니라 대기 상태만 지워진다).
  const listState = await loadPending(sessionId);
  if (listState && listState.action === 'list_page' && LIST_MORE_RE.test(text)) {
    let more = null;
    try {
      more = await runReadTool(ctx, sessionId, 'get_my_orders', {});
    } catch (e) {
      console.error('목록 이어보기 조회 실패:', e.message);
    }
    if (more && more.ok) {
      const offset = Number(listState.offset) || LIST_PAGE_SIZE;
      const total = (more.activeOrders || []).length;
      if (offset < total) {
        await savePending(sessionId, { action: 'list_page', offset: offset + LIST_PAGE_SIZE, createdAt: Date.now() });
      } else {
        await clearPending(sessionId);
      }
      return {
        handled: true,
        message: formatActiveListAnswer(more, offset),
        usedTools: ['get_my_orders(fast,more)'],
        awaitingConfirmation: false,
        expectsReply: false,
      };
    }
    await clearPending(sessionId);
  }

  // 1) 확인 대기 중이면 이번 메시지를 먼저 그 확인 응답으로 해석한다.
  const pending = listState && listState.action === 'list_page' ? null : listState;
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
          message: `${access.maskPhone(original)} 번호는 배차 시스템에 고객으로 등록되어 있지 않아 그 번호로는 접수할 수 없습니다.\n`
            + `대신 고객님(${access.maskPhone(ctx.primaryCid)}) 명의로 접수하고 실제 이용고객 연락처를 메모에 남기는 방식으로 등록할까요?\n`
            + describeConfirmation(result.fallback, { omitHeader: true }),
          awaitingConfirmation: true,
          expectsReply: true,
        };
      }
      return { handled: true, message: result.message || describeExecution(pending, result), executed: pending.mcpTool, ok: result.ok };
    }
    if (decided === 'no') {
      await clearPending(sessionId);
      return { handled: true, message: '요청을 진행하지 않았습니다. 다른 도움이 필요하시면 말씀해주세요.' };
    }
    // 확인도 거절도 아닌 새 요청이면 대기 상태를 버리고 아래 일반 처리로 넘어간다 —
    // 남겨두면 나중에 온 "네"가 엉뚱한 행위의 동의로 소비될 수 있다.
    await clearPending(sessionId);
  }

  // 2) 위치/도착 문의는 모델을 거치지 않고 서버가 직접 처리한다 — 최신 주문을 짚어 확인부터 받는다.
  if (isLocationQuestion(text)) {
    return offerLocateLatestOrder(ctx, sessionId);
  }

  // 3) 뜻이 하나뿐인 고정 조회는 모델을 거치지 않고 서버가 바로 답한다(matchFixedQuery 주석의
  // 안전 규칙 참고 — 조회 전용이고, 애매하면 여기서 걸리지 않고 아래 모델 경로로 내려간다).
  if (matchFixedQuery(text) === 'active_list') {
    let quick = null;
    try {
      quick = await runReadTool(ctx, sessionId, 'get_my_orders', {});
    } catch (e) {
      console.error('고정 조회 빠른 응답 실패(모델 경로로 되돌림):', e.message);
    }
    // 조회 자체가 실패했으면(미등록 고객 등) 여기서 문장을 만들지 않고 모델 경로에 맡긴다 —
    // 그쪽에는 상담원 인계 판단(sawNotRegistered)까지 붙어 있다.
    if (quick && quick.ok) {
      const total = (quick.activeOrders || []).length;
      // 5건이 넘으면 "다음"으로 이어볼 수 있게 위치를 남긴다. 5건 이하면 남길 이유가 없다.
      if (total > LIST_PAGE_SIZE) {
        await savePending(sessionId, { action: 'list_page', offset: LIST_PAGE_SIZE, createdAt: Date.now() });
      } else {
        await clearPending(sessionId);
      }
      return {
        handled: true,
        message: formatActiveListAnswer(quick, 0),
        usedTools: ['get_my_orders(fast)'],
        awaitingConfirmation: false,
        // 남은 건이 있으면 다음 메시지("다음")도 이 도우미가 먼저 받아야 한다.
        expectsReply: total > LIST_PAGE_SIZE,
      };
    }
  }

  // 4) 대화 히스토리 + 이번 메시지로 도구 호출 루프를 돈다.
  const contents = [];
  (history || []).slice(-MAX_HISTORY_MESSAGES).forEach((m) => {
    if (!m || !m.message) return;
    contents.push({ role: m.sender === 'user' ? 'user' : 'model', parts: [{ text: String(m.message).slice(0, 1500) }] });
  });
  contents.push({ role: 'user', parts: [{ text }] });

  const systemInstruction = buildSystemInstruction(ctx);
  const usedTools = [];
  let pendingSaved = false;
  // 조회 도구가 "이 연락처는 콜마너에 등록된 고객이 아니다"로만 실패했다면, 봇이 그 사실을
  // 문장으로 안내하고 끝내는 것보다 상담원에게 넘기는 편이 낫다 — 고객 입장에서는 아무것도
  // 해결되지 않은 채 대화가 끝나기 때문이다(연동을 켜도 기존 상담원 연결이 후퇴하지 않게 하는 장치).
  let sawNotRegistered = false;
  let anyToolSucceeded = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    // thinking을 끈다 — 이 루프가 하는 일은 도구 고르기와 도구 결과를 문장으로 옮기기라,
    // 켜두면 응답만 2.5배 느려지고(평균 8.0초 → 3.2초) 정확도 이득은 없었다(lib/vertexAi.js
    // generateWithTools 주석의 실측). 접수 필드 추출은 반대이므로 그쪽은 계속 켜둔다.
    const turn = await generateWithTools({ systemInstruction, contents, tools: TOOL_DECLARATIONS, thinking: false });

    if (!turn.functionCalls.length) {
      const message = turn.text;
      if (!message) return { handled: false, reason: 'empty_response', usedTools };
      if (sawNotRegistered && !anyToolSucceeded) {
        return { handled: false, reason: 'customer_not_registered', usedTools };
      }
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
    // 변경 도구(생성/수정/취소/인상)는 성공하면 그 즉시 이 함수 전체가 리턴된다(확인을 받아야
    // 하기 때문에) — 뒤에 이어지는 도구 호출을 실행하지 않는다는 뜻이라 순서가 의미를 가진다.
    // 이런 라운드는 예전처럼 순차로 처리한다. 조회 도구만 있는 라운드는 서로 결과에 의존하지
    // 않고 리턴도 하지 않으므로(runReadTool 내부에 공유 상태 변경이 없다 — 확인함) 동시에
    // 실행한다. 같은 턴에 여러 조회를 동시에 요청하는 경우(예: 출발지·도착지 장소 검색을
    // 한 번에 묻는 경우)가 실제로 있어서, 그 왕복만큼 그대로 지연으로 남아 있었다.
    if (turn.functionCalls.some((call) => MUTATING_TOOLS.has(call.name))) {
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
            logIntegrationErrorAsync({ source: 'mcp', operation: 'tool_call', refType: 'chat_session', refId: sessionId || null,
              message: e.message, context: { tool: name } });
            response = { ok: false, error: 'MCP 서버 호출에 실패했습니다: ' + e.message };
          }
        }

        if (response && response.ok) anyToolSucceeded = true;
        if (response && response.notRegistered) sawNotRegistered = true;

        responseParts.push({ functionResponse: { name, response } });
      }
    } else {
      const results = await Promise.all(turn.functionCalls.map(async (call) => {
        const name = call.name;
        const args = call.args || {};
        let response;
        try {
          response = await runReadTool(ctx, sessionId, name, args);
        } catch (e) {
          logIntegrationErrorAsync({ source: 'mcp', operation: 'tool_call', refType: 'chat_session', refId: sessionId || null,
            message: e.message, context: { tool: name } });
          response = { ok: false, error: 'MCP 서버 호출에 실패했습니다: ' + e.message };
        }
        return { name, response };
      }));
      // Promise.all은 입력 순서를 보존한다 — turn.functionCalls와 같은 순서로 usedTools/
      // responseParts를 채워, 순차 처리였을 때와 결과가 동일하다.
      results.forEach(({ name, response }) => {
        usedTools.push(name);
        if (response && response.ok) anyToolSucceeded = true;
        if (response && response.notRegistered) sawNotRegistered = true;
        responseParts.push({ functionResponse: { name, response } });
      });
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
  // 조회 화면과 똑같은 판정을 쓴다(evaluateDispatchDelay) — 두 곳의 기준이 갈리면 챗봇이
  // "지연 아님"이라고 안내한 건에 대해 요금 인상을 먼저 제안하는 모순이 생긴다.
  const labeled = await withOidLabels(orders);
  // 관리자(지사관리 > 배차지연 알림)에 등록된 고객사에만 선제 안내를 보낸다.
  const settings = await access.loadDispatchDelaySettings(ctx.branchId);
  if (!settings.size) return { offer: false, reason: 'no_delay_setting' };

  for (const row of labeled) {
    if (!row || !row.도구용접수번호) continue;
    if (!row.요금조정가능) continue;

    const setting = row.__groupId ? settings.get(Number(row.__groupId)) : null;
    if (!setting) continue; // 등록되지 않은 고객사(또는 우리 오더와 매칭 안 된 건)
    if (setting.orderTypes.length && row.__orderType && setting.orderTypes.indexOf(row.__orderType) < 0) continue;

    // 지연 기준(분)은 고객사 설정을 따른다 — 조회 표시용 기본 판정과 다를 수 있어 다시 계산한다.
    const verdict = evaluateDispatchDelay({
      st: row.__st, statusCode: row.__statusCode, matched: row.기사배정,
      접수시각: row.접수시각, 예약시각: row.예약시각,
    }, Date.now(), { delayMinutes: setting.delayMinutes });
    if (!verdict.지연) continue;
    if (await alreadyOfferedRaise(ctx, row.도구용접수번호)) continue;

    const prepared = await prepareMutation(ctx, sessionId, 'raise_fare', {
      rcptNo: row.도구용접수번호,
      raiseAmount: setting.raiseAmount,
    });
    if (!prepared.ok) continue;

    const signature = pendingSignature(prepared.pending.mcpTool, prepared.pending.callArgs);
    await savePending(sessionId, { ...prepared.pending, signature, createdAt: Date.now() });
    await access.logToolCall(ctx, sessionId, 'fare.raise.offer', prepared.pending.callArgs, true, null);

    return {
      offer: true,
      rcptNo: row.도구용접수번호,
      message: '현재 배차가 지연되고 있습니다.\n' + describeConfirmation(prepared.pending),
    };
  }
  return { offer: false, reason: 'no_delayed_order' };
}

module.exports = {
  isLocationQuestion,
  runDispatchAgent,
  checkDispatchDelay,
  loadPending,
  TOOL_DECLARATIONS,
  // 테스트/진단용
  isAffirmativeReply,
  isNegativeReply,
  buildSystemInstruction,
  parseKstDateTime,
  evaluateDispatchDelay,
};
