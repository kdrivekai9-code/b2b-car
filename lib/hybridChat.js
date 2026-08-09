// 하이브리드 챗봇 1단계: 지식검색(FAQ) + 오더접수를 하나의 입력창에서 처리하기 위한 의도 분류 + 필드 추출.
// Gemini(Vertex AI) structured output으로 "이 메시지가 오더접수 요청인지 FAQ 질문인지"를 판단하고,
// 오더접수라면 필요한 필드까지 한 번에 뽑아낸다. 날짜 연산은 LLM에게 맡기지 않고 서버에서 미리 계산해 주입한다
// (탁송접수 AI 자동입력 설계 문서의 핵심 트릭 — Gemini가 요일 계산을 틀리는 사고를 방지).
const { generateJson } = require('./vertexAi');
const { kstNow, toDateStr } = require('./period');

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    intent: { type: 'STRING', enum: ['dispatch_order', 'proxy_order', 'daily_driver_order', 'faq', 'unsupported'] },
    requestedFeature: { type: 'STRING' },
    seemsFrustrated: { type: 'BOOLEAN' },
    reservationDate: { type: 'STRING' },
    reservationTime: { type: 'STRING' },
    originAddress: { type: 'STRING' },
    originAddressDetail: { type: 'STRING' },
    originContact: { type: 'STRING' },
    originVehicleNumber: { type: 'STRING' },
    vehicleType: { type: 'STRING' },
    waypointAddress: { type: 'STRING' },
    waypointContact: { type: 'STRING' },
    waypointVehicleNumber: { type: 'STRING' },
    // 경유지에서 "다른 날" 다시 출발하는 경우에만 채운다 — 접수를 두 건으로 나눌지 정하는 값이다
    // (lib/orderSplit.js). 같은 날 이어서 도는 평범한 경유 운행에서는 비워둔다.
    waypointReservationDate: { type: 'STRING' },
    waypointReservationTime: { type: 'STRING' },
    destinationAddress: { type: 'STRING' },
    destinationAddressDetail: { type: 'STRING' },
    destinationContact: { type: 'STRING' },
    memo: { type: 'STRING' },
    billingMemo: { type: 'STRING' },
    // 일일기사/프리미엄 전용 필드
    tripType: { type: 'STRING', enum: ['round_trip', 'one_way'] },
    // 왕복인데 복귀편이 "다른 날"일 때만 채운다 — 이것도 분리 판단에 쓴다.
    returnReservationDate: { type: 'STRING' },
    returnReservationTime: { type: 'STRING' },
    finalDestinationAddress: { type: 'STRING' },
    finalDestinationAddressDetail: { type: 'STRING' },
    destinationWaitMinutes: { type: 'INTEGER' },
    reservationHoursBracket: { type: 'STRING', enum: ['within_4h', 'within_8h', 'over_8h'] },
  },
  required: ['intent'],
};

// 클라이언트가 방금 물어본 필수 항목(pendingField)의 한글 라벨 — 애매한 단답(전화번호만 온 경우 등)을
// 올바른 필드에 배정하도록 힌트를 준다. REQUIRED_TRANSPORT_FIELDS(설계 문서)의 서버 측 라벨 매핑.
const PENDING_FIELD_LABELS = {
  origin_address: '출발지 주소',
  origin_contact: '출발지 담당자 연락처',
  reserved_date: '예약일시(날짜와 시간)',
  destination_address: '도착지 주소',
  destination_contact: '도착지 담당자 연락처',
  vehicle_number: '차량번호',
  // 프리미엄(대리) 전용 FSM — public/js/ai-intake.js의 premium_* pendingField와 1:1 대응.
  premium_reserved_datetime: '예약일시(날짜와 시간)',
  premium_origin_address: '출발지 주소',
  premium_origin_contact: '출발지 담당자 연락처',
  premium_destination_address: '도착지 주소',
  premium_waypoint_address: '경유지 주소',
};

