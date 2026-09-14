// 되묻는 질문에 온 답을 pendingField로 읽는다. **모델을 부르지 않는다.**
//
// 왜 필요한가(실사용, 2026-09-13 확인): 챗봇이 "출발지 주소를 알려주세요?"라고 묻고 고객이
// 주소 한 줄만 답하면 그 답이 통째로 버려지고 같은 질문이 반복되다, 3턴이면 "상담원 연결을
// 해드릴까요?"로 밀렸다. 같은 대화를 :3000(EJS)과 :3001(Next)에서 나란히 돌려 확인했다 —
// **양 채널 동일**하다. 둘 다 POST /orders/ai-intake/parse 하나를 쓰기 때문이다.
//
// 원인은 폴백 경로다. 그 엔드포인트는 Gemini로 의도·필드를 뽑고, 그 호출이 실패하면 규칙
// 파서(lib/aiIntakeParser.js parseIntakeText)로 내려간다. 그런데 그 파서는 **pendingField를
// 인자로 받지도 않는다**(인자가 text 하나다). "출발지 주소 : …"처럼 라벨이 붙은 접수 폼을
// 읽도록 만든 것이라 맨 주소 한 줄에서는 아무것도 못 뽑는다 — 실측:
//
//     parseIntakeText('경기 성남시 분당구 판교역로 166')  → (아무것도 못 뽑음)
//     parseIntakeText('010-1111-2222')                → (아무것도 못 뽑음)
//
// 모델이 붙어 있어도 가끔 빈손으로 온다(같은 입력을 반복하면 결과가 갈린다). 어느 쪽이든
// 고객 눈에는 "답했는데 또 묻는다"로 똑같이 보인다.
//
// pendingField는 우리가 가진 **가장 강한 신호**다 — 방금 무엇을 물었는지 우리가 안다. 그러니
// 답이 무슨 값인지 모델에게 다시 물을 이유가 없다. 같은 판단을 하는 자리가 이미 있다
// (routes/orders.js: 예약시간을 되물었는데 "없다"는 취지의 짧은 답은 Gemini보다 먼저 처리한다).
//
// **덮어쓰지 않는다.** 모델이 값을 제대로 뽑았으면 그대로 두고, 비어 있을 때만 채운다.
//
// 예약일시는 다루지 않는다 — 날짜·시간 해석은 이미 파서가 있고(lib/kakaoIntakeParser.js),
// 여기서 흉내 내면 두 벌이 되어 "내일 오후 3시"가 화면마다 달라진다.
//
// DB에 닿지 않는다.
const { normalizePhone, normalizePlate } = require('./kakaoIntakeParser');

// 답이 아니라 **다른 뜻**인 것들. 이걸 값으로 받으면 "상담원"이 출발지 주소가 된다.
const NOT_AN_ANSWER_RE = /상담원|상담사|취소|그만|처음부터|다시\s*시작/;
// 질문은 답이 아니다("요금이 얼마예요?"를 주소로 넣으면 안 된다).
const QUESTION_RE = /\?|요금|얼마|가격|비용|견적|가능한가|되나요|될까요/;
// 확인 단계 답변(네/아니오/수정)은 이 경로로 오면 안 되지만, 와도 값으로 삼지 않는다.
const YES_NO_RE = /^(네|넵|예|응|어|아니|아니오|아니요|아뇨|노|수정|변경)[.!]?$/;
// 라벨이 붙은 접수 본문이 통째로 다시 오면 그건 새 접수다 — 기존 파서가 읽어야 한다.
// 실사용 표기는 "[출발지]"(대괄호)와 "출발 :"(콜론) 둘 다 쓰인다 — 처음에 콜론만 봤다가
// 대괄호 형식을 통째로 출발지 주소로 삼을 뻔했다(단위 시험에서 잡혔다).
// 여러 줄인 것도 함께 본다 — 한 줄짜리 답에 "도착지 앞"처럼 낱말이 섞였다고 새 접수로
// 오해하면, 정작 답한 주소가 버려진다.
const ORDER_FORM_LABEL_RE = /(출발지?|도착지?|경유지?\d*)\s*[:：\]】]/;
function looksLikeOrderForm(text) {
  return /\n/.test(text) && ORDER_FORM_LABEL_RE.test(text);
}

