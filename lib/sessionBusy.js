// "지금 이 세션에 끼어들면 안 되는가" 판정.
//
// 서버가 먼저 말을 거는 기능이 둘 있다(법인 공유 피드 lib/groupActivityFeed.js, 오더 능동 통보
// lib/kakaoOrderNotify.js). 둘 다 봇이 질문을 던져놓고 답을 기다리는 중에 메시지를 밀어넣으면
// 대화 흐름이 끊긴다 — 고객이 방금 받은 질문을 잃어버리고 엉뚱한 답을 한다.
//
// 판정 기준이 두 기능에서 갈리면 한쪽만 조용해지므로 여기 한 곳에 모았다. 다만 "그래서
// 어떻게 할지"는 각자 다르다: 공유 피드는 그냥 버리고(다음 이벤트에 다시 나간다), 능동 통보는
// 버리면 배차 사실을 영영 못 알리므로 미뤘다가 다시 시도한다.
//
// 판정 방식(사용자 확정): "시간"이 아니라 "대화 순서"로 본다.
//   진행 중 표시가 있고 + 마지막 메시지가 봇이면  → 답을 기다리는 중이다(미룬다)
//   마지막 메시지가 고객이면                      → 봇이 이미 답했거나 처리 중이다(안 미룬다)
//
// 예전에는 "마지막 고객 발화로부터 10분"이라는 시간 창을 썼는데, 고객이 한마디 하고 창을 닫아도
// 10분간 상태 통보가 막혔다. 시간으로 추측하는 대신 대화 순서를 직접 보면 그 추측이 사라진다.
//
// 진행 중 표시(mcp_pending_json 등)만 보면 안 되는 이유: 그 표시는 고객이 답하지 않으면 스스로
// 사라지지 않는다. 실제로 9시간 전 확인 대기가 남은 세션 때문에 배차 통보가 2분마다 계속
// 미뤄졌다(OID1237).

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

// 진행 중 표시가 붙어 있는가 — 채널을 모르는 호출부도 그냥 넘길 수 있게 둘 다 본다(웹 세션에는
// intake_slots_json이 비어 있고 카카오 세션에는 draft_json이 비어 있어 서로 간섭하지 않는다).
// 이것만으로는 "지금 답을 기다리는 중"인지 알 수 없다 — 대화 순서까지 봐야 한다.
function hasPendingMarker(session) {
  if (!session) return false;
  return isWebSessionBusy(session) || isKakaoSessionBusy(session);
}

// options.lastMessageSender를 주면 대화 순서까지 본다('user' | 'bot' | 'agent' | 'system' | null).
// 안 주면 표시만 보고 판단한다 — 법인 공유 피드처럼 한 번 건너뛰어도 그만인 곳은 그대로 둔다.
function isSessionBusy(session, options = {}) {
  if (!hasPendingMarker(session)) return false;
  if (!Object.prototype.hasOwnProperty.call(options, 'lastMessageSender')) return true;
  // 봇이 마지막으로 말했다 = 질문을 던져놓고 답을 기다리는 중. 그 외(고객이 마지막으로 말했거나,
  // 상담원/시스템 메시지가 마지막이거나, 아직 아무 말도 없음)는 끼어들 대화가 아니다.
  return options.lastMessageSender === 'bot';
}

module.exports = { isSessionBusy, hasPendingMarker, isWebSessionBusy, isKakaoSessionBusy };
