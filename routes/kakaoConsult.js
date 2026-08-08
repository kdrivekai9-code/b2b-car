// 카카오 상담톡 수신 웹훅 — ConsulTalk 중계서버가 호출한다("카카오 상담톡 연동 계획서" 5.2 참고).
// 로그인 세션이 없는 서버 대 서버 호출이라 requireAuth를 쓰지 않고 공유 시크릿으로 검증한다
// (routes/callmanerSync.js의 CRON_SECRET 패턴과 동일한 사고방식).
//
// ⚠ 8.1(계획서)이 아직 미확인이다 — 중계서버가 "카카오→중계서버"로 받은 걸 우리 쪽으로 어떻게
// 넘겨줄지(고정 웹훅 URL, 헤더/바디 실제 포맷, 인증 방식)가 공개 API 문서에 없다. 이 라우트는
// callmaner 쪽에서 실제 웹훅 설정을 확인해주기 전까지는 실제 트래픽을 받을 수 없다 — 아래
// checkWebhookAuth와 lib/kakaoConsult.js의 extractKeys/extractPlainText가 그 확인 결과에 맞춰
// 조정해야 할 지점이다.
const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const kakaoConsult = require('../lib/kakaoConsult');
const { classifyAndExtract } = require('../lib/hybridChat');
const { searchKnowledgeBase } = require('../lib/knowledgeSearch');
const { parseKakaoIntake, buildMissingQuestion, normalizePhone, normalizePlate } = require('../lib/kakaoIntakeParser');
const { findIntakeAccount, resolveIntakeContext, findAccountByPhone, linkUserKeyToAccount, createOrdersFromIntake } = require('../lib/kakaoIntakeService');
const { getSmalltalkMessage } = require('../lib/smallTalk');
const { buildSuggestion } = require('../lib/agentAssist');
const { runDispatchAgent } = require('../lib/mcpDispatchAgent');
const { notify } = require('../lib/push');
const { broadcastMessage, broadcastSessionListChanged } = require('../lib/realtimeChat');
const { logIntegrationErrorAsync } = require('../lib/integrationLog');

const router = express.Router();

// 계획서 8.4: "seen_info 미구현으로 404를 반환해 카카오 측 재시도를 유발했음" — 어떤 이벤트든
// 200을 먼저 돌려주고 무거운 처리(Gemini 분류·지식검색·카카오 발신)는 응답 뒤로 미룬다.
// Vercel 서버리스는 응답을 보낸 뒤 인스턴스를 얼려버릴 수 있어서, 그냥 fire-and-forget으로 두면
// 봇 답장이 조용히 유실된다 — waitUntil로 "이 작업이 끝날 때까지 살려두라"고 알려줘야 한다.
let vercelWaitUntil = null;
try { ({ waitUntil: vercelWaitUntil } = require('@vercel/functions')); } catch (e) { /* 로컬 실행 등 */ }

function runAfterResponse(promise, label) {
  const guarded = Promise.resolve(promise).catch((e) => console.error(`카카오 상담톡 후처리 실패(${label}):`, e.message));
  if (vercelWaitUntil) {
    try { vercelWaitUntil(guarded); } catch (e) { /* 로컬에서는 무시 — 프로세스가 계속 살아 있다 */ }
  }
  return guarded;
}

// 응답이 늦어지면 중계서버/카카오가 같은 이벤트를 재전송할 수 있다. 그대로 두면 같은 고객
// 메시지에 봇이 두 번 답한다 — 최근에 같은 내용을 이미 받았으면 저장/응답만 하고 봇 처리는 건너뛴다.
const DUPLICATE_WINDOW_SECONDS = 60;

// 카카오는 메시지마다 고유 일련번호(meta.serialNumber)를 준다 — 재전송이면 이 값이 같다.
// 이게 있으면 정확히 판정할 수 있어 텍스트 비교를 쓰지 않는다.
async function isResentEvent(serialNumber) {
  if (!serialNumber) return false;
  try {
    const row = await db.get(
      `SELECT id FROM kakao_consult_events
       WHERE event_type = 'message' AND handled = true AND payload_json LIKE ?
       LIMIT 1`,
      ['%"serialNumber":"' + String(serialNumber) + '"%']
    );
    return !!row;
  } catch (e) {
    console.error('카카오 상담톡 재전송 확인 실패(중복 아님으로 진행):', e.message);
    return false;
  }
}

// 일련번호가 없는 형식일 때의 차선책 — 같은 고객이 같은 문구를 짧은 시간에 다시 보낸 경우다.
// ⚠ 이건 재전송이라는 증거가 아니다. 고객이 "네", "확인부탁드립니다"를 연달아 두 번 치는 일은
// 흔하다(로그상 단순 응대가 접수 외 메시지의 13.6%). 그래서 이 판정으로는 **메시지를 버리지
// 않는다** — 저장과 상담원 노출은 그대로 하고 봇의 중복 응답만 막는다.
async function looksRepeated(userKey, text) {
  try {
    const row = await db.get(
      `SELECT id FROM kakao_consult_events
       WHERE event_type = 'message' AND user_key = ? AND handled = true
         AND payload_json LIKE ?
         AND created_at >= to_char((now() at time zone 'Asia/Seoul') - interval '${DUPLICATE_WINDOW_SECONDS} seconds', 'YYYY-MM-DD HH24:MI:SS')
       LIMIT 1`,
      [userKey, '%' + String(text).slice(0, 120) + '%']
    );
    return !!row;
  } catch (e) {
    console.error('카카오 상담톡 반복 수신 확인 실패(반복 아님으로 진행):', e.message);
    return false;
  }
}

function broadcastMessageAsync(sessionId, message) {
  broadcastMessage(sessionId, message).catch((e) => console.error('카카오 상담톡 브로드캐스트 실패:', e.message));
}

function broadcastSessionListChangedAsync(payload) {
  broadcastSessionListChanged(payload).catch((e) => console.error('카카오 상담톡 세션목록 갱신 신호 실패:', e.message));
}