// 전화번호로 읽을 수 있는가. 문장 안에 섞여 있어도 뽑는다("도착지는 010-1234-5678이요").
const PHONE_RE = /(0\d{1,2})[-.\s]?(\d{3,4})[-.\s]?(\d{4})/;
// 차량번호 — "12가3456", "서울12가3456", 앞뒤 공백 허용.
const PLATE_RE = /(\d{2,3}\s*[가-힣]\s*\d{4})/;
// 주소로 볼 만한 신호. 없으면 두 어절 이상인지로 한 번 더 본다("판교역 1번출구").
const ADDRESS_HINT_RE = /(시|도|군|구|읍|면|동|리|로|길|가|번지|역|터미널|공항|지점|점|센터|빌딩|타워|아파트|휴게소|IC|톨게이트)(\s|$|\d)/;

function looksLikeAnswer(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.length > 200) return false; // 긴 글은 되묻기 답이 아니라 새 접수/문의다
  if (NOT_AN_ANSWER_RE.test(t)) return false;
  if (YES_NO_RE.test(t)) return false;
  if (looksLikeOrderForm(t)) return false;
  return true;
}

// 질문 형태는 값으로 쓰지 않는다. 다만 전화번호·차량번호처럼 형태가 확실한 값은
// 문장에 물음표가 섞여 있어도(오타 등) 뽑아도 안전하다 — 그래서 그 둘은 이 검사를 건너뛴다.
function isQuestion(text) {
  return QUESTION_RE.test(String(text || ''));
}

function readPendingFieldAnswer(pendingField, text) {
  const field = String(pendingField || '');
  const raw = String(text || '').trim();
  if (!field || !looksLikeAnswer(raw)) return null;

  if (field === 'origin_contact' || field === 'destination_contact' || field === 'premium_origin_contact') {
    const m = PHONE_RE.exec(raw);
    if (!m) return null;
    return { field: field.replace(/^premium_/, ''), value: normalizePhone(m[0]) };
  }

  if (field === 'vehicle_number') {
    const m = PLATE_RE.exec(raw);
    if (!m) return null;
    // **origin_vehicle_number**다 — 이 엔드포인트의 응답 계약이 그 이름을 쓴다
    // (normalizeGeminiOrderFields). vehicle_number에 넣으면 EJS 챗봇이 되묻기가 채워졌는지
    // 보는 자리에서 못 읽는다(public/js/ai-intake.js: field.id === 'vehicle_number'일 때
    // data.origin_vehicle_number **만** 본다) — 값은 실려 갔는데 같은 질문이 또 나간다.
    return { field: 'origin_vehicle_number', value: normalizePlate(m[1]) };
  }

  if (field === 'vehicle_type') {
    if (isQuestion(raw) || raw.length > 20 || /^\d+$/.test(raw)) return null;
    return { field: 'vehicle_type', value: raw };
  }

  // 경유지(premium_waypoint_address)는 일부러 뺐다 — 응답 계약에서 경유지는 waypoints 배열이라
  // 평평한 칸 하나로 넣을 자리가 없고, 프리미엄 대화는 서버 턴 엔진이 자체 파서로 맡는다
  // (lib/webIntakeTurn.js). 여기서 흉내 내면 경유지 해석이 두 벌이 된다.
  if (field === 'origin_address' || field === 'destination_address'
    || field === 'premium_origin_address' || field === 'premium_destination_address') {
    if (isQuestion(raw) || raw.length < 2) return null;
    // 주소 신호가 있거나, 최소한 두 어절이어야 한다. "네"나 "몰라요"를 주소로 넣지 않기 위한 벽이다.
    if (!ADDRESS_HINT_RE.test(raw) && raw.split(/\s+/).length < 2) return null;
    return { field: field.replace(/^premium_/, ''), value: raw };
  }

  if (field === 'memo_customer' || field === 'memo_billing') {
    if (raw.length > 200) return null;
    return { field, value: raw };
  }

  // 예약일시(reserved_date 등)는 일부러 다루지 않는다 — 위 주석 참고.
  return null;
}

module.exports = { readPendingFieldAnswer, looksLikeAnswer };