// 공통 지시문 — 모든 intent에서 재사용하는 블록
function _commonFieldInstructions(todayISO, tomorrowISO, dayAfterISO) {
  return `[출발지/경유지/도착지 구분 — 반드시 아래 라벨을 최우선으로 판단하세요]
- 줄이 "출", "출발", "출발지"로 시작하거나 이 단어 뒤에 콜론(:)이 오면, 그 줄 전체가 출발지 정보입니다 → originAddress/originContact
- 줄이 "경", "경유", "경유지"(뒤에 숫자가 붙어도 됨: 경1, 경유지2 등)로 시작하면 경유지 정보입니다 → waypointAddress/waypointContact
- 줄이 "도", "도착", "도착지"로 시작하면 도착지 정보입니다 → destinationAddress/destinationContact
- 이런 라벨이 전혀 없는 자연스러운 문장이라면 "~에서/출발/픽업"은 출발지, "~로/도착/인도"는 도착지로 판단하세요. 구분 표현이 전혀 없고 주소가 정확히 두 개만 언급되었다면 먼저 언급된 주소를 출발지, 나중 주소를 도착지로 처리하세요.
- 반드시 originAddress와 destinationAddress를 최우선으로 채우세요 — 경유지 정보만 채우고 출발지/도착지를 비워두면 안 됩니다.

[각 필드 설명]
- reservationDate: "YYYY-MM-DD" 형식. 오늘=${todayISO}, 내일=${tomorrowISO}, 모레=${dayAfterISO}. 이 날짜들을 기준으로 계산하세요.
- reservationTime: "HH:mm" 24시간제. "오후 2시"→14:00, "오전 10시"→10:00, "저녁 7시"→19:00
- originAddressDetail / destinationAddressDetail: 상세위치(층수, 주차구역, 동/호수 등)
- originContact / waypointContact / destinationContact: 담당자 연락처, 010-XXXX-XXXX 형식으로 정규화
- originVehicleNumber / waypointVehicleNumber: "차량번호"라는 말과 함께 오거나 숫자+한글1자+숫자 형태로 보이는 표현이면, 표준 자릿수(2~3자리+한글1자+4자리)와 다르더라도 원문 그대로 추출하세요. 차량번호가 여러 개 언급되면 첫 번째는 originVehicleNumber, 두 번째는 waypointVehicleNumber로 순서대로 배정하세요.
- vehicleType: 차종(예: 카니발, 쏘렌토, 1톤, 5톤, 토레스). 차량번호와 같이 언급되면 차종만 분리해 채우세요.
- waypointReservationDate / waypointReservationTime: 경유지에서 **다른 날** 다시 출발한다고 말한 경우에만 채우세요.
  ("20일 서울에서 대전, 22일 대전에서 부산" → waypointReservationDate=22일에 해당하는 날짜)
  같은 날 이어서 도는 경우이거나 경유지 출발 시점을 말하지 않았으면 이 키를 아예 빼세요.
- returnReservationDate / returnReservationTime: 왕복인데 돌아오는 날이 **가는 날과 다를** 때만 채우세요.
  ("20일 갔다가 22일에 돌아오는" → returnReservationDate=22일에 해당하는 날짜)
  당일 왕복이거나 돌아오는 시점을 말하지 않았으면 이 키를 아예 빼세요.

[감정 판단]
- seemsFrustrated: 사용자가 화가 났거나 답답해하는 것으로 보이면 true, 아니면 이 키를 아예 빼세요. 욕설·비속어, "몇 번을 말해요", "답답하네요" 같은 명확히 부정적인 감정 표현이 있을 때만 true로 판단하세요.`;
}

// 탁송 전용 추가 지시문 — 원문 그대로 메모 규칙
function _dispatchMemoInstructions() {
  return `[전달사항]
- memo: 기사요청사항 — 탁송기사가 실제로 업무를 수행하거나 수행 후 처리해야 할 내용. 위 필드에 해당하지 않는 요청사항·차량상태·특이사항은 여기에 넣으세요.
- billingMemo: 업체요청사항 — 계산서·명세서 발행 시 참고해야 하는 내용. memo와 겹치지 않게, 이 조건에 명확히 해당할 때만 채우세요.
- memo/billingMemo 모두 짧게, 판단 설명 없이 **원문 그대로** 옮기세요.`;
}

