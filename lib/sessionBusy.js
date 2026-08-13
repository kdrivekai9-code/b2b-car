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

// 채널을 모르는 호출부(부분 조회 행 등)도 그냥 넘길 수 있도록 둘 다 본다 — 웹 세션에는
// intake_slots_json이 비어 있고 카카오 세션에는 draft_json이 비어 있어 서로 간섭하지 않는다.
function isSessionBusy(session) {
  if (!session) return false;
  return isWebSessionBusy(session) || isKakaoSessionBusy(session);
}

module.exports = { isSessionBusy, isWebSessionBusy, isKakaoSessionBusy };
