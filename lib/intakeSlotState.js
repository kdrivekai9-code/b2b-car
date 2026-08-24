// 되묻기 대기 상태(chat_sessions.intake_slots_json) 읽기/쓰기 — 웹 AI 접수(lib/webIntakeTurn.js)와
// 카카오 상담톡(routes/kakaoConsult.js)이 각자 같은 코드를 복사해 갖고 있던 것을 하나로 합쳤다.
// 두 벌로 나뉘어 있으면 한쪽만 고쳐진다 — 실제로 "되묻기 만료 시 명시 안내"를 카카오에만
// 먼저 넣었다가, 웹에도 같은 문제가 있다는 걸 뒤늦게 알았다.
//
// 저장 형태는 항상 자유 형식 객체 + savedAt이다. raw/missing은 접수 되묻기가 쓰는 필드,
// awaiting/category/orderType/tripType/declined/candidates 등은 호출부가 필요한 만큼 얹는다
// (카카오의 기존 savePendingAddressChoice와 웹의 extra 파라미터가 이미 같은 방식이었다).
const db = require('../db');

const DEFAULT_TTL_MINUTES = 30;

function isExpired(saved, ttlMinutes) {
  return Date.now() - saved.savedAt > (ttlMinutes || DEFAULT_TTL_MINUTES) * 60000;
}

function parseState(session) {
  if (!session.intake_slots_json) return null;
  try {
    const saved = JSON.parse(session.intake_slots_json);
    if (!saved || !saved.savedAt) return null;
    // raw가 없어도 유효한 상태가 있다 — 상담원 연결 대기(purpose:'agent')는 raw 없이 저장된다.
    if (!saved.raw && saved.purpose !== 'agent') return null;
    return saved;
  } catch (e) {
    return null;
  }
}

// 유효한(만료 전) 되묻기 상태. 없거나 만료됐으면 null.
function loadPendingIntake(session, ttlMinutes) {
  const saved = parseState(session);
  if (!saved) return null;
  if (isExpired(saved, ttlMinutes)) return null;
  return saved;
}

// "진행 중인 되묻기가 없다"와 "있었는데 시간이 지나 사라졌다"는 고객 입장에서 다르다. 후자를
// 조용히 넘기면, 맥락 없이 짧게 이어 보낸 답이 새 메시지로 재분류되는 사고로 이어진다(카카오
// 실측: 도착지 질문 78분 뒤 "판교역"만 보냈더니 대리운전 요청으로 오분류됨). 호출부가 이걸로
// 만료 사실을 알리고 처음부터 다시 받는다.
function wasPendingIntakeExpired(session, ttlMinutes) {
  const saved = parseState(session);
  if (!saved) return false;
  return isExpired(saved, ttlMinutes);
}