// 프리미엄/일일기사 전용 추가 지시문 — 요약형 메모 규칙 + 전용 필드
function _premiumMemoInstructions() {
  return `[전달사항 — 요약형]
- memo: 기사전달사항 — 내용이 여러 건이거나 길면 핵심만 "항목 : 내용" 형식으로 정리하세요 (예: "세차상태 : 이물질 확인 요망 / 주차위치 : 지하 2층 B구역").
- billingMemo: 업체전달사항 — 계산서·명세서 발행 관련 내용만 해당. 동일하게 요약형으로.

[일일기사/프리미엄 전용 필드]
- tripType: 왕복이면 "round_trip", 편도이면 "one_way". 명시적으로 언급한 경우에만 채우세요.
- finalDestinationAddress: 왕복 일일기사의 최종 목적지(기사가 최종적으로 돌아올 목적지).
- destinationWaitMinutes: 도착지 대기 시간(분). 언급된 경우에만 채우세요.
- reservationHoursBracket: 총 예약시간 구간. "4시간 이내"→"within_4h", "8시간 이내"→"within_8h", "8시간 이상"→"over_8h".`;
}

function buildSystemInstruction(pendingField, intent) {
  const now = kstNow();
  const addDays = (n) => new Date(now.getTime() + n * 86400000);
  const todayISO = toDateStr(now);
  const tomorrowISO = toDateStr(addDays(1));
  const dayAfterISO = toDateStr(addDays(2));

  const pendingLabel = PENDING_FIELD_LABELS[pendingField];
  const pendingHint = pendingLabel
    ? `\n\n[참고] 바로 직전에 상담원이 사용자에게 "${pendingLabel}"를 물었습니다. 이번 메시지에 다른 단서가 없다면 그 값을 이 필드에 채우세요. 단, 메시지 자체가 다른 필드임을 명확히 나타내면 그 판단을 우선하세요.`
    : '';

  const isPremiumOrDaily = intent === 'premium_order' || intent === 'daily_driver_order';

  return `당신은 탁송(차량 배송)과 대리운전(프리미엄 서비스·일일기사)을 함께 취급하는 B2B 플랫폼의
하이브리드 챗봇 입력 분석기입니다. 탁송 문의/접수뿐 아니라 대리운전(프리미엄) 문의/접수도 동일한
비중으로 처리하는 것이 당신의 역할입니다.
사용자 메시지를 읽고 intent를 다음 중 하나로 분류하세요:
- "dispatch_order": 탁송 오더 접수(신규 차량 픽업/배송 예약) 요청
- "proxy_order": 대리/프리미엄 오더 접수(대리운전·프리미엄 서비스 예약) 요청
- "daily_driver_order": 일일기사 오더 접수(일일 대리기사/기사 대절, 8시간 이상 대여 포함) 요청
- "unsupported": 오더 수정/변경, 취소, 배차·진행 상태 조회, 상담원 연결 요청 등. requestedFeature 필드에 요청한 기능을 짧은 한글 명사구로 채우세요.
- "faq": 그 외 일반 문의, 정책 질문, 잡담 등

메시지가 짧거나 값 하나만 온 경우라도 뚜렷한 질문 형태나 상담원 연결 의사가 없으면 오더 intent로 분류해 알아볼 수 있는 필드만 채우세요.

intent가 오더 intent이면 아래 필드를 메시지에서 언급된 것만 추출하세요.
**중요: 값을 알 수 없는 필드는 응답 JSON에서 그 키를 아예 빼세요. 절대로 "null"이나 "없음" 같은 문자열을 값으로 넣지 마세요.**

${_commonFieldInstructions(todayISO, tomorrowISO, dayAfterISO)}

${isPremiumOrDaily ? _premiumMemoInstructions() : _dispatchMemoInstructions()}

intent가 "faq" 또는 "unsupported"이면 오더 관련 필드는 전부 생략하세요 (unsupported는 requestedFeature만 채우세요).${pendingHint}`;
}

async function classifyAndExtract(text, pendingField, intent) {
  return generateJson(buildSystemInstruction(pendingField, intent), text, RESPONSE_SCHEMA);
}