// 공유 시크릿 검증 — callmaner 쪽에 이 값을 전달해 웹훅 요청 헤더(X-Webhook-Secret)에 실어달라고
// 요청해야 한다(8.1 확인 필요). 시크릿을 아직 설정하지 않았으면(로컬 개발 등) 검증을 건너뛴다.
function checkWebhookAuth(req, res, next) {
  const secret = process.env.KAKAO_CONSULT_WEBHOOK_SECRET;
  if (!secret) return next();
  if (req.get('X-Webhook-Secret') !== secret) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
router.use(checkWebhookAuth);

async function logEvent({ sessionId, eventType, keys, body, handled, errorMessage, headers }) {
  try {
    // 키가 안 잡혀 버려진 요청을 나중에 되짚으려면 바디만으로는 부족하다 — 헤더로만 키가 오는
    // 형식(카카오 원본 /receive/message)에서 "헤더가 아예 없었는지, 우리가 못 읽었는지"를
    // 구분할 수 있어야 해서 진단용 헤더를 payload에 함께 남긴다.
    const payload = headers ? { ...(body || {}), _headers: headers } : (body || {});
    await db.run(
      `INSERT INTO kakao_consult_events (session_id, event_type, user_key, service_key, event_key, payload_json, handled, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId || null, eventType, keys.userKey || null, keys.serviceKey || null, keys.eventKey || null,
        JSON.stringify(payload), !!handled, errorMessage || null]
    );
  } catch (e) {
    console.error('카카오 상담톡 이벤트 로그 저장 실패:', e.message);
  }
}

// 인증 키가 안 왔을 때의 마지막 복구 수단 — 카카오 원본 /receive/message는 바디에 키가 없고
// meta.sessionId만 있다. 그 sessionId는 우리가 세션에 저장해 둔 kakao_event_key와 같은 값이라,
// 그것만으로도 어느 대화인지 특정할 수 있다. 이 복구가 없으면 본문이 멀쩡히 들어 있는 메시지를
// 400으로 버리게 된다(실제로 그렇게 버려지고 있었다).
async function recoverSessionByEventKey(eventKey) {
  if (!eventKey) return null;
  return db.get(
    `SELECT * FROM chat_sessions WHERE channel = 'kakao' AND kakao_event_key = ? AND status != 'closed'
     ORDER BY id DESC LIMIT 1`,
    [String(eventKey)]
  ).catch(() => null);
}

// 수신 요청 → 세션. 지금까지는 userKey와 serviceKey가 **둘 다** 있어야만 진행했는데, 그건
// 발신 기준이지 수신 기준이 아니다. 수신에서 필요한 건 "누구의 대화인가"뿐이다.
//   1) userKey가 있으면 그걸로 찾거나 만든다(serviceKey는 지난 세션에서 물려받는다)
//   2) userKey가 없어도 sessionId(=event_key)가 있으면 그 세션을 찾는다
//   3) 둘 다 없으면 식별 불가 — 그때만 버린다
async function resolveInboundSession(keys) {
  if (keys.userKey) {
    if (!keys.serviceKey) {
      const previous = await db.get(
        `SELECT kakao_service_key FROM chat_sessions
         WHERE channel = 'kakao' AND external_user_key = ? AND kakao_service_key IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
        [keys.userKey]
      ).catch(() => null);
      if (previous) keys.serviceKey = previous.kakao_service_key;
    }
    return findOrCreateKakaoSession(keys);
  }

  const recovered = await recoverSessionByEventKey(keys.eventKey);
  if (recovered) {
    console.warn(`카카오 상담톡 userKey 누락 — sessionId(${keys.eventKey})로 세션 ${recovered.id} 복구`);
  }
  return recovered;
}

