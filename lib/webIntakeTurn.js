// 웹 AI 챗봇(로그인 사용자)의 탁송 접수 대화 — 판단을 서버로 옮긴 첫 조각(Stage A).
//
// 왜 서버로 옮겼나: 지금까지는 같은 판단(다음 질문 결정, 요금/운영시간 응답, 확인 요약)을
// 브라우저(public/js/ai-intake.js, 4천줄대)와 카카오 상담톡(routes/kakaoConsult.js)이 각자
// 구현하고 있었다. 이번 세션에 카카오 쪽 요금 문의 처리를 두 번(상담원 초안 경로, 봇 응대
// 경로) 따로 붙여야 했던 것도 같은 이유다 — 판단이 한 곳에 없으면 채널마다 버그가 따로 나고
// 따로 고쳐야 한다. `lib/intakeFields.js` 상단 주석이 이미 이 문제를 짚어두고 "접수 대화
// 전체를 옮기는 건 별개의 큰 작업"이라고 미뤄뒀는데, 이 모듈이 그 첫 조각이다.
//
// 범위: 탁송(dispatch_order)의 수집→확인 루프만. 주소 후보 확정은 브라우저 Kakao Maps
// SDK를 그대로 쓴다(카카오 채널은 서버 REST API 방식이라 근본적으로 다르다 — 통합은 별개
// 작업). 프리미엄/일일기사, choose_field(필드 직접 지정 수정), offer_agent(상담원 제안)는
// 이번 범위 밖 — 지금처럼 브라우저가 처리한다.
//
// 재사용: 파싱·되묻기 문구·요금/운영시간 응답·등록 실행은 전부 카카오 채널에서 이미
// 실사용 검증된 함수를 그대로 쓴다(lib/kakaoIntakeParser.js, lib/agentAssist.js,
// lib/kakaoIntakeService.js) — 새로 만든 판단 로직은 "확인 대기" 단계 하나뿐이다(아래 참고).
const db = require('../db');
const { classifyAndExtract } = require('./hybridChat');
const { isGreeting, getSmalltalkMessage } = require('./smallTalk');
const { parseKakaoIntake, buildParsedFromClassified, buildMissingQuestion } = require('./kakaoIntakeParser');
const { buildFareSuggestion, buildHoursSuggestion, buildIntakeReply } = require('./agentAssist');
const { createOrdersFromIntake } = require('./kakaoIntakeService');

const INTAKE_SLOT_TTL_MINUTES = 30;

// 등록 실패 사유 → 사용자에게 그대로 보여줄 문구. 카카오(routes/kakaoConsult.js)는 외부
// 고객이라 사유를 숨기고 상담원에게 넘기지만, 웹은 로그인한 사내 직원이라 사유를 그대로
// 알려주는 편이 낫다 — 본인이 입력을 고칠 수 있고, 필요하면 수동 등록 화면(/orders/new)으로
// 바로 갈 수 있다.
const FAILURE_MESSAGES = {
  origin_geocode_failed: '출발지 주소를 확인할 수 없습니다. 더 정확한 주소로 다시 입력해주세요.',
  operating_hours: '요청하신 시간은 지사 운영시간 밖입니다. 시간을 다시 확인해주세요.',
  waypoint_unsupported: '경유지가 포함된 접수는 AI 챗봇으로 등록할 수 없습니다. 오더 등록 화면에서 직접 접수해주세요.',
  exception: '접수 처리 중 오류가 발생했습니다. 오더 등록 화면에서 직접 접수해주세요.',
};

async function loadPendingIntake(session) {
  if (!session.intake_slots_json) return null;
  try {
    const saved = JSON.parse(session.intake_slots_json);
    if (!saved || !saved.savedAt || !saved.raw) return null;
    if (Date.now() - saved.savedAt > INTAKE_SLOT_TTL_MINUTES * 60000) return null;
    return saved;
  } catch (e) {
    return null;
  }
}

