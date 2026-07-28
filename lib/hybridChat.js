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
    destinationAddress: { type: 'STRING' },
    destinationAddressDetail: { type: 'STRING' },
    destinationContact: { type: 'STRING' },
    memo: { type: 'STRING' },
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
};

function buildSystemInstruction(pendingField) {
  const now = kstNow();
  const addDays = (n) => new Date(now.getTime() + n * 86400000);
  const todayISO = toDateStr(now);
  const tomorrowISO = toDateStr(addDays(1));
  const dayAfterISO = toDateStr(addDays(2));

  const pendingLabel = PENDING_FIELD_LABELS[pendingField];
  const pendingHint = pendingLabel
    ? `\n\n[참고] 바로 직전에 상담원이 사용자에게 "${pendingLabel}"를 물었습니다. 이번 메시지에 다른 단서가 없다면(예: 전화번호만 달랑 온 경우, 주소로 보이는 짧은 텍스트만 온 경우) 그 값을 이 필드에 채우세요. 단, 메시지 자체가 다른 필드임을 명확히 나타내면(예: 라벨이나 문맥이 다르면) 그 판단을 우선하세요.`
    : '';

  return `당신은 탁송(차량 배송) B2B 플랫폼의 하이브리드 챗봇 입력 분석기입니다.
사용자 메시지를 읽고 intent를 다음 중 하나로 분류하세요:
- "dispatch_order": 탁송 오더 접수(신규 차량 픽업/배송 예약) 요청
- "proxy_order": 대리 오더 접수(대리운전/대리기사 요청) 요청
- "daily_driver_order": 일일기사 오더 접수(일일 대리기사/기사 대절 요청) 요청
- "unsupported": 아직 이 챗봇이 지원하지 않는 기능 요청 — 오더 수정/변경, 오더 취소, 배차·진행 상태 조회, 배차 기사 정보 조회, 상담원 연결 요청 등. requestedFeature 필드에 요청한 기능을 짧은 한글 명사구로 채우세요 (예: "오더 취소", "배차 상태 조회", "상담원 연결").
- "faq": 그 외 일반 문의, 정책 질문, 잡담 등 (지식베이스에서 검색해 답할 만한 질문)

이 챗봇은 대부분 오더 접수 도중에 쓰입니다 — 메시지가 아주 짧거나 라벨 없이 값 하나만 온 경우(예:
지명 하나, 전화번호 하나, 차량번호로 보이는 문자열 하나)라도 그 자체가 뚜렷한 질문 형태이거나("~인가요",
"~할 수 있나요" 등) 상담원 연결 의사를 분명히 드러내지 않는 한 "faq"나 "unsupported"로 넘기지 말고
오더 intent("dispatch_order" / "proxy_order" / "daily_driver_order") 중 가장 맞는 값으로 분류해 알아볼 수 있는 필드만 채우세요.

intent가 오더 intent("dispatch_order" / "proxy_order" / "daily_driver_order")이면 아래 필드를 메시지에서 언급된 것만 추출하세요.
**중요: 값을 알 수 없는 필드는 응답 JSON에서 그 키를 아예 빼세요. 절대로 "null"이나 "없음" 같은 문자열을 값으로 넣지 마세요.**

[출발지/경유지/도착지 구분 — 반드시 아래 라벨을 최우선으로 판단하세요]
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
- originVehicleNumber / waypointVehicleNumber: "차량번호"라는 말과 함께 오거나 숫자+한글1자+숫자 형태로 보이는 표현이면, 표준 자릿수(2~3자리+한글1자+4자리)와 다르더라도 원문 그대로 추출하세요 — 형식이 맞는지는 별도 시스템이 검증하니 여기서 걸러내거나 고치지 마세요. 차량번호가 여러 개 언급되면 첫 번째는 originVehicleNumber, 두 번째는 waypointVehicleNumber로 순서대로 배정하세요 — 어디에 넣을지 애매해도 임의로 판단해서 반드시 값을 채우고, 판단 과정을 설명하는 문장을 값에 포함하지 마세요.
- vehicleType: 차종(예: 카니발, 쏘렌토, 1톤, 5톤, 토레스). 차량번호와 같이 언급되면 차종만 분리해 채우세요.
- memo: 위 항목에 해당하지 않는 요청사항·차량상태·특이사항 (짧게, 판단 설명 없이 원문 그대로)

[감정 판단]
- seemsFrustrated: 사용자가 화가 났거나 답답해하는 것으로 보이면 true, 아니면 이 키를 아예 빼세요.
  욕설·비속어, "왜 이렇게 오래 걸려요", "몇 번을 말해요", "답답하네요", "짜증나네요" 같은 표현, 과도한
  느낌표/물음표 반복, 강한 어조의 항의 등이 신호입니다. 단순히 서두르는 것("빨리 해주세요" 정도)만으로는
  true로 보지 마세요 — 명확히 부정적인 감정 표현이 있을 때만 true로 answer하세요. intent나 다른 필드
  판단과 무관하게 독립적으로 평가하세요(예: intent가 오더 intent여도 화난 말투면 true일 수 있습니다).

intent가 "faq" 또는 "unsupported"이면 오더 관련 필드는 전부 생략하세요 (unsupported는 requestedFeature만 채우세요).${pendingHint}`;
}

async function classifyAndExtract(text, pendingField) {
  return generateJson(buildSystemInstruction(pendingField), text, RESPONSE_SCHEMA);
}

// 확인/수정/후보선택 단계에서 쓰는 짧은 답변 분류기 — 이 단계들은 원래 로컬 키워드로만 판단해서 빠르지만,
// 사용자가 예상 못 한 표현("수정할 거 없어", "상담원연결" 등)을 쓰면 놓치는 경우가 실제로 있었다.
// 그래서 클라이언트가 로컬 키워드로 먼저 판단해보고, 애매할 때만(폴백으로) 이 함수를 호출한다.
const PHASE_REPLY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    action: { type: 'STRING', enum: ['yes', 'no', 'none', 'field', 'choice1', 'choice2', 'agent', 'unclear'] },
    field: { type: 'STRING', enum: ['origin_address', 'origin_contact', 'destination_address', 'destination_contact', 'vehicle_number'] },
  },
  required: ['action'],
};

function buildPhaseReplyInstruction(phase, extra) {
  const common = `당신은 탁송 B2B 챗봇의 짧은 대화 응답 분석기입니다. 사용자의 한두 문장짜리 답변을 보고 의도를 분류하세요.
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
    return `${common}

방금 챗봇이 "어느 부분을 수정해드릴까요?"라고 물었습니다(선택 가능 항목: 출발지 주소=origin_address, 출발지 연락처=origin_contact, 도착지 주소=destination_address, 도착지 연락처=destination_contact, 차량번호=vehicle_number). 답변을 분류하세요:
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
  return generateJson(buildPhaseReplyInstruction(phase, extra), text, PHASE_REPLY_SCHEMA);
}

module.exports = { classifyAndExtract, classifyPhaseReply };