// 같은 고객의 카카오 세션을 재사용한다(계획서 5.1) — 닫히지 않은 세션이 있으면 그걸 쓰고,
// 없으면 새로 만든다. UserKey는 채널별로 유효하고 탈퇴/재가입 시 바뀔 수 있어(계획서 4.2) 영구
// 식별자로 쓰지 않고, "같은 세션 내 재진입을 빠르게 찾기 위한 키"로만 쓴다.
async function findOrCreateKakaoSession(keys) {
  let session = await db.get(
    `SELECT * FROM chat_sessions WHERE channel = 'kakao' AND external_user_key = ? AND status != 'closed'
     ORDER BY id DESC LIMIT 1`,
    [keys.userKey]
  );
  if (!session) {
    // 같은 고객(UserKey)의 지난 대화에서 이미 개인정보 제공 동의를 받았다면 그 값을 새 세션에
    // 물려준다. UserKey는 채널별로 고정이고 탈퇴/재가입 때만 바뀌므로(명세서 용어집) 같은 사람이다.
    //
    // 이게 없으면 상담이 끝날 때마다 번호가 사라져서, 거래처 담당자가 다음에 접수하려 할 때마다
    // 동의를 다시 받아야 한다 — 동의 말풍선은 세션당 1회뿐이라 매번 한 번씩 소진되고, 고객은
    // 매번 버튼을 눌러야 한다. 불특정 다수가 아니라 반복 이용하는 B2B 거래처라 특히 손해가 크다.
    const previous = await db.get(
      `SELECT external_name, external_phone, personal_info_at FROM chat_sessions
       WHERE channel = 'kakao' AND external_user_key = ? AND external_phone IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
      [keys.userKey]
    ).catch(() => null);

    session = await db.get(
      `INSERT INTO chat_sessions
         (channel, status, external_user_key, kakao_service_key, kakao_user_key, kakao_event_key,
          external_name, external_phone, personal_info_at)
       VALUES ('kakao', 'bot', ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      [keys.userKey, keys.serviceKey, keys.userKey, keys.eventKey,
        previous ? previous.external_name : null,
        previous ? previous.external_phone : null,
        previous ? previous.personal_info_at : null]
    );
    session.isNew = true;
    session.inheritedPersonalInfo = !!previous;
  } else if (session.kakao_service_key !== keys.serviceKey || session.kakao_event_key !== keys.eventKey) {
    // 인증 키가 바뀐 채로 들어올 수 있다(세션 재연결 등) — 다음 발신을 위해 항상 최신값으로 갱신.
    await db.run(
      `UPDATE chat_sessions SET kakao_service_key = ?, kakao_user_key = ?, kakao_event_key = ? WHERE id = ?`,
      [keys.serviceKey, keys.userKey, keys.eventKey, session.id]
    );
    session.kakao_service_key = keys.serviceKey;
    session.kakao_user_key = keys.userKey;
    session.kakao_event_key = keys.eventKey;
  }
  return session;
}

// 상담원 응대 중인 세션의 답변 초안 만들기 — 웹 위젯(routes/chat.js createSuggestionAsync)과
// 같은 규칙이다. 초안이 없다고 상담이 막히면 안 되므로 실패는 로그만 남긴다.
async function createAgentSuggestion(session, text) {
  try {
    const suggestion = await buildSuggestion(text);
    if (!suggestion) return;

    const lastUserMessage = await db.get(
      `SELECT id FROM chat_messages WHERE session_id = ? AND sender = 'user' ORDER BY id DESC LIMIT 1`,
      [session.id]
    ).catch(() => null);

    await db.run(
      `UPDATE chat_suggestions SET status = 'dismissed',
       decided_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
       WHERE session_id = ? AND status = 'pending'`,
      [session.id]
    );
    await db.run(
      `INSERT INTO chat_suggestions (session_id, user_message_id, kind, suggested_text, intake_json)
       VALUES (?, ?, ?, ?, ?)`,
      [session.id, lastUserMessage ? lastUserMessage.id : null, suggestion.kind, suggestion.text,
        suggestion.intake ? JSON.stringify(suggestion.intake) : null]
    );
  } catch (e) {
    console.error('카카오 상담원 도우미 초안 생성 실패:', e.message);
  }
}

async function insertMessage(sessionId, sender, message) {
  const inserted = await db.get(
    `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, ?, ?) RETURNING *`,
    [sessionId, sender, message]
  );
  broadcastMessageAsync(sessionId, inserted);
  return inserted;
}

async function markNeedsAgent(session, lastUserMessage, requestedFeature) {
  await db.run(
    `UPDATE chat_sessions SET status = 'needs_agent', requested_feature = ?,
     updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [requestedFeature || null, session.id]
  );
  broadcastSessionListChangedAsync({
    event: 'needs_agent',
    sessionId: session.id,
    customerName: '카카오 상담톡 고객',
    message: lastUserMessage || requestedFeature || '상담원 연결을 요청했습니다.',
  });
  try {
    await notify({
      eventType: 'agent_call', excludeUserId: 0,
      title: '🔔 카카오 상담톡 상담원 연결 요청',
      body: `카카오 상담톡 고객이 상담원 연결을 요청했습니다${requestedFeature ? ' (' + requestedFeature + ')' : ''}.`,
      url: `/chat/sessions/${session.id}`,
    });
  } catch (e) { console.error('카카오 상담톡 상담원 호출 알림 실패:', e.message); }
}

// 개인정보 제공동의 요청 — 세션당 한 번만 보낸다. 동의 결과(이름/휴대폰)는 별도 웹훅
// (/receive/personal_info)으로 들어와 chat_sessions에 저장된다.
// 명세서 제약: 동의 말풍선은 상담 세션당 1회, 동의 절차는 발송 시점부터 3일간만 유효.
// 이미 보냈으면 다시 보내지 않는다(카카오가 거부하고, 고객에게도 중복 노출된다).
const PERSONAL_INFO_VALID_DAYS = 3;

function consentAlreadyRequested(session) {
  return !!(session && session.personal_info_requested_at);
}

// 동의를 요청해두고 아직 답이 없는 상태인지 — 3일이 지나면 기다리지 않고 상담원에게 넘긴다.
function consentPending(session) {
  if (!session || !session.personal_info_requested_at || session.personal_info_at) return false;
  const requested = Date.parse(String(session.personal_info_requested_at).replace(' ', 'T') + '+09:00');
  if (Number.isNaN(requested)) return false;
  return (Date.now() - requested) < PERSONAL_INFO_VALID_DAYS * 24 * 60 * 60 * 1000;
}

async function requestPersonalInfo(session) {
  if (consentAlreadyRequested(session)) return { ok: false, error: 'already_requested' };
  const result = await kakaoConsult.sendPersonalInfoRequest(session);
  if (result.ok) {
    await db.run(
      `UPDATE chat_sessions SET personal_info_requested_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
       WHERE id = ?`,
      [session.id]
    ).catch((e) => console.error('개인정보 동의 요청 시각 저장 실패:', e.message));
    session.personal_info_requested_at = 'now';
  }
  if (!result.ok && result.error !== 'already_requested') {
    console.error('카카오 상담톡 개인정보 동의 요청 실패:', result.error);
    logIntegrationErrorAsync({
      source: 'kakao', operation: 'send_personal', refType: 'chat_session', refId: session.id,
      message: result.error, context: { label: '개인정보 제공동의 요청' },
    });
  }
  return result;
}

// 발신 실패는 고객에게는 보이지 않으니(카카오로 안 나간 채 우리 쪽 로그만 남는 상태) 반드시
// 로그를 남겨야 운영 중 "봇이 답장을 안 한다"는 문의가 왔을 때 원인을 바로 알 수 있다.
async function sendAndLog(session, text, label) {
  const result = await kakaoConsult.sendMessage(session, text);
  if (!result.ok) {
    // 발신 실패는 고객 화면에만 안 보일 뿐 우리 대화창에는 봇 답변이 남아 정상처럼 보인다 —
    // 반드시 기록해야 "봇이 답을 안 한다"는 문의가 왔을 때 원인을 바로 찾을 수 있다.
    logIntegrationErrorAsync({ source: 'kakao', operation: 'send', refType: 'chat_session', refId: session.id,
      message: result.error, context: { label, textHead: String(text || '').slice(0, 60) } });
  }
  return result;
}

// FAQ 자동응답 — 유사도가 낮으면(관련 항목 없음) 상담원 연결로 넘긴다.
async function tryAnswerFaq(session, text) {
  // 문턱은 웹 위젯(routes/orders.js)과 같은 0.7로 맞춘다 — 0.6일 때 "안녕하세요"에
  // "공지사항 메뉴는…" 같은 무관한 항목이 매칭돼 실제로 잘못된 답이 발송됐다.
  const matches = await searchKnowledgeBase(text, { limit: 1, threshold: 0.7 }).catch((e) => {
    console.error('카카오 상담톡 FAQ 검색 실패:', e.message);
    return [];
  });
  if (matches.length) {
    await insertMessage(session.id, 'bot', matches[0].answer);
    await sendAndLog(session, matches[0].answer, 'FAQ 응답');
    return true;
  }
  return false;
}

// 오더 조회/변경/취소(intent: unsupported) — 로그인 계정이 있는 웹 위젯과 달리 카카오 고객은
// b2b-car 계정이 없는 게 기본값이라(계획서 5.1) runDispatchAgent가 요구하는 users row가 없다.
// 등록 고객 매칭(전화번호 기반)은 personal_info 필드 스펙이 아직 미확정이라(계획서 8.3) 이번
// 1차 구현에는 넣지 않았다 — 지금은 전부 상담원 연결로 넘긴다.
// 개인정보 제공 동의 게이트 (사용자 확정 규칙).
//   · 요금문의·지식검색(FAQ) → 동의 없이도 응답한다. 개인을 특정할 필요가 없는 안내이기 때문.
//   · 상담원 연결·주문접수    → 반드시 동의가 있어야 한다. 누구의 요청인지 모른 채 상담원을
//     붙이거나 오더를 만들면 응대도 정산도 성립하지 않는다.
// 동의 여부는 실제로 값을 받았는지로 판단한다(번호가 들어와 있으면 충족).
function hasPersonalConsent(session) {
  return !!(session && (session.external_phone || session.personal_info_at));
}

// 동의가 필요한 동작 직전에 부른다. 진행해도 되면 true, 동의를 기다려야 하면 false.
// 동의 말풍선은 세션당 1회만 보낼 수 있어(명세서), 이미 보냈으면 다시 눌러달라고만 안내한다.
// 다만 3일 유효기간이 지나 버튼이 만료됐는데 재발송도 못 하는 상태에서 계속 막으면 고객이
// 아무 도움도 못 받고 갇힌다 — 그때는 예외적으로 상담원에게 넘긴다.
async function ensurePersonalConsent(session, purpose, rawText) {
  if (hasPersonalConsent(session)) return true;

  if (!consentAlreadyRequested(session)) {
    await savePendingConsentPurpose(session, purpose, rawText);
    const asked = await requestPersonalInfo(session);
    if (asked.ok) {
      const notice = purpose === 'agent'
        ? '상담원 연결을 위해 성함과 연락처가 필요합니다. 위 동의 버튼을 눌러주시면 바로 연결해드릴게요.'
        : '접수를 위해 성함과 연락처가 필요합니다. 위 동의 버튼을 눌러주시면 바로 접수해드릴게요.';
      await insertMessage(session.id, 'bot', notice);
      await sendAndLog(session, notice, '개인정보 동의 요청 안내');
      return false;
    }
    // 말풍선 발송 자체가 실패했으면 고객을 붙잡아둘 이유가 없다.
    return true;
  }

  if (consentPending(session)) {
    await savePendingConsentPurpose(session, purpose, rawText);
    const notice = '앞서 보내드린 개인정보 제공 동의 버튼을 눌러주시면 이어서 도와드리겠습니다.';
    await insertMessage(session.id, 'bot', notice);
    await sendAndLog(session, notice, '개인정보 동의 재안내');
    return false;
  }

  // 동의 절차가 만료됨(3일 초과) — 재발송이 불가하므로 막지 않고 진행시킨다.
  return true;
}

async function handleUnsupported(session, text, requestedFeature) {
  const notice = '상담원을 연결해드릴게요. 잠시만 기다려주세요.';
  await insertMessage(session.id, 'bot', notice);
  await sendAndLog(session, notice, '상담원 연결 안내');
  await markNeedsAgent(session, text, requestedFeature);
}

// Gemini가 뽑은 필드를 블록 폼 파서(parseKakaoIntake)와 같은 모양으로 맞춘다 — 그래야
// completeIntake가 두 경로를 구분하지 않고 처리한다.
//
// 날짜/시간은 여기서 계산하지 않는다. hybridChat이 이미 "오늘=YYYY-MM-DD" 기준을 프롬프트로
// 받아 계산한 값(reservationDate/reservationTime)을 주므로 그대로 옮기고, 둘 다 없을 때만
// resolveReservation의 즉시 처리에 맡긴다(when.immediate).
function buildParsedFromClassified(classified, text) {
  // 정규화는 폼 파서 것을 그대로 쓴다 — 같은 원문이 경로에 따라 다른 값으로 등록되면 안 된다.
  const plates = [classified.originVehicleNumber, classified.waypointVehicleNumber]
    .map((v) => normalizePlate(v)).filter(Boolean);
  const vehicleType = String(classified.vehicleType || '').trim() || null;
  // 차량 1대 = 오더 1건(파서와 동일). 차종은 첫 대에만 붙인다 — 두 번째 차량의 차종은 별도 필드가 없다.
  const vehicles = plates.map((plate, i) => ({ plate, type: i === 0 ? vehicleType : null }));

  const date = String(classified.reservationDate || '').trim() || null;
  const time = String(classified.reservationTime || '').trim() || null;
  // 날짜/시간은 여기서 계산하지 않는다. hybridChat이 "오늘=YYYY-MM-DD"를 프롬프트로 받아 이미
  // 계산한 값을 주므로 그대로 옮기고, 둘 다 없으면 즉시 요청으로 둔다(resolveReservation이 처리).
  const when = (date || time)
    ? { immediate: false, date, time, dateRolled: false, raw: [date, time].filter(Boolean).join(' ') }
    : { immediate: true, date: null, time: null, dateRolled: false, raw: null };

  const join = (a, b) => [a, b].map((v) => String(v || '').trim()).filter(Boolean).join(' ') || null;
  const originAddress = join(classified.originAddress, classified.originAddressDetail);
  const destAddress = join(classified.destinationAddress, classified.destinationAddressDetail);

  const missing = [];
  if (!originAddress) missing.push('origin_address');
  if (!destAddress) missing.push('destination_address');
  if (!vehicles.length) missing.push('vehicle_number');

  return {
    matched: true,
    complete: missing.length === 0,
    missing,
    // normalizePhone은 빈 값에 ''를 돌려주지만 폼 파서는 null을 넣는다 — 저장값을 맞춘다.
    origin: { address: originAddress, contact: normalizePhone(classified.originContact) || null },
    destination: { address: destAddress, contact: normalizePhone(classified.destinationContact) || null },
    when,
    vehicles,
    options: {},
    memo: String(classified.memo || '').trim() || null,
    raw: text,
  };
}

// 신규 오더 접수 — 상담톡 로그 2년치를 분석해보니 고객 메시지의 47%가 `[출발지]…[도착지]`
// 형식의 정형 폼이고, 그 폼은 룰 파서만으로 98%가 필수 4종(출발지·도착지·차량번호·일시)까지
// 추출된다("탁송 상담톡 챗봇 고도화 기획서" 2.1). 그래서 LLM 분류보다 **먼저** 폼 파서를 태운다 —
// 더 빠르고, 더 정확하고, 실패하면 그때 LLM 경로로 떨어뜨리면 되기 때문이다.
async function handleOrderIntake(session, text, requestedFeature) {
  const notice = '신규 접수는 상담원 연결을 통해 도와드릴게요. 잠시만 기다려주세요.';
  await insertMessage(session.id, 'bot', notice);
  await sendAndLog(session, notice, '신규접수 안내');
  await markNeedsAgent(session, text, requestedFeature || '신규 오더 접수');
}

// 파싱된 폼을 상담원이 다시 타이핑하지 않도록, 구조화 결과를 대화에 남긴 뒤 인계한다.
// (고객에게는 보내지 않는다 — 상담원 화면에서만 보이는 인계 메모다.)
async function handoffWithParsedSlots(session, parsed, text, reasonLabel) {
  const summary = [
    '[자동 파싱] ' + reasonLabel,
    `출발 ${parsed.origin.address || '-'} ${parsed.origin.contact || ''}`.trim(),
    `도착 ${parsed.destination.address || '-'} ${parsed.destination.contact || ''}`.trim(),
    `차량 ${parsed.vehicles.map((v) => [v.type, v.plate].filter(Boolean).join(' ')).join(', ') || '-'}`,
    `일시 ${parsed.when && parsed.when.raw ? parsed.when.raw : '-'}`,
    parsed.memo ? `메모 ${parsed.memo}` : null,
  ].filter(Boolean).join('\n');
  await insertMessage(session.id, 'bot', summary);

  const notice = '접수 내용 확인했습니다. 상담원이 바로 확정해드릴게요.';
  await sendAndLog(session, notice, '접수 인계 안내');
  await markNeedsAgent(session, text, '신규 오더 접수(파싱 완료)');
}

// 되묻기 상태 — 필수 필드가 빠진 폼은 부족한 항목만 물어보고 원문을 세션에 보관한다.
// 고객이 보충 정보를 보내면 원문에 이어붙여 다시 파싱한다(로그의 "정보 보충" 패턴 —
// "대전광역시 동구 용전동 176-13 입니다" 같은 한 줄이 실제로 이렇게 들어온다).
const INTAKE_SLOT_TTL_MINUTES = 30;

async function loadPendingIntake(session) {
  if (!session.intake_slots_json) return null;
  try {
    const saved = JSON.parse(session.intake_slots_json);
    if (!saved || !saved.savedAt) return null;
    if (!saved.raw && saved.purpose !== 'agent') return null;
    if (Date.now() - saved.savedAt > INTAKE_SLOT_TTL_MINUTES * 60000) return null;
    return saved;
  } catch (e) {
    return null;
  }
}

// 동의를 기다리는 동안 "무엇을 하려던 것인지"까지 함께 들고 있는다 — 동의가 도착하면
// 접수는 접수대로, 상담원 연결은 상담원 연결대로 이어가야 한다.
async function savePendingConsentPurpose(session, purpose, raw) {
  await db.run(
    `UPDATE chat_sessions SET intake_slots_json = ?,
     intake_updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [JSON.stringify({ raw: raw || '', savedAt: Date.now(), purpose }), session.id]
  ).catch((e) => console.error('동의 대기 상태 저장 실패:', e.message));
}

async function savePendingIntake(session, raw) {
  await db.run(
    `UPDATE chat_sessions SET intake_slots_json = ?,
     intake_updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [JSON.stringify({ raw, savedAt: Date.now() }), session.id]
  ).catch((e) => console.error('접수 슬롯 저장 실패:', e.message));
}

async function clearPendingIntake(session) {
  await db.run('UPDATE chat_sessions SET intake_slots_json = NULL WHERE id = ?', [session.id])
    .catch((e) => console.error('접수 슬롯 정리 실패:', e.message));
}

// 접수 폼 처리 — 처리했으면 true, 폼이 아니면 false를 돌려준다(호출부가 다음 경로로 넘긴다).
async function tryHandleIntake(session, text) {
  let parsed = parseKakaoIntake(text);
  let mergedRaw = text;

  if (!parsed.matched) {
    // 폼이 아니면, 진행 중인 접수의 보충 정보일 수 있다 — 있으면 원문에 이어붙여 재파싱한다.
    const pending = await loadPendingIntake(session);
    if (!pending) return false;
    mergedRaw = pending.raw + '\n' + text;
    parsed = parseKakaoIntake(mergedRaw);
    if (!parsed.matched) return false;
  }

  if (!parsed.complete) {
    await savePendingIntake(session, mergedRaw);
    const question = buildMissingQuestion(parsed.missing);
    await insertMessage(session.id, 'bot', question);
    await sendAndLog(session, question, '접수 되묻기');
    return true;
  }

  // 접수는 반드시 동의가 있어야 한다(사용자 확정 규칙) — 동의가 오면 저장해둔 내용으로 이어간다.
  return completeIntake(session, parsed, mergedRaw);
}

// 파싱이 끝난 접수를 실제로 등록한다 — 블록 폼(parseKakaoIntake)과 자유 문장(Gemini 추출)이
// 같은 경로를 쓰도록 분리했다. 등록 여부·인계 사유 판단이 두 갈래로 갈리면 한쪽만 고쳐지는
// 일이 생긴다.
async function completeIntake(session, parsed, rawText) {
  if (!await ensurePersonalConsent(session, 'intake', rawText)) return true;

  // 번호(개인정보 동의로 받은 것) → 채널 매핑 순으로 접수 주체를 찾는다.
  const account = await resolveIntakeContext(session);

  if (!account || !account.auto_register) {
    // 매핑이 없거나 자동 등록을 켜지 않은 채널 — 파싱만 하고 상담원에게 넘긴다.
    await clearPendingIntake(session);
    const reason = !account
      ? (consentPending(session) ? '개인정보 동의 대기' : '거래처 확인 불가')
      : '자동 등록 꺼짐';
    await handoffWithParsedSlots(session, parsed, rawText, reason);
    return true;
  }

  let result;
  try {
    result = await createOrdersFromIntake({ session, account, parsed });
  } catch (e) {
    console.error('카카오 상담톡 자동 접수 실패:', e.message);
    result = { ok: false, reason: 'exception', detail: e.message };
  }

  await clearPendingIntake(session);

  if (!result.ok) {
    // 등록을 못 한 이유는 고객에게 그대로 노출하지 않는다(내부 사정) — 상담원 인계 사유로만 남긴다.
    const labels = {
      origin_geocode_failed: '출발지 주소 좌표 확인 실패',
      operating_hours: '운영시간 밖 요청',
      incomplete_form: '필수 항목 누락',
      auto_register_off: '자동 등록 꺼짐',
      no_account: '채널 매핑 없음',
      exception: '자동 접수 오류',
    };
    await handoffWithParsedSlots(session, parsed, rawText, labels[result.reason] || result.reason);
    return true;
  }

  await insertMessage(session.id, 'bot', result.message);
  await sendAndLog(session, result.message, '접수 확인');
  broadcastSessionListChangedAsync({ event: 'order_created', sessionId: session.id });
  return true;
}

// "네", "감사합니다" 한 마디에 봇이 또 답하면 대화가 무한히 길어진다. 로그에서 상담원 발화의
// 2.6%가 이런 되받기였고 정보량이 0이라(기획서 2.2) 아예 응답하지 않는다.
const SMALL_TALK_RE = /^[\s]*(네+[~\s.!ㅣ]*|넵+[~\s.!]*|예[.,\s]*|응+[\s.!]*|감사합니다[\s.!~]*|감사해요[\s.!~]*|고맙습니다[\s.!~]*|확인(했|하겠)습니다[\s.!]*|알겠습니다[\s.!]*|수고(하세요|하셨습니다)[\s.!]*|ok|오케이)+$/i;

// 사고·파손·클레임은 봇이 절대 답하지 않는다 — 잘못 응대했을 때의 손해가 자동화 이득보다 크다.
// (기획서 5.7 인계 규칙. 지연 관련 단어는 "늦어도 3시까지"처럼 정상 요청에도 흔해서 넣지 않았다.)
const ESCALATION_RE = /(사고|파손|스크래치|기스|찍힘|긁힘|클레임|분실|도난|고장|침수|변상|보상|항의|불만)/;

// 주문 조회/변경/취소(intent: unsupported)를 MCP 배차 도우미로 처리한다.
// 카카오 고객은 b2b-car 계정이 없는 게 기본값이지만, kakao_consult_accounts에 이 채널(또는 이
// 고객)의 담당 계정이 매핑돼 있으면 그 계정 자격으로 조회할 수 있다 — 접수 자동화가 이미 같은
// 매핑으로 오더를 만들고 있으므로(lib/kakaoIntakeService.js) 조회 권한도 같은 기준을 따른다.
// 매핑이 없으면(익명 채널) 예전처럼 상담원에게 넘긴다.
async function tryDispatchAgent(session, text) {
  const account = await resolveIntakeContext(session).catch(() => null);
  if (!account || !account.user_id) return false;

  const user = await db.get('SELECT id, name, phone, role, branch_id, group_id FROM users WHERE id = ?', [account.user_id])
    .catch(() => null);
  if (!user) return false;
  // 매핑에 지사가 지정돼 있으면 그쪽을 우선한다(계정의 소속 지사와 다를 수 있다).
  if (account.branch_id) user.branch_id = account.branch_id;

  const history = await db.all(
    `SELECT sender, message FROM chat_messages
     WHERE session_id = ? AND sender IN ('user','bot') AND message IS NOT NULL
     ORDER BY id DESC LIMIT 10`,
    [session.id]
  ).catch(() => []);
  history.reverse();
  if (history.length && history[history.length - 1].sender === 'user' && history[history.length - 1].message === text) {
    history.pop();
  }

  const result = await runDispatchAgent({ user, sessionId: session.id, text, history });
  if (!result || !result.handled || !result.message) return false;

  await insertMessage(session.id, 'bot', result.message);
  await sendAndLog(session, result.message, '배차 도우미 응답');
  return true;
}

async function processBotTurn(session, text) {
  if (SMALL_TALK_RE.test(text)) return;

  // 인사·자기소개는 지식검색으로 보내지 않는다 — 웹 위젯과 같은 규칙(lib/smallTalk.js).
  const smallTalk = getSmalltalkMessage(text);
  if (smallTalk) {
    await insertMessage(session.id, 'bot', smallTalk);
    await sendAndLog(session, smallTalk, '스몰토크 응답');
    return;
  }

  if (ESCALATION_RE.test(text)) {
    if (!await ensurePersonalConsent(session, 'agent', text)) return;
    return handleUnsupported(session, text, '사고·클레임 문의');
  }

  // 정형 접수 폼이 이 채널 트래픽의 절반이라 LLM 분류보다 먼저 태운다.
  const handled = await tryHandleIntake(session, text);
  if (handled) return;

  // 자유 문장 되묻기 중이면 앞선 원문에 이어붙여 분류한다 — 폼 파서는 블록 형식만 매칭하므로
  // 보충 답변("지금요")만 넘기면 앞서 받은 출발지·도착지·차량이 사라져 처음부터 다시 묻게 된다.
  const pendingIntake = await loadPendingIntake(session);
  const intakeText = pendingIntake && pendingIntake.raw && pendingIntake.purpose !== 'agent'
    ? pendingIntake.raw + '\n' + text
    : text;

  let classified;
  try {
    classified = await classifyAndExtract(intakeText, null, null);
  } catch (e) {
    console.error('카카오 상담톡 의도 분류 실패:', e.message);
    classified = { intent: 'unsupported' };
  }

  if (classified.intent === 'unsupported') {
    // 주문 조회/변경/취소는 매핑된 계정이 있으면 배차 도우미가 직접 처리한다.
    // 처리하지 못하면(매핑 없음·미등록 고객·도구 실패) 예전처럼 상담원으로 넘어간다.
    const handledByAgent = await tryDispatchAgent(session, text).catch((e) => {
      console.error('카카오 배차 도우미 처리 실패:', e.message);
      return false;
    });
    if (handledByAgent) return;
    if (!await ensurePersonalConsent(session, 'agent', text)) return;
    return handleUnsupported(session, text, classified.requestedFeature);
  }
  if (classified.intent === 'faq') {
    // 요금문의·지식검색은 동의 없이 응답한다. 답을 못 찾아 상담원으로 넘길 때만 동의를 요구한다.
    const answered = await tryAnswerFaq(session, text);
    if (answered) return;
    if (!await ensurePersonalConsent(session, 'agent', text)) return;
    await handleUnsupported(session, text, null);
    return;
  }
  // dispatch_order / proxy_order / daily_driver_order — 폼 파서가 못 잡은 자유 문장 접수다.
  // Gemini가 뽑은 필드를 폼과 같은 모양으로 바꿔 같은 등록 경로를 태운다. 탁송(dispatch_order)만
  // 대상이다 — 프리미엄/일일기사는 오더 컬럼과 요금 체계가 달라 이번 범위 밖이다.
  // 경유지는 파서도 접수 서비스도 지원하지 않는다 — 자동 등록하면 경유지가 조용히 사라지므로
  // 상담원에게 넘긴다.
  const hasWaypoint = !!String(classified.waypointAddress || '').trim();
  if (classified.intent === 'dispatch_order' && !hasWaypoint) {
    const parsed = buildParsedFromClassified(classified, intakeText);
    if (!parsed.complete) {
      // 빠진 항목만 되묻는다 — 폼 경로와 같은 문구를 쓴다. 다음 메시지는 위 intakeText 병합으로
      // 앞 원문에 이어붙여 다시 분류하므로, 고객이 전체를 다시 쓸 필요가 없다.
      //
      // 동의는 여기서 받지 않는다(폼 경로와 동일) — 동의 말풍선은 세션당 1회뿐이라, 아직 등록할지도
      // 모르는 단계에서 써버리면 정작 등록 직전에 다시 띄울 수 없다. completeIntake가 요구한다.
      await savePendingIntake(session, intakeText);
      const question = buildMissingQuestion(parsed.missing);
      await insertMessage(session.id, 'bot', question);
      await sendAndLog(session, question, '접수 되묻기(자유문장)');
      return;
    }
    await completeIntake(session, parsed, intakeText);
    return;
  }

  if (!await ensurePersonalConsent(session, 'intake', text)) return;
  return handleOrderIntake(session, text, classified.requestedFeature);
}

// ---------------- 고객 메시지 수신 ----------------
router.post(['/receive', '/receive/message', '/receive/message-simple'], asyncHandler(async (req, res) => {
  const keys = kakaoConsult.extractKeys(req);
  const text = kakaoConsult.extractPlainText(req.body);
  const headers = kakaoConsult.extractDiagnosticHeaders(req);

  // 키가 없어도 곧바로 버리지 않는다 — meta.sessionId만 온 형식(카카오 원본 /receive/message)은
  // 그 값으로 기존 세션을 찾을 수 있다. 본문이 멀쩡한 메시지를 400으로 버리면 고객 입장에서는
  // "보냈는데 상담원이 못 봤다"가 된다(실측: message 이벤트 16건 중 6건이 이렇게 버려졌다).
  // 세션을 찾는 데 필요한 건 userKey다. serviceKey는 **발신할 때** 필요한 값이라, 없다고 해서
  // 수신 메시지를 버릴 이유가 없다 — 없으면 같은 고객의 지난 세션에서 물려받는다.
  // (실측: /receive/reference는 serviceKey 없이 userKey만 보내와서 전부 버려지고 있었다.)
  let session = await resolveInboundSession(keys);
  if (!session) {
    await logEvent({ eventType: 'message', keys, body: req.body, headers, handled: false, errorMessage: 'missing_keys' });
    // 400을 주면 중계서버가 같은 요청을 계속 재시도할 수 있는데, 식별할 수 없는 요청은 재시도해도
    // 결과가 같다. 200으로 받아 삼키고 로그로만 남긴다(계획서 8.4의 재시도 유발 회피와 같은 판단).
    return res.json({ code: 200, message: 'SUCCESS' });
  }
  keys.userKey = keys.userKey || session.kakao_user_key;
  keys.serviceKey = keys.serviceKey || session.kakao_service_key;

  // 재전송(같은 일련번호)이면 통째로 무시한다 — 이미 저장·처리한 메시지다.
  const serialNumber = req.body && req.body.meta && req.body.meta.serialNumber;
  if (text && await isResentEvent(serialNumber)) {
    console.warn(`카카오 상담톡 재전송 무시 (session=${session.id}, serial=${serialNumber})`);
    return res.json({ code: 200, message: 'SUCCESS' });
  }
  // 일련번호가 없으면 확신할 수 없다 — 메시지는 저장하고 봇의 중복 응답만 막는다.
  const repeated = text && !serialNumber ? await looksRepeated(keys.userKey, text) : false;

  await logEvent({ sessionId: session.id, eventType: 'message', keys, body: req.body, headers, handled: true });

  if (!text) {
    // 이미지/파일만 온 경우 — 1차 범위가 텍스트라 처리는 못 하지만 무반응으로 두지 않는다.
    if (kakaoConsult.hasNonTextSection(req.body) && session.status !== 'agent_active') {
      const notice = '사진·파일은 아직 확인이 어려워요. 상담원을 연결해드릴게요.';
      await insertMessage(session.id, 'bot', notice);
      res.json({ code: 200, message: 'SUCCESS' });
      runAfterResponse((async () => {
        await sendAndLog(session, notice, '비텍스트 메시지 안내');
        await markNeedsAgent(session, null, '사진/파일 문의');
      })(), 'non_text');
      return;
    }
    return res.json({ code: 200, message: 'SUCCESS' });
  }
  // 반복 문구여도 저장은 한다 — 상담원 화면에서 사라지면 "보냈는데 못 봤다"가 된다.
  await insertMessage(session.id, 'user', text);
  if (repeated) console.warn(`카카오 상담톡 반복 문구 — 저장만 하고 봇 응답은 생략 (session=${session.id})`);

  // 여기까지는 빠른 DB 쓰기뿐이라 곧바로 200을 돌려주고, 봇 처리(Gemini 분류 → 지식검색 →
  // 카카오 발신, 합쳐서 수십 초까지 걸릴 수 있다)는 응답 뒤로 넘긴다(계획서 8.4).
  res.json({ code: 200, message: 'SUCCESS' });

  // 상담원이 이미 응대 중인 세션은 봇이 끼어들지 않는다(기존 웹 위젯 규칙과 동일).
  if (!repeated && session.status !== 'agent_active') {
    runAfterResponse(
      (async () => {
        // 동의 요청은 첫 메시지에 무조건 보내지 않는다 — 요금문의·지식검색만 하고 끝나는 고객에게는
        // 불필요하다. 상담원 연결이나 접수처럼 실제로 신원이 필요한 시점에만 요청한다
        // (ensurePersonalConsent, 사용자 확정 규칙).
        await processBotTurn(session, text);
      })().catch(async (e) => {
        console.error('카카오 상담톡 봇 처리 실패:', e.message);
        await markNeedsAgent(session, text, null);
      }),
      'bot_turn'
    );
  } else {
    // 상담원 응대 중 — 봇은 고객에게 답하지 않지만(기존 규칙 유지) 답변 초안은 만들어 둔다.
    // 상담원 화면에 "채택 대기"로 뜨고, 승인해야 고객에게 나간다(lib/agentAssist.js).
    runAfterResponse(createAgentSuggestion(session, text), 'agent_suggestion');
  }
}));

// ---------------- "상담원 연결" 버튼 ----------------
router.post('/receive/reference', asyncHandler(async (req, res) => {
  const keys = kakaoConsult.extractKeys(req);
  const headers = kakaoConsult.extractDiagnosticHeaders(req);

  // 상담원 연결 버튼도 메시지 수신과 같은 이유로 버려지고 있었다(실측 2건) — 이 요청의 바디는
  // camelCase(userKey)로 오는데 snake_case만 보고 있었다. extractKeys가 둘 다 보게 고쳤고,
  // 그래도 못 찾으면 sessionId로 기존 세션을 찾는다. 여기서 놓치면 고객은 "상담원 연결"을
  // 눌렀는데 아무도 호출되지 않는 상태가 된다 — 가장 티나는 실패다.
  const session = await resolveInboundSession(keys);
  if (!session) {
    await logEvent({ eventType: 'reference', keys, body: req.body, headers, handled: false, errorMessage: 'missing_keys' });
    return res.json({ code: 200, message: 'SUCCESS' });
  }
  keys.userKey = keys.userKey || session.kakao_user_key;
  keys.serviceKey = keys.serviceKey || session.kakao_service_key;
  await logEvent({ sessionId: session.id, eventType: 'reference', keys, body: req.body, headers, handled: true });

  // 원본 스펙의 reference.text(상담원 연결 버튼 직전 발화, 계획서 4.6)를 인계 메시지로 남겨두면
  // 상담원 카드보드에서 "고객이 방금 뭐라고 했는지"가 바로 보인다.
  // 명세서상 reference.text는 "삭제예정"이라 lastText를 함께 본다.
  const reference = (req.body && req.body.reference) || {};
  const lastText = reference.text || reference.lastText || null;
  const shouldHandOff = session.status !== 'agent_active';
  const notice = '상담사를 연결중입니다. 잠시만 기다려주세요.';
  // 대화창에 남길 안내는 먼저 저장한다(빠른 DB 쓰기). 카카오 발신과 상담원 호출 알림은
  // 외부 API 호출이라 응답 뒤로 넘긴다(계획서 8.4).
  if (shouldHandOff) await insertMessage(session.id, 'bot', notice);

  res.json({ code: 200, message: 'SUCCESS' });

  if (shouldHandOff) {
    runAfterResponse((async () => {
      await sendAndLog(session, notice, '상담원 연결중 안내');
      await markNeedsAgent(session, lastText || null, '상담원 연결');
    })(), 'reference');
  }
}));

// ---------------- 세션 만료 통지 ----------------
router.post('/receive/expired_session', asyncHandler(async (req, res) => {
  const keys = kakaoConsult.extractKeys(req);
  if (keys.userKey) {
    const session = await db.get(
      `SELECT * FROM chat_sessions WHERE channel = 'kakao' AND external_user_key = ? AND status != 'closed'
       ORDER BY id DESC LIMIT 1`,
      [keys.userKey]
    );
    if (session) {
      await db.run(`UPDATE chat_sessions SET status = 'closed' WHERE id = ?`, [session.id]);
      await logEvent({ sessionId: session.id, eventType: 'expired_session', keys, body: req.body, handled: true });
      broadcastSessionListChangedAsync();
    } else {
      await logEvent({ eventType: 'expired_session', keys, body: req.body, handled: false, errorMessage: 'session_not_found' });
    }
  }
  res.json({ code: 200, message: 'SUCCESS' });
}));

// ---------------- 읽음 정보(명세서 필수 구현 항목 — 계획서 4.5/8.3) ----------------
// 지금은 별도 처리 없이 감사로그만 남기고 200을 반환한다 — 미구현 시 카카오가 404로 재시도를
// 유발한다는 경고가 있어(계획서 8.3) 이 엔드포인트 자체는 반드시 존재해야 한다.
router.post('/receive/seen_info', asyncHandler(async (req, res) => {
  const keys = kakaoConsult.extractKeys(req);
  await logEvent({ eventType: 'seen_info', keys, body: req.body, handled: true });
  res.json({ code: 200, message: 'SUCCESS' });
}));

// ---------------- 개인정보 제공동의(필드 스펙 미확정 — 계획서 8.3) ----------------
// 정확한 필드명이 확정되기 전까지는 파싱하지 않고 원본만 감사로그에 남긴다. 로그에 개인정보
// 본문을 남기지 말라는 문서 경고(계획서 8.3)에 따라 payload_json에는 저장하되, 별도 평문 로그
// (console.log 등)로는 절대 남기지 않는다.
router.post('/receive/personal_info', asyncHandler(async (req, res) => {
  const keys = kakaoConsult.extractKeys(req);
  const { name, phone } = kakaoConsult.extractPersonalInfo(req.body);
  let resumeAfterConsent = null;
  let linked = null;
  let newCustomer = false;

  let session = null;
  if (keys.userKey) {
    session = await db.get(
      `SELECT * FROM chat_sessions WHERE channel = 'kakao' AND external_user_key = ? AND status != 'closed'
       ORDER BY id DESC LIMIT 1`,
      [keys.userKey]
    ).catch(() => null);
  }

  // 이름·휴대폰을 세션에 붙인다 — 이때부터 상담원 목록에 "-" 대신 실제 고객명이 뜨고(routes/chat.js
  // CUSTOMER_NAME_SQL), 전화번호로 거래처 담당자를 찾는 경로(기획서 5.7 2단계)가 열린다.
  // 평문 로그(console)에는 절대 남기지 않는다 — 명세서 경고(계획서 8.3).
  let saved = false;
  if (session && (name || phone)) {
    await db.run(
      `UPDATE chat_sessions SET external_name = COALESCE(?, external_name),
       external_phone = COALESCE(?, external_phone),
       personal_info_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
      [name || null, phone || null, session.id]
    );
    saved = true;
    broadcastSessionListChangedAsync({ event: 'personal_info', sessionId: session.id });

    // 받은 번호가 우리 거래처와 이어지면 이 UserKey를 채널 매핑에 등록해둔다 — 다음 상담부터는
    // 동의 없이 첫 메시지부터 거래처가 확정된다. 이어지지 않는 번호(우리 시스템에 없는 사람)는
    // 등록하지 않고 상담원이 확인하도록 둔다.
    session.external_phone = phone || session.external_phone;
    session.external_name = name || session.external_name;
    const matched = await findAccountByPhone(session.external_phone).catch(() => null);
    if (matched) {
      linked = await linkUserKeyToAccount(session, matched);
    } else if (phone) {
      newCustomer = true;
    }

    // 동의를 기다리며 들고 있던 접수 내용이 있으면 지금 이어서 처리한다 — 고객이 같은 내용을
    // 다시 보내지 않아도 되게. 응답(200)은 먼저 돌려주고 처리는 뒤로 넘긴다(계획서 8.4).
    const pending = await loadPendingIntake(session);
    if (pending) {
      resumeAfterConsent = { session, raw: pending.raw, purpose: pending.purpose || 'intake' };
    }
  }

  await logEvent({
    sessionId: session ? session.id : null,
    eventType: 'personal_info',
    keys,
    body: req.body,
    handled: saved,
    // 동의는 왔는데 값을 못 읽었다면 필드명이 예상과 다른 것이다 — 원본 payload가 함께 남으니
    // 그걸 보고 lib/kakaoConsult.js extractPersonalInfo를 좁히면 된다.
    errorMessage: saved
      ? (newCustomer ? 'customer_not_registered' : null)
      : (session ? 'personal_fields_unrecognized' : 'session_not_found'),
  });

  res.json({ code: 200, message: 'SUCCESS' });

  if (resumeAfterConsent) {
    // 동의를 기다리느라 멈춰 있던 작업을 이어간다 — 고객이 같은 말을 다시 하지 않아도 되게.
    const { session: resumeSession, raw, purpose } = resumeAfterConsent;
    const isNewCustomer = newCustomer;
    runAfterResponse((async () => {
      await clearPendingIntake(resumeSession);
      if (purpose === 'agent') {
        const notice = '확인되었습니다. 상담원을 연결해드릴게요.';
        await insertMessage(resumeSession.id, 'bot', notice);
        await sendAndLog(resumeSession, notice, '동의 후 상담원 연결');
        await markNeedsAgent(resumeSession, raw,
          isNewCustomer ? '상담원 연결(미등록 고객 — 계정 등록 필요)' : '상담원 연결(동의 완료)');
        return;
      }
      const handled = await tryHandleIntake(resumeSession, raw);
      // 번호를 받았는데도 거래처를 못 찾은 경우 — 그대로 두면 고객이 답을 못 받는다.
      if (!handled) {
        await markNeedsAgent(resumeSession, raw,
          isNewCustomer ? '신규 오더 접수(미등록 고객 — 계정 등록 필요)' : '신규 오더 접수(동의 후 거래처 확인 필요)');
      }
    })(), 'resume_after_consent');
  }
}));

module.exports = router;
// 자유 문장 필드 매핑은 폼 파서와 결과가 같아야 해서 따로 검증한다(scripts/kakao-freetext-intake-test.js).
module.exports.buildParsedFromClassified = buildParsedFromClassified;
