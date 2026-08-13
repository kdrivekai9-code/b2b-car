// "지금 이 세션에 끼어들면 안 되는가" 판정.
//
// 서버가 먼저 말을 거는 기능이 둘 있다(법인 공유 피드 lib/groupActivityFeed.js, 오더 능동 통보
// lib/kakaoOrderNotify.js). 둘 다 고객이 봇 질문에 답을 쓰는 중이거나 확인 대기 중일 때 메시지를
// 밀어넣으면 대화 흐름이 끊긴다 — 고객이 방금 받은 질문을 잃어버리고 엉뚱한 답을 한다.
//
// 판정 기준이 두 기능에서 갈리면 한쪽만 조용해지므로 여기 한 곳에 모았다. 다만 "그래서
// 어떻게 할지"는 각자 다르다: 공유 피드는 그냥 버리고(다음 이벤트에 다시 나간다), 능동 통보는
// 버리면 배차 사실을 영영 못 알리므로 미뤘다가 다시 시도한다.
//
// 부분 조회된 행도 받는다 — groupActivityFeed는 `SELECT id, draft_json`만 읽어온다.

function parseJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// 웹 접수 대화: 봇이 질문을 던지고 답을 기다리는 중(phase='collecting' + pendingField).
function isWebSessionBusy(session) {
  const draft = parseJson(session && session.draft_json);
  return !!(draft && draft.phase === 'collecting' && draft.pendingField);
}

// 카카오 상담: 접수 진행 중(intake_slots_json) 또는 배차 도우미 확인 대기(mcp_pending_json).
function isKakaoSessionBusy(session) {
  if (!session) return false;
  return !!(session.intake_slots_json || session.mcp_pending_json);
}

// 진행 중 표시가 남아 있어도 고객이 이만큼 말이 없으면 그 대화는 끝난 것으로 본다.
//
// 왜 필요한가: 확인 대기 표시(mcp_pending_json)나 접수 진행 표시(intake_slots_json)는 고객이
// 답하지 않으면 스스로 사라지지 않는다. 실제로 9시간 전 배차 도우미 확인 대기가 남은 세션
// 때문에 배차 통보가 2분마다 계속 미뤄졌다(OID1237). 떠난 대화를 "대화 중"으로 보면 정작
// 중요한 통보가 20분 늦게 나간다.
const BUSY_ACTIVITY_WINDOW_MINUTES = 10;

// 'YYYY-MM-DD HH24:MI:SS'(KST 문자열)와 Date/timestamp를 모두 받는다 — 이 저장소는 두 형태가
// 섞여 있다(chat_messages.created_at은 KST 문자열).
function toMillis(value) {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  const s = String(value).trim();
  if (!s) return null;
  // KST 문자열에는 시간대가 없어 그대로 파싱하면 실행 환경 시간대로 읽힌다 — +09:00을 붙인다.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  const parsed = m ? Date.parse(`${s.replace(' ', 'T')}+09:00`) : Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

// 채널을 모르는 호출부(부분 조회 행 등)도 그냥 넘길 수 있도록 둘 다 본다 — 웹 세션에는
// intake_slots_json이 비어 있고 카카오 세션에는 draft_json이 비어 있어 서로 간섭하지 않는다.
//
// options.lastCustomerMessageAt를 주면 "고객이 최근에 말을 걸었는지"까지 본다. 주지 않으면
// 예전처럼 표시만 보고 판단한다(법인 공유 피드처럼 한 번 건너뛰어도 그만인 곳은 그대로 둔다).
function isSessionBusy(session, options = {}) {
  if (!session) return false;
  if (!(isWebSessionBusy(session) || isKakaoSessionBusy(session))) return false;

  if (!Object.prototype.hasOwnProperty.call(options, 'lastCustomerMessageAt')) return true;
  const lastAt = toMillis(options.lastCustomerMessageAt);
  if (lastAt === null) return false; // 고객 발화가 아예 없으면 기다릴 대화도 없다
  const windowMs = (options.windowMinutes || BUSY_ACTIVITY_WINDOW_MINUTES) * 60 * 1000;
  return (options.nowMs || Date.now()) - lastAt < windowMs;
}

module.exports = {
  isSessionBusy,
  isWebSessionBusy,
  isKakaoSessionBusy,
  toMillis,
  BUSY_ACTIVITY_WINDOW_MINUTES,
};