// 임의의 상태 객체를 저장한다(savedAt은 항상 지금 시각으로 새로 찍는다 — 매 턴 만료 시계가
// 리셋된다). raw/missing 방식(savePendingIntake)과 상태 객체 방식(주소 후보·확인 대기 등)을
// 이 함수 하나로 통일한다. 저장 실패는 던지지 않는다 — 이 상태는 다음 턴을 매끄럽게 이어가기
// 위한 캐시성 데이터라, 여기서 예외가 나서 이미 고객에게 보낸 질문 응답 처리 전체가 실패로
// 번지면 안 된다(카카오 쪽 기존 방침 — 웹도 같은 이유로 이 방침을 따른다).
async function savePendingState(session, state) {
  await db.run(
    `UPDATE chat_sessions SET intake_slots_json = ?,
     intake_updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [JSON.stringify({ ...state, savedAt: Date.now() }), session.id]
  ).catch((e) => console.error('되묻기 상태 저장 실패:', e.message));
}

// 되묻기 상태(raw + missing + 부가정보) 저장 — 가장 흔한 저장 형태라 얇은 래퍼로 남긴다.
async function savePendingIntake(session, raw, missing, extra) {
  return savePendingState(session, { raw, missing: missing || [], ...(extra || {}) });
}

async function clearPendingIntake(session) {
  await db.run('UPDATE chat_sessions SET intake_slots_json = NULL WHERE id = ?', [session.id])
    .catch((e) => console.error('되묻기 상태 정리 실패:', e.message));
}

// 만료를 조용히 넘기지 않고 알리는 문구 — 웹/카카오 공통(카테고리를 가리지 않는 일반 표현).
const INTAKE_EXPIRED_NOTICE = '이전에 진행하시던 접수 내용이 시간이 많이 지나 초기화되었습니다. '
  + '번거로우시겠지만 출발지·도착지·차량번호·일시를 다시 한 번에 알려주시겠어요?\n'
  + '(예: 서울 강남구 OO빌딩 → 인천 중구 OO공항, 그랜저 12가3456, 내일 오후 2시)';

// "A에서 B로/까지" 또는 화살표 — 출발지와 도착지가 한 문장에 다 있다는 신호다.
const ROUTE_SHAPE_RE = /(에서\s*\S+\s*(까지|으로|로)\b|에서\s*\S+\s*(까지|으로|로)|→)/;
// 무엇을 해달라는 것인지가 문장 안에 있다는 신호.
const REQUEST_VERB_RE = /(탁송|배차|대리운전|일일기사|픽업|접수|예약|보내주|가져다|옮겨|이동)/;
// 언제인지가 문장 안에 있다는 신호.
const WHEN_HINT_RE = /(오늘|내일|모레|즉시|지금|당장|\d{1,2}\s*시|\d{1,2}\s*:\s*\d{2}|\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}\/\d{1,2}|[월화수목금토일]요일)/;

// 이 메시지가 앞 대화 없이도 그 자체로 성립하는 요청인가.
//
// 만료 안내(INTAKE_EXPIRED_NOTICE)는 "판교역"처럼 **앞 질문에 대한 답으로만 뜻이 통하는
// 조각**을 위한 것이다. 그런 조각이 맥락을 잃고 새 메시지로 재분류되면 엉뚱한 안내가 나가므로
// (실측: 도착지를 물어본 지 78분 뒤 "판교역"만 보냈더니 대리운전 요청으로 오분류됐다),
// 끊겼다고 알려 처음부터 받는 편이 낫다.
//
// 그런데 만료 뒤 첫 메시지가 조각이 아니라 완결된 새 요청일 수도 있다. 실사용 사고:
// "내일오후3시에 사당역탐앤탐스에서 강남역5번출구로 탁송예약" — 출발·도착·일시가 다 들어 있는
// 새 접수인데 만료 안내가 나가면서 그 턴이 통째로 삼켜졌다(요청은 아무 처리도 되지 않았다).
//
// 그래서 판정은 한쪽으로 기울여 둔다. 완결된 요청을 조각으로 잘못 보면 요청이 삼켜지지만,
// 조각을 완결로 잘못 보면 만료 안내 없이 예전 동작(재분류)으로 돌아가는 것뿐이다 — 뒤쪽이
// 훨씬 싸다. 그래서 "완결" 신호가 하나라도 뚜렷하면 완결로 본다.
function looksSelfContained(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  // 경로가 한 문장에 다 있으면 조각일 수 없다.
  if (ROUTE_SHAPE_RE.test(s)) return true;
  // 요청 동사만으로는 "예약이요" 같은 되받기도 걸린다 — 시간이 함께 있거나 문장이 길 때만 본다.
  if (REQUEST_VERB_RE.test(s) && (WHEN_HINT_RE.test(s) || s.length >= 15)) return true;
  return false;
}

module.exports = {
  DEFAULT_TTL_MINUTES,
  INTAKE_EXPIRED_NOTICE,
  looksSelfContained,
  loadPendingIntake,
  wasPendingIntakeExpired,
  savePendingState,
  savePendingIntake,
  clearPendingIntake,
};