async function savePendingIntake(session, raw, missing, extra) {
  await db.run(
    `UPDATE chat_sessions SET intake_slots_json = ?,
     intake_updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [JSON.stringify({ raw, missing: missing || [], savedAt: Date.now(), ...(extra || {}) }), session.id]
  );
}

async function clearPendingIntake(session) {
  await db.run('UPDATE chat_sessions SET intake_slots_json = NULL WHERE id = ?', [session.id]);
}

// 로그인 사용자를 카카오의 "채널 매핑 계정"과 같은 모양으로 만든다 — createOrdersFromIntake는
// 이 다섯 필드만 본다(auto_register/branch_id/requester_group_id/payment_method_id/user_id).
// 결제수단을 지정하지 않는 건 카카오의 "지정 안 함" 매핑과 같은 취급이다(insertOrder가 이미
// null을 받아들인다) — 결제수단 선택은 이번 범위 밖, 등록 후 오더 상세에서 바꿀 수 있다.
function accountFromUser(user) {
  return {
    user_id: user.id,
    branch_id: user.branch_id,
    requester_group_id: user.group_id || null,
    payment_method_id: null,
    auto_register: true,
  };
}

// 한 턴 처리. text는 이번에 사용자가 보낸 원문(병합 전).
async function runWebIntakeTurn({ user, session, text }) {
  const raw = String(text || '').trim();
  if (!raw) return { replyText: '', ok: true };

  const pending = await loadPendingIntake(session);

  // 확인 대기 중이었다면("네" 또는 "아니오/수정") 먼저 그 답으로 해석한다 — 이 판단은
  // 카카오에는 없다(카카오는 auto_register 계정이면 확인 없이 바로 등록한다). 로그인
  // 사용자가 잘못 채워진 채로 등록시키지 않게, 웹에서만 추가한 확인 관문이다.
  if (pending && pending.awaiting === 'confirm') {
    if (isAffirmative(raw)) {
      return submitPendingOrder({ user, session, pending });
    }
    if (isNegative(raw)) {
      await clearPendingIntake(session);
      return { replyText: '접수를 취소했습니다. 다시 접수하시려면 내용을 입력해주세요.', ok: true, closeSession: false };
    }
    // 그 외 답변은 "수정"으로 보고, 이번 발화를 원문에 이어붙여 다시 파싱한다(아래 공통 경로).
  }

  // 스몰토크/인사는 접수 판단으로 넘기지 않는다(웹 /orders/ai-intake/parse와 동일 규칙).
  const smalltalk = getSmalltalkMessage(raw);
  if (smalltalk) return { replyText: smalltalk, ok: true };
  if (isGreeting(raw)) {
    return { replyText: '안녕하세요. 오더 접수 내용을 입력하시거나, 궁금한 점을 질문해주세요.', ok: true };
  }

  // 되묻기 중이었으면 원문에 이어붙인다(카카오와 같은 병합 방식) — "그리고 차량은 12가1234요"
  // 처럼 보충 답변만 와도 앞서 받은 출발지·도착지가 사라지지 않는다.
  const mergedRaw = (pending && pending.raw) ? `${pending.raw}\n${raw}` : raw;

  let parsed = parseKakaoIntake(mergedRaw);
  let classified = null;
  if (!parsed.matched) {
    try {
      classified = await classifyAndExtract(mergedRaw, null, null);
    } catch (e) {
      console.error('웹 AI 접수 의도 분류 실패:', e.message);
      return { replyText: '요청을 이해하지 못했습니다. 접수 내용을 다시 말씀해주세요.', ok: false };
    }

    if (classified.intent === 'faq') {
      const fare = await buildFareSuggestion(raw, { branchId: user.branch_id, extracted: classified }).catch(() => null);
      if (fare) return { replyText: fare.text, ok: true };
      const hours = await buildHoursSuggestion(raw, { branchId: user.branch_id }).catch(() => null);
      if (hours) return { replyText: hours.text, ok: true };
      // 그 외 지식검색 FAQ는 기존 /orders/ai-intake/parse 경로가 이미 처리한다 — 이 턴 엔진은
      // "접수 대화 중" 판단만 맡고, 지식검색 매칭까지 흡수하지 않는다(범위를 좁게 유지).
      return { replyText: null, ok: true, fallthrough: true };
    }
    if (classified.intent !== 'dispatch_order') {
      // proxy_order/daily_driver_order/unsupported — 이번 범위 밖. 클라이언트가 기존
      // 경로(프리미엄/일일기사 처리, 상담원 제안)로 이어가게 그대로 넘긴다.
      return { replyText: null, ok: true, fallthrough: true };
    }
    parsed = buildParsedFromClassified(classified, mergedRaw);
  }

  if (!parsed.complete) {
    await savePendingIntake(session, mergedRaw, parsed.missing);
    return { replyText: buildMissingQuestion(parsed.missing, parsed), ok: true, awaitingConfirmation: false };
  }

  // 다 채워졌다 — 바로 등록하지 않고 요약을 보여주고 확인을 받는다(웹만의 관문).
  await savePendingIntake(session, mergedRaw, [], { awaiting: 'confirm', parsed });
  return {
    replyText: `${buildIntakeReply(parsed)}\n\n맞으면 "네", 다시 입력하시려면 내용을 고쳐서 다시 보내주세요.`,
    ok: true,
    awaitingConfirmation: true,
  };
}

async function submitPendingOrder({ user, session, pending }) {
  // parsed는 확인 단계에서 이미 완성해 저장해둔 값을 그대로 쓴다 — "네" 한 마디에서 다시
  // 파싱할 원문이 없다.
  const parsed = pending.parsed;
  await clearPendingIntake(session);
  if (!parsed) {
    return { replyText: '접수 내용을 다시 확인할 수 없습니다. 처음부터 다시 입력해주세요.', ok: false };
  }

  const account = accountFromUser(user);
  let result;
  try {
    result = await createOrdersFromIntake({ session, account, parsed, sourceChannel: 'web' });
  } catch (e) {
    console.error('웹 AI 접수 등록 실패:', e.message);
    result = { ok: false, reason: 'exception' };
  }

  if (!result.ok) {
    const message = FAILURE_MESSAGES[result.reason] || '접수를 완료할 수 없습니다. 오더 등록 화면에서 직접 접수해주세요.';
    return { replyText: message, ok: false };
  }

  return { replyText: result.message, ok: true, closeSession: true };
}

// "그대로 접수해주세요", "네네" 처럼 다양하게 오는 확인 답변을 넓게 인정한다 —
// public/js/ai-intake.js의 isAffirmative와 같은 취지(문자 그대로 공유하지는 않는다,
// 서버·클라이언트가 서로 require할 수 없는 다른 런타임이라 판단만 같게 유지한다).
function isAffirmative(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return /^(네|넵|예|응|어|그래|그럼|좋아|좋습니다|괜찮|오케이|콜|ok|okay|yes|y)([\s,.!~]|$)/i.test(s)
    || /(그대로\s*(진행|해)|그렇게\s*(해|진행|부탁)|접수\s*(해|할|하)|맞습니다|맞아요|부탁\s*(해|드립|합니다|드려))/.test(s);
}

function isNegative(text) {
  const s = String(text || '').trim();
  return /^(아니|아뇨|노|no|안\s?돼|안\s?할래|취소)/i.test(s);
}

module.exports = { runWebIntakeTurn };