// 확인/수정/후보선택 단계에서 쓰는 짧은 답변 분류기 — 이 단계들은 원래 로컬 키워드로만 판단해서 빠르지만,
// 사용자가 예상 못 한 표현("수정할 거 없어", "상담원연결" 등)을 쓰면 놓치는 경우가 실제로 있었다.
// 그래서 클라이언트가 로컬 키워드로 먼저 판단해보고, 애매할 때만(폴백으로) 이 함수를 호출한다.
// 탁송(REQUIRED_FIELDS)과 일일기사(getDailyDriverFields)는 필드 구성이 다르다(일일기사는
// destination_contact 대신 trip_type/final_destination_address/memo_customer 등을 쓴다).
// 예전에는 이 enum이 탁송 6항목으로 고정돼 있어서, 일일기사 사용자가 "전달사항 수정해줘"라고
// 해도 Gemini가 그 필드를 아예 고를 수가 없었다(스키마 enum 밖의 값은 낼 수 없음). 클라이언트가
// 지금 실제로 쓰는 필드 목록(extra.fieldChoices, [{id,label}])을 보내면 그걸로 enum/설명을
// 만들고, 안 보내면(구버전 클라이언트 등) 기존 탁송 6항목으로 폴백한다.
const DEFAULT_FIELD_CHOICES = [
  { id: 'origin_address', label: '출발지 주소' },
  { id: 'origin_contact', label: '출발지 연락처' },
  { id: 'destination_address', label: '도착지 주소' },
  { id: 'destination_contact', label: '도착지 연락처' },
  { id: 'vehicle_number', label: '차량번호' },
  { id: 'reserved_date', label: '예약일시' },
];

function buildPhaseReplySchema(phase, extra) {
  const fieldChoices = (phase === 'choose_field' && Array.isArray(extra && extra.fieldChoices) && extra.fieldChoices.length)
    ? extra.fieldChoices
    : DEFAULT_FIELD_CHOICES;
  return {
    type: 'OBJECT',
    properties: {
      action: { type: 'STRING', enum: ['yes', 'no', 'none', 'field', 'choice1', 'choice2', 'agent', 'unclear'] },
      field: { type: 'STRING', enum: fieldChoices.map((f) => f.id) },
    },
    required: ['action'],
  };
}

function buildPhaseReplyInstruction(phase, extra) {
  const common = `당신은 탁송·대리운전(프리미엄) B2B 챗봇의 짧은 대화 응답 분석기입니다. 사용자의 한두 문장짜리 답변을 보고 의도를 분류하세요.
공통 규칙: 사용자가 "상담원"/"상담사"와 대화하고 싶다는 의사를 조금이라도 비치면(예: "상담원연결", "사람이랑 얘기하고 싶어요" 등 표현이 다양할 수 있음) 다른 규칙보다 우선해서 action을 "agent"로 답하세요.`;

  if (phase === 'confirming') {
    return `${common}

방금 챗봇이 "위 내용으로 등록해 드릴까요?"라고 물었습니다. 답변을 분류하세요:
- "yes": 등록/진행에 동의함
- "no": 등록하지 말고 뭔가 수정하고 싶어함
- "agent": 상담원 연결을 원함
- "unclear": 위 어디에도 명확히 해당하지 않음`;
  }
  if (phase === 'choose_field') {
    const fieldChoices = (Array.isArray(extra && extra.fieldChoices) && extra.fieldChoices.length)
      ? extra.fieldChoices
      : DEFAULT_FIELD_CHOICES;
    const fieldList = fieldChoices.map((f) => `${f.label}=${f.id}`).join(', ');
    return `${common}

방금 챗봇이 "어느 부분을 수정해드릴까요?"라고 물었습니다(선택 가능 항목: ${fieldList}). 답변을 분류하세요:
- "field": 특정 항목을 수정하고 싶어함 — field에 해당 항목의 영문 id를 정확히 채우세요.
- "none": 사실 수정할 게 없다고 함(마음이 바뀜, 그냥 등록해도 된다는 의미)
- "agent": 상담원 연결을 원함
- "unclear": 위 어디에도 명확히 해당하지 않음`;
  }
  if (phase === 'choose_address_candidate') {
    const c1 = (extra && extra.candidates && extra.candidates[0]) || '';
    const c2 = (extra && extra.candidates && extra.candidates[1]) || '';
    return `${common}

방금 챗봇이 아래 두 주소 후보 중 어느 것이 맞는지 물었습니다:
1) ${c1}
2) ${c2}
답변을 분류하세요:
- "choice1": 1번을 선택함
- "choice2": 2번을 선택함
- "agent": 상담원 연결을 원함
- "unclear": 위 어디에도 명확히 해당하지 않음`;
  }
  return common;
}

async function classifyPhaseReply(text, phase, extra) {
  return generateJson(buildPhaseReplyInstruction(phase, extra), text, buildPhaseReplySchema(phase, extra));
}

module.exports = { classifyAndExtract, classifyPhaseReply };
