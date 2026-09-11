// 예약 기준(즉시 / 픽업 기준 / 도착 기준)을 문장에서 읽는다.
//
// 왜 lib으로 뺐나(실사용 지적 2026-09-11): 고객이 "일시 : 07/27 즉시"로 접수하면 챗봇은
// "즉시로 예약을 확인했습니다"라고 답하는데, **Next 판 우측 접수창의 라디오는 픽업 기준에
// 그대로 있었다.** 서버는 이미 reservation_immediate를 내려주고 있었고 EJS 챗봇
// (public/js/ai-intake.js applyImmediateReservationBasis)은 그걸 받아 라디오를 켰는데,
// Next 판은 그 값을 버렸다 — 폼에 넘기는 항목 목록(ORDER_FIELD_IDS)에 없었다.
//
// 판별 규칙 자체는 EJS 쪽에만 있었다. 같은 판단을 두 벌 쓰면 채널마다 답이 갈린다 —
// 이 저장소가 이미 겪은 실수다(요금 계산을 한 곳으로 모은 lib/agentAssist.js 경위 참고).
// 그래서 규칙을 여기로 옮기고 서버가 계산해 내려준다.
//
// EJS 쪽 사본은 지금 동작하는 경로라 건드리지 않았다. 대신 두 정규식이 갈라지면
// scripts/check-reservation-basis.js가 잡는다.
//
// **DB에 닿지 않는다** — Next 페이지가 import해도 안전해야 한다
// (scripts/check-next-page-imports.js의 규칙).

// "도착지"(주소 라벨)는 "도착"을 포함하지만 시간 기준과 무관하다 — 뒤에 "지"가 바로 붙는
// 경우만 라벨로 보고 제외한다("~시 도착"/"도착 예정"처럼 "지"가 안 붙는 진짜 시간 표현은 잡는다).
const DELIVERY_TIME_HINT_RE = /(도착요망|인도|도착(?!지))/;

function detectReservationBasisFromText(text) {
  const raw = String(text || '');
  // 전체 텍스트에는 "[출발지]" 같은 무관한 섹션 헤더가 항상 있어 "출발"이 늘 매칭되므로,
  // 그걸로 판단하면 "일시 : 07/27 18시 30분 도착"처럼 실제로는 도착지 인도시간 기준인
  // 경우까지 항상 픽업 기준으로 오판된다. "일시" 라인만 좁혀서 그 안의 표현으로 판단한다.
  const timeLineMatch = raw.match(/일시[^\n]*/);
  if (timeLineMatch) {
    const line = timeLineMatch[0];
    if (DELIVERY_TIME_HINT_RE.test(line)) return 'delivery';
    if (/픽업/.test(line)) return 'pickup';
    return null;
  }
  // "일시" 라인이 없는 자유 문장(AI 챗봇의 실사용 패턴 대부분이 이 경우다)도 같은 함정이
  // 있다 — "출발지는 판교역이고 내일 오후 3시까지 도착요망"처럼 도착시간 기준을 말해도
  // 문장 어딘가에 "출발지"(주소 라벨일 뿐 시간 표현이 아님)가 거의 항상 같이 나와서, 위와
  // 똑같이 "출발" 매칭에 걸려 픽업 기준으로 오판된다. "픽업"은 시간 표현으로만 쓰이는
  // 특이적인 단어라 그대로 두되, "출발"은 이 넓은 매칭에서 뺀다 — 못 잡아도 라디오는 기본값
  // (픽업 기준)에 그대로 머물 뿐이라 안전하고, 잘못 잡아 도착 기준을 뭉개는 쪽이 더 나쁘다.
  // "도착지"(목적지 주소 라벨) 역시 거의 모든 메시지에 등장하므로 DELIVERY_TIME_HINT_RE가
  // "지"가 바로 붙은 "도착"은 라벨로 보고 걸러낸다.
  const hasPickup = /픽업/.test(raw);
  const hasDelivery = DELIVERY_TIME_HINT_RE.test(raw);
  if (hasDelivery) return 'delivery';
  if (hasPickup) return 'pickup';
  return null;
}

// 폼이 받는 값으로 정리한다. 즉시가 가장 세다 — "즉시"라고 적었으면 픽업/도착 기준을
// 따질 것이 없다(즉시는 출발지 픽업을 지금 한다는 뜻이고, 폼이 날짜·시각을 잠근다).
function resolveReservationBasis({ immediate, text }) {
  if (immediate) return 'immediate';
  return detectReservationBasisFromText(text);
}

module.exports = { detectReservationBasisFromText, resolveReservationBasis, DELIVERY_TIME_HINT_RE };
