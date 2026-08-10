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
const { parseKakaoIntake, buildParsedFromClassified, buildMissingQuestion, normalizePhone, normalizePlate } = require('../lib/kakaoIntakeParser');
const { findIntakeAccount, resolveIntakeContext, findAccountByPhone, linkUserKeyToAccount, createOrdersFromIntake } = require('../lib/kakaoIntakeService');
const { previewIntakeAddresses } = require('../lib/intakeAddressPreview');
// 도선(배편) 구간 판정에 쓴다 — 주소의 시도를 봐야 해서 좌표 변환이 필요하다.
const { geocodeAddress } = require('../lib/geocode');
// 나뉜 건의 출발 시각을 물을 때 쓰는 문구.
const { buildScheduleQuestion } = require('../lib/orderSplit');
const { runKakaoOrderNotifications } = require('../lib/kakaoOrderNotify');
const kakaoOrderPhotos = require('../lib/kakaoOrderPhotos');
const { sendOrderPhotos, isPhotoRequest, isOdometerRequest, answerOdometer, countNoPhotoAnswers } = kakaoOrderPhotos;
// 주소 후보 검색·선택은 웹 접수 화면과 같은 규칙을 쓴다(lib/addressCandidates.js).
const { searchAddressCandidates, needsDisambiguation, buildCandidateListText, matchCandidateChoice, getClarifyText } = require('../lib/addressCandidates');
const { getSmalltalkMessage } = require('../lib/smallTalk');
const { buildSuggestion, buildFareSuggestion, buildHoursSuggestion, isHoursQuestion, toIntakeFields } = require('../lib/agentAssist');
const { runDispatchAgent } = require('../lib/mcpDispatchAgent');
const { notify } = require('../lib/push');
const { broadcastMessage, broadcastSessionListChanged } = require('../lib/realtimeChat');
const { logIntegrationErrorAsync } = require('../lib/integrationLog');

const router = express.Router();

// resolveIntakeContext는 매번 최대 4번의 순차 DB 조회를 한다(findIntakeAccount 최대 2개 +
// findAccountByPhone 최대 2개). 그런데 한 턴 안에서 값이 절대 바뀌지 않는데도, 운영시간→
// 요금→접수 같은 여러 확인 단계를 거치면서 매 단계가 다시 계산하고 있었다(실측: 최대 5곳에서
// 중복 호출). session 객체는 이 파일에서 한 턴 동안 그대로 넘겨지므로, 그 인스턴스에 프라미스를
// 붙여 같은 턴 안에서는 한 번만 계산하고 재사용한다. session이 요청마다 새로 로드되는 값이라
// (findOrCreateKakaoSession) 턴을 넘어 캐시가 새는 일은 없다.
function resolveIntakeContextCached(session) {
  if (!session.__intakeContextPromise) {
    session.__intakeContextPromise = resolveIntakeContext(session);
  }
  return session.__intakeContextPromise;
}

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
// 반복 판정을 아예 적용하면 안 되는 짧은 답인지.
//
// 판정이 payload_json LIKE '%텍스트%'라서, 텍스트가 짧을수록 아무 과거 이벤트에나 걸린다.
// 고객이 주소 후보를 "1"로 고르면 후보 목록을 담은 직전 이벤트의 JSON에 "1."이 들어 있어서
// 반드시 매칭됐고, 그 결과 봇이 침묵했다 — 주소 확정 기능이 통째로 멈추는 셈이었다
// (실측: "판교역 → 사당역" 접수에서 1번을 고르자 아무 응답도 나가지 않았다).
//
// 원래 막으려던 것은 "네", "확인부탁드립니다" 같은 문장을 연달아 보내는 경우다. 짧은 답을
// 빼도 그 목적은 그대로 달성된다.
function isTooShortForRepeatCheck(text) {
  const body = String(text == null ? '' : text).trim();
  if (!body) return true;
  return body.length <= 4 || /^\d{1,2}[.)]?$/.test(body);
}

async function looksRepeated(userKey, text) {
  if (isTooShortForRepeatCheck(text)) return false;

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
    // 요금 초안은 지사 요금표로 계산한다 — 매핑이 없으면 기본 요금표 지사로 폴백한다.
    const account = await resolveIntakeContextCached(session).catch(() => null);
    const suggestion = await buildSuggestion(text, { branchId: account && account.branch_id });
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

// 메시지를 저장할 때 세션의 updated_at도 함께 올린다.
//
// 이게 빠져 있어서 실제로 문제가 났다 — 상담관리 목록은 updated_at 내림차순으로 정렬하는데,
// 카카오 고객이 새 메시지를 보내도 세션 시각이 옛날 그대로라 목록에서 위로 올라오지 않았다.
// 메시지는 DB에 멀쩡히 저장돼 있고 세션을 열어보면 보이는데, 목록만 보고 있는 상담원 눈에는
// 아무 일도 없는 것처럼 보인다(세션 676: 마지막 메시지 08:57, 세션 시각 00:28).
// 목록 갱신 신호까지 함께 보내야 열려 있는 상담관리 화면이 스스로 다시 그린다.
async function insertMessage(sessionId, sender, message) {
  const inserted = await db.get(
    `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, ?, ?) RETURNING *`,
    [sessionId, sender, message]
  );
  await db.run(
    `UPDATE chat_sessions SET updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
     WHERE id = ?`,
    [sessionId]
  ).catch((e) => console.error('카카오 상담톡 세션 시각 갱신 실패:', e.message));
  broadcastMessageAsync(sessionId, inserted);
  if (sender === 'user') broadcastSessionListChangedAsync({ event: 'new_message', sessionId });
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
  // 동의 버튼(/send/rich)은 X-Event-Key가 없으면 중계서버가 거부한다. 키가 없는 세션에서
  // 그대로 시도하면 요청마다 실패 왕복이 반복된다 — 미리 걸러 그 낭비를 없앤다.
  if (!session.kakao_event_key) return { ok: false, error: 'event_key_missing' };
  const result = await kakaoConsult.sendPersonalInfoRequest(session);
  if (result.ok) {
    await db.run(
      `UPDATE chat_sessions SET personal_info_requested_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
       WHERE id = ?`,
      [session.id]
    ).catch((e) => console.error('개인정보 동의 요청 시각 저장 실패:', e.message));
    session.personal_info_requested_at = 'now';
  }
  if (!result.ok && result.error !== 'already_requested' && result.error !== 'event_key_missing') {
    console.error('카카오 상담톡 개인정보 동의 요청 실패:', result.error);
    logIntegrationErrorAsync({
      source: 'kakao', operation: 'send_personal', refType: 'chat_session', refId: session.id,
      message: result.error, context: { label: '개인정보 제공동의 요청' },
    });
  }
  return result;
}

// 카카오 상담톡은 봇·상담원 메시지가 한 줄 텍스트 스트림으로 섞여 도착한다(웹 위젯과 달리
// 발신 주체를 UI 말풍선으로 구분해줄 수 없다). 그래서 응답 첫 줄에 발신 주체를 항상 명시한다 —
// 봇은 "AI 응답", 상담원은 "상담원 : {이름}"(상담원 라벨은 상담원 답장 경로 routes/chat.js에서 붙인다).
// 예전에는 상담원→봇 인계 구간에만 꼬리표 "(AI 자동응답)"을 붙였는데, 이 상시 라벨이 그 역할까지
// 대신하므로(항상 봇임이 첫 줄에 드러난다) 꼬리표는 없앴다 — 중복 표기 방지.
const BOT_LABEL = 'AI 응답';

function withBotLabel(text) {
  const body = String(text || '');
  if (!body.trim() || body.startsWith(BOT_LABEL)) return body;
  return `${BOT_LABEL}\n${body}`;
}

// 봇이 고객에게 말하는 단 하나의 통로 — 대화 이력 저장과 카카오 발신을 같은 원문으로 함께
// 한다. 라벨은 저장하지 않고 발신(sendAndLog)에서만 붙인다 — 관리자 화면(세션 상세·카드
// 목록)은 채널과 무관하게 모든 봇 메시지 위에 이미 "AI" 배지를 붙이므로, 저장 텍스트에도
// "AI 응답"을 박아두면 카카오 세션에서 배지와 텍스트가 겹쳐 보인다(실사용 지적). 상담원
// 답장(routes/chat.js deliverAgentReply)도 같은 방식이다 — chat_messages에는 원문만 남기고,
// 카카오로 나가는 텍스트에만 "상담원 : 이름"을 붙인다.
async function botSay(session, text, label) {
  await insertMessage(session.id, 'bot', text);
  return sendAndLog(session, text, label);
}

// 발신 실패는 고객에게는 보이지 않으니(카카오로 안 나간 채 우리 쪽 로그만 남는 상태) 반드시
// 로그를 남겨야 운영 중 "봇이 답장을 안 한다"는 문의가 왔을 때 원인을 바로 알 수 있다.
async function sendAndLog(session, text, label) {
  // 발신 직전에만 라벨을 붙인다 — botSay든 이 함수를 직접 부르는 호출부(인계 안내 등)든
  // 저장 텍스트는 항상 원문 그대로이므로, 여기서 한 번만 붙이면 모든 경로가 같은 라벨을 단다.
  const result = await kakaoConsult.sendMessage(session, withBotLabel(text));
  if (!result.ok) {
    // 발신 실패는 고객 화면에만 안 보일 뿐 우리 대화창에는 봇 답변이 남아 정상처럼 보인다 —
    // 반드시 기록해야 "봇이 답을 안 한다"는 문의가 왔을 때 원인을 바로 찾을 수 있다.
    logIntegrationErrorAsync({ source: 'kakao', operation: 'send', refType: 'chat_session', refId: session.id,
      message: result.error, context: { label, textHead: String(text || '').slice(0, 60) } });
  }
  return result;
}

// FAQ 자동응답 — 유사도가 낮으면(관련 항목 없음) 상담원 연결로 넘긴다.
// 구간이 붙은 요금 문의("사당역에서 반포역까지 얼마?")는 지식검색으로 풀 수 없다 —
// 거리마다 답이 달라 등록해 둘 수 있는 항목이 아니다. 그래서 FAQ보다 먼저 실제 요금표로
// 계산해 답한다. 구간이 없는 "요금조회 되나요?" 같은 안내성 질문은 그대로 FAQ가 받는다.
async function tryAnswerFare(session, text, extracted) {
  const account = await resolveIntakeContextCached(session).catch(() => null);
  const draft = await buildFareSuggestion(text, { branchId: account && account.branch_id, extracted })
    .catch((e) => { console.error('카카오 요금 안내 실패:', e.message); return null; });
  if (!draft) return false;
  await botSay(session, draft.text, '요금 안내');
  return true;
}

// 운영시간 문의도 지식검색보다 먼저 실제 설정(operating_hours)을 읽어 답한다 — 요금과 같은
// 이유다. KB에 문구를 넣어두면 지사가 시간을 바꿔도 조용히 낡는데, 오더 등록은 이미 이 테이블로
// 접수를 막고 있어서 안내와 실제 동작이 어긋나면 그게 더 나쁘다.
async function tryAnswerOperatingHours(session, text) {
  // 값싼 키워드 관문을 먼저 통과시킨다 — 운영시간 질문이 아니면(대다수) 여기서 바로 빠져,
  // 거래처 확정(resolveIntakeContext, 첫 호출 시 DB 다회)이 분류 전 순차 지연으로 붙지 않게 한다.
  if (!isHoursQuestion(text)) return false;
  const account = await resolveIntakeContextCached(session).catch(() => null);
  const draft = await buildHoursSuggestion(text, { branchId: account && account.branch_id })
    .catch((e) => { console.error('카카오 운영시간 안내 실패:', e.message); return null; });
  if (!draft) return false;
  await botSay(session, draft.text, '운영시간 안내');
  return true;
}

// knowledgeSearchPromise를 넘기면(processBotTurn이 분류와 동시에 미리 시작해둔 것) 그걸
// 그대로 기다리고, 없으면(다른 호출부용 대비) 여기서 새로 시작한다.
async function tryAnswerFaq(session, text, knowledgeSearchPromise) {
  // 문턱은 웹 위젯(routes/orders.js)과 같은 0.7로 맞춘다 — 0.6일 때 "안녕하세요"에
  // "공지사항 메뉴는…" 같은 무관한 항목이 매칭돼 실제로 잘못된 답이 발송됐다.
  const matches = await (knowledgeSearchPromise || searchKnowledgeBase(text, { limit: 1, threshold: 0.7 })).catch((e) => {
    console.error('카카오 상담톡 FAQ 검색 실패:', e.message);
    return [];
  });
  if (matches.length) {
    await botSay(session, matches[0].answer, 'FAQ 응답');
    return true;
  }
  return false;
}

// 배차 도우미 대화가 이어지는 중인지.
//
// 도우미가 "언제로 접수해 드릴까요?"라고 물으면 고객은 "네 8월 25일 오후 3시로 접수해주세요"처럼
// 답한다. 그 문장만 보면 새 접수 요청이라 dispatch_order로 분류되고, 도우미가 방금 물어본 맥락이
// 통째로 사라진다(실측: 출발지·도착지를 처음부터 다시 물었다). 직전 턴이 도우미였으면 이어지는
// 답도 그 대화로 돌린다.
//
// 창을 짧게 둔다 — 오래 두면 한참 뒤의 새 접수까지 도우미로 흘러간다.
const MCP_FOLLOWUP_WINDOW_MS = 10 * 60 * 1000;

async function markMcpTurn(session) {
  await db.run(
    `UPDATE chat_sessions SET mcp_last_turn_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [session.id]
  ).catch((e) => {
    // 마이그레이션(20260809070000) 전이면 컬럼이 없다 — 이어붙이기만 안 될 뿐 응답은 정상이다.
    if (!e || e.code !== '42703') console.error('배차 도우미 턴 기록 실패:', e.message);
  });
}

function isMcpFollowUp(session) {
  const at = session && session.mcp_last_turn_at;
  if (!at) return false;
  const ts = Date.parse(String(at).replace(' ', 'T') + '+09:00');
  return Number.isFinite(ts) && Date.now() - ts < MCP_FOLLOWUP_WINDOW_MS;
}

// 사진 요청("사진 좀 보내주세요", "인수증 사진") — 로그 분석에서 상담원 발화의 61.6%가 여기
// 걸려 있었다. 기사가 우리 업로드 페이지로 올린 사진을 상담원이 받아 고객에게 다시 전달하는
// 일이 대부분이었다. 그 전달을 봇이 한다.
//
// LLM 분류보다 먼저 본다 — 요금·운영시간과 같은 이유다. "사진"이라는 말은 뜻이 좁아서 규칙으로
// 충분하고, 분류를 거치면 unsupported로 떨어져 상담원에게 넘어간다.
// 판정 규칙은 lib/kakaoOrderPhotos.js가 갖고 있다(검증 스크립트가 같은 정의를 쓴다).
// 이 대화로 접수한 오더. 전화번호로 매칭된 계정의 다른 오더까지 열면 "누구의 것인지"를 이
// 자리에서 판단해야 하는데, 그 판단을 틀리면 남의 차 사진이 나간다.
function loadSessionOrder(session) {
  return db.get(
    `SELECT id, oid, branch_id FROM orders WHERE chat_session_id = ? ORDER BY id DESC LIMIT 1`,
    [session.id]
  ).catch(() => null);
}

// 주행거리 문의("몇 km 뛰었나요") — 기사가 계기판 사진과 함께 적어둔 값으로 답한다.
// 사진과 같은 열람 권한을 따른다(lib/kakaoOrderPhotos.js).
async function tryAnswerOdometer(session, text) {
  if (!isOdometerRequest(text) || isPhotoRequest(text)) return false;
  const order = await loadSessionOrder(session);
  if (!order) return false;

  const result = await answerOdometer(order).catch((e) => {
    console.error('카카오 주행거리 안내 실패:', e.message);
    return null;
  });
  if (!result) return false;

  await botSay(session, result.message, '주행거리 안내');
  if (result.skipped === 'not_allowed') await markNeedsAgent(session, text, '주행거리 문의(고객 열람 불가 지사)');
  return true;
}

async function tryAnswerPhotoRequest(session, text) {
  if (!isPhotoRequest(text)) return false;

  const order = await loadSessionOrder(session);
  if (!order) return false;

  const result = await sendOrderPhotos(session, order, {
    // 보낼 사진이 있을 때만 알린다 — 내려받아 다시 올리는 동안 몇 초씩 걸린다.
    onStart: (count) => botSay(session, `사진 ${count}장을 준비하고 있습니다. 잠시만 기다려주세요.`, '사진 전달 대기 안내'),
  }).catch((e) => {
    console.error('카카오 사진 전달 실패:', e.message);
    return { skipped: 'error', message: kakaoOrderPhotos.MESSAGES.allFailed };
  });

  if (result.sent) {
    // 발신 자체는 sendOrderPhotos가 이미 했다(이미지 섹션이라 botSay로는 못 보낸다). 상담
    // 이력에는 무엇을 보냈는지 남겨야 상담원이 "이미 나간 사진"을 또 보내지 않는다.
    await insertMessage(session.id, 'bot', result.caption);
    return true;
  }

  // 사진이 없어서 못 보낸 경우 — 재요청인지 본다.
  //
  // 기사에게 직접 알릴 방법이 없다(푸시는 관리자·상담원 대상이고 기사 SMS 경로는 없다). 그래서
  // 재촉은 상담원을 거쳐야 하는데, 처음 물었을 때부터 사람을 부르면 자동화 이득이 사라진다 —
  // 기사가 곧 올릴 수도 있다. 두 번째로 물으면 그때는 기다리게 두지 않는다.
  if (result.skipped === 'no_photos') {
    const askedBefore = await countNoPhotoAnswers(session.id).catch(() => 0);
    if (askedBefore > 0) {
      await botSay(session, kakaoOrderPhotos.MESSAGES.noPhotosAgain, '사진 재요청');
      await markNeedsAgent(session, text, '사진 재요청(기사 확인 필요)');
      return true;
    }
    await botSay(session, result.message, '사진 요청 응답');
    // 상담원이 미리 알고 기사에게 확인해두면, 고객이 다시 묻기 전에 사진이 올라와 있을 수 있다.
    notify({
      branchId: order.branch_id,
      eventType: 'order_events',
      excludeUserId: 0,
      title: '고객이 사진을 요청했습니다',
      body: `${order.oid}: 아직 등록된 사진이 없습니다. 기사님께 확인이 필요합니다.`,
      url: `/orders/${order.id}`,
    }).catch((e) => console.error('사진 요청 알림 실패:', e.message));
    return true;
  }

  await botSay(session, result.message, '사진 요청 응답');
  // 권한이 없어 못 보낸 경우는 상담원이 이어받아야 한다.
  if (result.skipped === 'not_allowed') await markNeedsAgent(session, text, '사진 요청(고객 열람 불가 지사)');
  return true;
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
      const notice = purpose === 'lookup'
        ? '주문 조회를 위해 성함과 연락처가 필요합니다. 위 동의 버튼을 눌러주시면 바로 조회해드릴게요.'
        : '접수를 위해 성함과 연락처가 필요합니다. 위 동의 버튼을 눌러주시면 바로 접수해드릴게요.';
      await botSay(session, notice, '개인정보 동의 요청 안내');
      return false;
    }
    // 말풍선 발송 자체가 실패했으면 고객을 붙잡아둘 이유가 없다.
    return true;
  }

  // 이미 버튼을 보냈으면 다시 재촉하지 않는다.
  //
  // 예전에는 동의를 받을 때까지 매 메시지마다 "앞서 보내드린 동의 버튼을 눌러주시면…"을 보냈다.
  // 동의 버튼은 세션당 1회뿐이라 재발송도 못 하면서 문구만 반복됐고, 고객은 무엇을 물어도 같은
  // 말만 듣게 됐다(실사용 지적). 버튼은 이미 대화에 남아 있으니 누르면 이어진다 — 그때까지는
  // 막지 말고 진행시킨다. 접수는 거래처를 확인하지 못해 상담원에게 넘어가고, 사람이 이어받는다.
  if (consentPending(session)) {
    await savePendingConsentPurpose(session, purpose, rawText);
    return true;
  }

  // 동의 절차가 만료됨(3일 초과) — 재발송이 불가하므로 막지 않고 진행시킨다.
  return true;
}

async function handleUnsupported(session, text, requestedFeature) {
  const notice = '상담원을 연결해드릴게요. 잠시만 기다려주세요.';
  await botSay(session, notice, '상담원 연결 안내');
  await markNeedsAgent(session, text, requestedFeature);
}


// 신규 오더 접수 — 상담톡 로그 2년치를 분석해보니 고객 메시지의 47%가 `[출발지]…[도착지]`
// 형식의 정형 폼이고, 그 폼은 룰 파서만으로 98%가 필수 4종(출발지·도착지·차량번호·일시)까지
// 추출된다("탁송 상담톡 챗봇 고도화 기획서" 2.1). 그래서 LLM 분류보다 **먼저** 폼 파서를 태운다 —
// 더 빠르고, 더 정확하고, 실패하면 그때 LLM 경로로 떨어뜨리면 되기 때문이다.
async function handleOrderIntake(session, text, requestedFeature) {
  const notice = '신규 접수는 상담원 연결을 통해 도와드릴게요. 잠시만 기다려주세요.';
  await botSay(session, notice, '신규접수 안내');
  await markNeedsAgent(session, text, requestedFeature || '신규 오더 접수');
}

// 파싱된 접수 내용을 상담관리 카드의 "접수 마무리" 폼이 프리필하도록 draft_json.fields에 저장한다.
// 폼이 읽는 소스는 draft_json.fields → chat_suggestions.intake_json 뿐이라(routes/chat.js의
// /sessions/:id/intake-order), 카카오는 이걸 채우지 않으면 폼이 빈 채로 뜬다.
//
// 인계(상담원 연결) 때만이 아니라 대화 도중(봇이 아직 되묻는 중)에도 부른다 — 상담원이 그 세션
// 카드를 열면 지금까지 파악된 값이 이미 채워져 있게 하기 위해서다(웹 위젯이 대화 중 draft_json을
// 갱신하는 것과 같은 취지). 거래처(지사·법인·결제수단)는 세션에 로그인 사용자가 없어(user_id
// NULL) 매핑된 계정에서 채운다.
async function saveIntakeDraft(session, parsed) {
  try {
    const fields = toIntakeFields(parsed);
    const account = await resolveIntakeContextCached(session).catch(() => null);
    if (account) {
      if (account.branch_id) fields.branch_id = String(account.branch_id);
      if (account.requester_group_id) fields.requester_group_id = String(account.requester_group_id);
      if (account.payment_method_id) fields.payment_method_id = String(account.payment_method_id);
    }
    await db.run('UPDATE chat_sessions SET draft_json = ? WHERE id = ?', [JSON.stringify({ fields }), session.id]);
  } catch (e) {
    console.error('카카오 접수 폼 프리필 저장 실패(대화는 계속):', e.message);
  }
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

  await saveIntakeDraft(session, parsed);

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

// missing을 함께 남긴다 — 다음 메시지에서 "이번 답변으로 무엇이 채워졌는지"를 알아야
// 그 값을 되읽어줄 수 있다(고객은 자기가 보낸 차량번호가 제대로 들어갔는지 알 방법이 없다).
async function savePendingIntake(session, raw, missing, extra) {
  await db.run(
    `UPDATE chat_sessions SET intake_slots_json = ?,
     intake_updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [JSON.stringify({ raw, missing: missing || [], savedAt: Date.now(), ...(extra || {}) }), session.id]
  ).catch((e) => console.error('접수 슬롯 저장 실패:', e.message));
}

// 되묻기 답변으로 채워진 항목을 그대로 되읽어준다.
//
// 예전에는 차량번호를 보내면 아무 확인 없이 곧바로 다음 질문(주소 후보 등)으로 넘어갔다.
// 고객 입장에서는 자기가 보낸 번호가 들어갔는지, 오타로 읽혔는지 알 수 없다 — 접수가 끝난 뒤
// 잘못된 차량번호가 드러나면 되돌리는 비용이 훨씬 크다. 웹 접수 화면은 항목마다 이 확인을
// 이미 하고 있어서(public/js/ai-intake.js) 같은 규칙을 카카오에도 맞춘다.
async function announceFilledFields(session, pendingIntake, parsed) {
  const before = new Set((pendingIntake && pendingIntake.missing) || []);
  if (!before.size) return;

  const lines = [];
  if (before.has('vehicle_number') && parsed.vehicles && parsed.vehicles.length) {
    const v = parsed.vehicles[0];
    const label = [v.plate, v.type ? `(${v.type})` : null].filter(Boolean).join(' ');
    if (label) lines.push(`차량번호는 ${label}(으)로 확인했습니다.`);
  }
  if (before.has('when') && parsed.when) {
    const when = parsed.when.immediate
      ? '즉시'
      : [parsed.when.date, parsed.when.time].filter(Boolean).join(' ');
    if (when) lines.push(`일시는 ${when}(으)로 확인했습니다.`);
  }
  if (!lines.length) return;
  await botSay(session, lines.join('\n'), '되묻기 답변 확인');
}

async function clearPendingIntake(session) {
  await db.run('UPDATE chat_sessions SET intake_slots_json = NULL WHERE id = ?', [session.id])
    .catch((e) => console.error('접수 슬롯 정리 실패:', e.message));
}

// 주소 후보를 고르는 중인 상태를 저장한다 — 웹 접수 화면의 choose_address_candidate 단계와
// 같은 역할이다. 카카오는 화면이 없어 번호로 받는다.
async function savePendingAddressChoice(session, state) {
  await db.run(
    `UPDATE chat_sessions SET intake_slots_json = ?,
     intake_updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [JSON.stringify({ ...state, savedAt: Date.now() }), session.id]
  ).catch((e) => console.error('주소 선택 대기 저장 실패:', e.message));
}

// 접수 진행 전에 주소가 여러 곳으로 검색되면 물어본다. 물어봤으면 true를 돌려준다.
//
// 왜 묻는가: 예전에는 서버가 첫 검색 결과를 조용히 확정했다. "사당역"처럼 짧게 말하면 엉뚱한
// 지점으로 등록돼도 기사가 출발한 뒤에야 드러나는데, 그 비용이 한 번 더 묻는 것보다 훨씬 크다.
// 웹 접수 화면은 원래 이렇게 후보를 보여주고 고르게 하고 있었다 — 같은 규칙을 카카오에도 쓴다.
// cache(선택): geocodeAddress/createOrdersFromIntake와 같은 Map을 넘기면, 여기서 확인한 주소를
// 뒤이어 completeIntake가 다시 지오코딩할 때 네트워크 호출 없이 재사용한다(한 턴 안에서 같은
// 주소를 두 번 조회하던 중복 제거).
async function askAddressChoiceIfNeeded(session, parsed, mergedRaw, cache) {
  const sides = [
    { key: 'origin', label: '출발지', query: parsed.origin && parsed.origin.address },
    { key: 'destination', label: '도착지', query: parsed.destination && parsed.destination.address },
  ];

  // 출발지가 애매하면 도착지는 보지도 않고 그것부터 묻는다(우선순위는 그대로 유지) — 다만
  // 두 검색 자체는 서로 독립적이라, 판정에 쓰기 전에 미리 동시에 시작해둔다. 순서대로
  // 기다렸다가 시작하면 도착지 검색이 필요 없을 때도 있는데 왜 미리 시작하냐고 생각할 수
  // 있지만, 실측상 출발지만 애매한 경우보다 둘 다 확정까지 가는 경우(=둘 다 필요)가 더 흔해
  // 손해가 크지 않고, 애매한 쪽만 검색하는 순차 처리보다 최악의 경우(둘 다 확정) 응답이
  // 확실히 빠르다.
  const searches = sides.map((side) => (
    side.query
      ? searchAddressCandidates(side.query, { cache }).catch((e) => {
          console.error('주소 후보 검색 실패(자동 확정으로 진행):', e.message);
          return [];
        })
      : Promise.resolve([])
  ));
  const results = await Promise.all(searches);

  for (let i = 0; i < sides.length; i += 1) {
    const side = sides[i];
    if (!side.query) continue;
    const candidates = results[i];
    if (!needsDisambiguation(side.query, candidates)) continue;

    await savePendingAddressChoice(session, {
      raw: mergedRaw,
      awaiting: 'address_choice',
      side: side.key,
      sideLabel: side.label,
      query: side.query,
      candidates,
    });
    await botSay(session, buildCandidateListText(side.label, candidates), '주소 후보 확인');
    return true;
  }
  return false;
}

// 주소를 고른 뒤 원문을 다시 읽는다.
//
// 접수 원문은 두 갈래로 들어온다 — 붙여넣은 블록 폼과 자유 문장이다. 폼 파서(parseKakaoIntake)는
// 블록 폼 전용이라 자유 문장은 읽지 못한다. 예전에는 여기서 폼 파서만 돌려서, 자유 문장으로
// 접수한 고객이 주소 번호를 고르면 곧바로 "접수 내용을 다시 알려주시겠어요?"로 되돌아갔다
// (실측: "판교역 → 사당역" 접수에서 1번을 골랐는데 처음부터 다시 물음). 처음 이 대화를 읽었던
// 경로가 LLM 분류였으므로, 폼 파서가 실패하면 같은 경로로 한 번 더 읽는다.
async function reparseAfterAddressChoice(replacedRaw) {
  const formParsed = parseKakaoIntake(replacedRaw);
  if (formParsed.matched) return formParsed;

  const classified = await classifyAndExtract(replacedRaw, null, null).catch((e) => {
    console.error('주소 선택 후 재분류 실패:', e.message);
    return null;
  });
  if (!classified || classified.intent !== 'dispatch_order') return formParsed;
  // 경유지가 있으면 자유 문장 경로도 상담원에게 넘긴다(접수 서비스가 경유지를 지원하지 않는다) —
  // 그 판단은 호출부에 이미 있으므로 여기서는 파싱 결과만 돌려준다.
  return buildParsedFromClassified(classified, replacedRaw);
}

// 고객이 번호로 답했을 때 — 고른 주소를 원문에 반영해 접수를 이어간다.
// 못 알아들으면 한 번 더 안내한다(웹의 getDisambiguationClarifyText와 같은 역할).
async function handleAddressChoiceReply(session, pending, text) {
  const chosen = matchCandidateChoice(text, pending.candidates || []);
  if (!chosen) {
    await botSay(session, getClarifyText(pending.candidates), '주소 후보 재안내');
    return true;
  }

  // 고른 주소로 원문의 해당 주소를 바꿔 다시 파싱한다 — 슬롯을 따로 들고 다니지 않고 원문을
  // 고치는 이유는, 이후 경로(폼 파서 → 접수)가 전부 원문 기준으로 동작하기 때문이다.
  const replacedRaw = String(pending.raw || '').replace(pending.query, chosen.address);
  const parsed = await reparseAfterAddressChoice(replacedRaw);
  if (!parsed.matched) {
    await clearPendingIntake(session);
    await botSay(session, '접수 내용을 다시 알려주시겠어요?', '주소 선택 후 재파싱 실패');
    return true;
  }

  await botSay(session, `${pending.sideLabel}를 "${chosen.label}"로 확인했습니다.`, '주소 확정 안내');
  if (!parsed.complete) {
    await savePendingIntake(session, replacedRaw, parsed.missing);
    const addressPreview = await previewIntakeAddresses(parsed);
    await botSay(session, buildMissingQuestion(parsed.missing, parsed, addressPreview), '접수 되묻기');
    return true;
  }
  // 이 턴에서 지오코딩한 결과를 남은 확인 단계들이 공유한다(중복 조회 제거).
  const geoCache = new Map();
  // 남은 쪽(도착지)도 애매하면 이어서 묻는다.
  if (await askAddressChoiceIfNeeded(session, parsed, replacedRaw, geoCache)) return true;
  return completeIntake(session, parsed, replacedRaw, geoCache);
}

// 접수 폼 처리 — 처리했으면 true, 폼이 아니면 false를 돌려준다(호출부가 다음 경로로 넘긴다).
async function tryHandleIntake(session, text) {
  let parsed = parseKakaoIntake(text);
  let mergedRaw = text;

  if (!parsed.matched) {
    // 폼이 아니면, 진행 중인 접수의 보충 정보일 수 있다 — 있으면 원문에 이어붙여 재파싱한다.
    const pending = await loadPendingIntake(session);
    if (!pending) return false;
    // 주소 후보를 고르는 중이면 이 답변은 보충 정보가 아니라 "번호 선택"이다.
    if (pending.awaiting === 'address_choice') return handleAddressChoiceReply(session, pending, text);
    // 연락처를 묻는 중이면 "1"/"2"(보기 선택) 또는 직접 입력한 번호다.
    if (pending.awaiting === 'origin_contact' || pending.awaiting === 'destination_contact') {
      return handleContactReply(session, pending, text);
    }
    mergedRaw = pending.raw + '\n' + text;
    parsed = parseKakaoIntake(mergedRaw);
    if (!parsed.matched) return false;
  }

  if (!parsed.complete) {
    await savePendingIntake(session, mergedRaw, parsed.missing);
    await saveIntakeDraft(session, parsed); // 대화 도중에도 카드 폼에 지금까지 값 반영
    const addressPreview = await previewIntakeAddresses(parsed);
    const question = buildMissingQuestion(parsed.missing, parsed, addressPreview);
    await botSay(session, question, '접수 되묻기');
    return true;
  }
  await saveIntakeDraft(session, parsed); // 필수 항목이 다 찬 시점의 값도 반영

  // 이 턴에서 지오코딩한 결과를 아래 확인 단계들이 공유한다 — 주소 후보 확인·도선 판정·
  // 실제 접수 등록이 같은 주소를 각자 다시 조회하던 중복을 없앤다.
  const geoCache = new Map();

  // 필수 항목이 다 있어도 주소가 애매하면 먼저 확정한다 — 등록 후에 고치는 비용이 더 크다.
  if (await askAddressChoiceIfNeeded(session, parsed, mergedRaw, geoCache)) return true;

  // 접수는 반드시 동의가 있어야 한다(사용자 확정 규칙) — 동의가 오면 저장해둔 내용으로 이어간다.
  return completeIntake(session, parsed, mergedRaw, geoCache);
}

// 파싱이 끝난 접수를 실제로 등록한다 — 블록 폼(parseKakaoIntake)과 자유 문장(Gemini 추출)이
// 같은 경로를 쓰도록 분리했다. 등록 여부·인계 사유 판단이 두 갈래로 갈리면 한쪽만 고쳐지는
// 일이 생긴다.
// 도선(배편) 구간이 있으면 차종은 필수다.
//
// 도선료는 차종에 따라 달라져서(lib/ferryFare.js의 요금표가 차종별이다) 차종 없이 접수하면
// 도선료가 빠진 오더가 만들어진다. 웹 화면은 요금 안내 단계에서 이미 되묻고 있는데
// (public/js/order-form.js, ai-intake.js) 카카오에는 그 관문이 없었다.
//
// 도착지가 주소 후보 선택으로 나중에 확정되는 경우까지 잡으려면 접수 직전에 봐야 한다 —
// 그래서 completeIntake 안, 실제 등록 바로 앞에 둔다(사용자 확정 규칙).
//
// 판정은 시도(市道)로 한다. 카카오 길찾기 응답으로 도선 구간을 알아낼 수 있을 것 같지만
// 실제로는 안 된다 — 서울→제주를 물어도 도로명에 페리 표시가 없고 육로 거리만 돌아온다(실측).
// 등록된 도선 노선이 전부 제주 왕래(완도–제주, 삼천포–제주)이므로, 한쪽만 제주면 배를 타야 한다.
const FERRY_SIDO = '제주';

async function needsFerry(originAddress, destinationAddress, cache) {
  const [from, to] = await Promise.all([
    geocodeAddress(originAddress, cache).catch(() => null),
    geocodeAddress(destinationAddress, cache).catch(() => null),
  ]);
  // 어느 한쪽이라도 좌표를 못 찾으면 판단하지 않는다 — 확실하지 않은 이유로 접수를 세우면
  // 멀쩡한 요청이 통째로 막힌다.
  if (!from || !to) return false;
  const fromJeju = String(from.sido || '').includes(FERRY_SIDO);
  const toJeju = String(to.sido || '').includes(FERRY_SIDO);
  // 제주 안에서만 움직이는 건(제주→제주) 배를 타지 않는다.
  return fromJeju !== toJeju;
}

async function requireVehicleTypeForFerry(session, parsed, rawText, cache) {
  const hasVehicleType = (parsed.vehicles || []).some((v) => v && String(v.type || '').trim());
  if (hasVehicleType) return false;

  const origin = parsed.origin && parsed.origin.address;
  const destination = parsed.destination && parsed.destination.address;
  if (!origin || !destination) return false;

  const ferry = await needsFerry(origin, destination, cache).catch((e) => {
    console.error('도선 구간 확인 실패(접수는 계속 진행):', e.message);
    return false;
  });
  if (!ferry) return false;

  await savePendingIntake(session, rawText, parsed.missing, { awaiting: 'vehicle_type' });
  await botSay(
    session,
    '도선(배편) 구간이 포함된 경로입니다. 도선료가 차종에 따라 달라져 차종을 알려주셔야 접수할 수 있습니다.\n(예: 그랜저)',
    '도선 차종 필수 안내'
  );
  return true;
}

// ── 연락처(출발지·도착지) 필수 확인 ──────────────────────────────────────────
// 탁송은 기사가 차를 인계·인수할 때 연락할 번호가 있어야 한다 — 출발지·도착지 연락처가 없으면
// 등록하지 않고 물어본다. 매핑된 계정이면 "주문자 연락처"(계정 담당자/동의 번호)를 1번 보기로,
// 도착지에는 "출발지 연락처"도 보기로 제시해 한 글자로 답할 수 있게 한다.

// 표시·저장용 전화번호. 10~11자리면 하이픈 포맷, 아니면 null(유효하지 않은 입력).
function asPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length !== 10 && digits.length !== 11) return null;
  return normalizePhone(digits);
}

// "주문자 연락처" — 동의로 받은 번호(external_phone)를 우선, 없으면 매핑된 계정 담당자의 번호.
async function loadRequesterPhone(session, account) {
  const consent = asPhone(session && session.external_phone);
  if (consent) return consent;
  if (account && account.user_id) {
    const u = await db.get('SELECT phone FROM users WHERE id = ?', [account.user_id]).catch(() => null);
    return asPhone(u && u.phone);
  }
  return null;
}

function buildOriginContactQuestion(requesterPhone) {
  const lines = ['출발지 담당자 연락처를 알려주세요.'];
  if (requesterPhone) {
    lines.push(`1. 주문자 연락처 ${requesterPhone} 사용이면 1번을 입력하시고`);
    lines.push('다르면 직접 입력해주세요');
  }
  lines.push('(예 : 010-1234-5678)');
  return lines.join('\n');
}

function buildDestContactQuestion(originContact, requesterPhone) {
  const lines = ['도착지(받는분) 연락처를 알려주세요.'];
  lines.push(`1. 출발지 연락처 ${originContact} 사용이면 1번`);
  if (requesterPhone) lines.push(`2. 주문자 연락처 ${requesterPhone} 사용이면 2번`);
  lines.push('다르면 직접 입력해주세요');
  lines.push('(예 : 010-1234-5678)');
  return lines.join('\n');
}

// 연락처 수집 대기 상태 — 파싱 결과 전체를 함께 들고 있다가, 번호를 받으면 이어서 등록한다.
async function savePendingContact(session, parsed, rawText, awaiting, ctx) {
  await db.run(
    `UPDATE chat_sessions SET intake_slots_json = ?,
     intake_updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [JSON.stringify({
      raw: rawText, awaiting, parsedDraft: parsed,
      requesterPhone: (ctx && ctx.requesterPhone) || null,
      originContact: (ctx && ctx.originContact) || null,
      savedAt: Date.now(),
    }), session.id]
  ).catch((e) => console.error('연락처 대기 상태 저장 실패:', e.message));
}

// 출발지 → 도착지 순으로, 빠진 연락처를 하나씩 묻는다. 물어봤으면 true(여기서 멈춤), 다 있으면 false.
async function requireContacts(session, parsed, rawText, account) {
  const requesterPhone = await loadRequesterPhone(session, account);
  if (!parsed.origin || !parsed.origin.contact) {
    await savePendingContact(session, parsed, rawText, 'origin_contact', { requesterPhone });
    await botSay(session, buildOriginContactQuestion(requesterPhone), '출발지 연락처 요청');
    return true;
  }
  const originContact = asPhone(parsed.origin.contact) || parsed.origin.contact;
  if (!parsed.destination || !parsed.destination.contact) {
    await savePendingContact(session, parsed, rawText, 'destination_contact', { requesterPhone, originContact });
    await botSay(session, buildDestContactQuestion(originContact, requesterPhone), '도착지 연락처 요청');
    return true;
  }
  return false;
}

// 연락처 되묻기 답변 처리 — "1"/"2"는 보기 선택, 그 외는 직접 입력한 번호로 본다.
async function handleContactReply(session, pending, text) {
  const parsed = pending.parsedDraft;
  if (!parsed || !parsed.origin || !parsed.destination) {
    await clearPendingIntake(session);
    return false; // 안전장치 — 드래프트가 없으면 일반 경로로 되돌린다.
  }
  const trimmed = String(text || '').trim();
  const isOrigin = pending.awaiting === 'origin_contact';

  let phone = null;
  if (isOrigin) {
    if (trimmed === '1' && pending.requesterPhone) phone = pending.requesterPhone;
    else phone = asPhone(trimmed);
  } else if (trimmed === '1' && pending.originContact) phone = pending.originContact;
  else if (trimmed === '2' && pending.requesterPhone) phone = pending.requesterPhone;
  else phone = asPhone(trimmed);

  if (!phone) {
    const reAsk = isOrigin
      ? buildOriginContactQuestion(pending.requesterPhone)
      : buildDestContactQuestion(pending.originContact, pending.requesterPhone);
    await botSay(session, `연락처를 알아듣지 못했습니다.\n${reAsk}`, '연락처 재안내');
    return true;
  }

  if (isOrigin) parsed.origin = { ...parsed.origin, contact: phone };
  else parsed.destination = { ...parsed.destination, contact: phone };
  await saveIntakeDraft(session, parsed); // 방금 받은 연락처까지 카드 폼에 반영
  await botSay(session, `${isOrigin ? '출발지' : '도착지'} 연락처를 ${phone}(으)로 확인했습니다.`, '연락처 확인');

  // 남은 연락처가 있으면 completeIntake가 이어서 물어보고, 다 찼으면 등록으로 넘어간다.
  return completeIntake(session, parsed, pending.raw, new Map());
}

// cache(선택): askAddressChoiceIfNeeded가 이 턴에서 이미 지오코딩한 결과가 있으면 여기서
// 다시 네트워크를 타지 않고 재사용한다. 안 넘기면(다른 호출부) createOrdersFromIntake가
// 내부적으로 새 Map을 만들어 최소한의 재사용(분리 접수 루프 안에서만)은 그대로 유지한다.
async function completeIntake(session, parsed, rawText, cache) {
  // 접수 주체(거래처)를 먼저 확인한다 — 동의를 청할지 여부가 여기에 달려 있다.
  const account = await resolveIntakeContextCached(session);

  // ── 개인정보 동의 게이트 ────────────────────────────────────────────────
  // 매핑된 계정(채널 매핑 또는 동의 번호로 찾은 거래처)이 있으면 접수 주체가 이미 확정된
  // 것이므로 동의 버튼을 띄우지 않는다. 매핑이 없을 때만, 누구의 요청인지 확인하기 위해
  // 동의(성함+연락처)를 받는다. (동의는 미매핑 채널의 신원 확인 수단이지, 매핑 고객에게까지
  // 매번 받아야 하는 절차가 아니다 — 사용자 확정 규칙.)
  if (!account) {
    if (!await ensurePersonalConsent(session, 'intake', rawText)) return true; // 방금 버튼 발송
    if (!hasPersonalConsent(session)) {
      // 버튼은 보냈지만 동의 전(또는 거부) — 등록하지 않고 상담원에게 넘긴다. 버튼은 대화에
      // 남아 있어, 눌러주면 resume_after_consent가 그때 자동 접수한다(그래서 pending 유지).
      await handoffWithParsedSlots(session, parsed, rawText, '개인정보 미동의 — 상담원 확정 필요(동의 시 자동 접수)');
      return true;
    }
    // 동의로 번호를 받았지만 그 번호로도 거래처를 못 찾았다 → 아래 handoff(거래처 확인 불가).
  }

  if (await requireVehicleTypeForFerry(session, parsed, rawText, cache)) return true;

  if (!account || !account.auto_register) {
    // 매핑이 없거나 자동 등록을 켜지 않은 채널 — 파싱만 하고 상담원에게 넘긴다(연락처는 상담원이 확인).
    await clearPendingIntake(session);
    const reason = !account
      ? (consentPending(session) ? '개인정보 동의 대기' : '거래처 확인 불가')
      : '자동 등록 꺼짐';
    await handoffWithParsedSlots(session, parsed, rawText, reason);
    return true;
  }

  // 탁송 자동 접수는 출발지·도착지 연락처가 필수 — 빠졌으면 등록하지 않고 물어본다(번호 선택지
  // 제공). 다 채워졌으면 false를 돌려주고 그대로 등록으로 넘어간다.
  if (await requireContacts(session, parsed, rawText, account)) return true;

  let result;
  try {
    result = await createOrdersFromIntake({ session, account, parsed, cache });
  } catch (e) {
    console.error('카카오 상담톡 자동 접수 실패:', e.message);
    result = { ok: false, reason: 'exception', detail: e.message };
  }

  await clearPendingIntake(session);

  // 자동 등록에 성공했으면 카드 폼 프리필(draft_json)을 비운다 — 이미 오더가 만들어졌는데
  // 폼이 채워진 채로 남으면 상담원이 같은 건을 한 번 더 등록할 수 있다.
  if (result.ok) {
    await db.run('UPDATE chat_sessions SET draft_json = NULL WHERE id = ?', [session.id])
      .catch((e) => console.error('접수 완료 후 폼 프리필 정리 실패:', e.message));
  }

  // 나뉜 건 중 출발 시각을 모르는 것이 있으면 고객에게 묻는다 — 임의로 앞 건과 같은 시각을
  // 넣으면 잘못된 시각으로 접수된다. 날짜는 이미 알고 나뉜 것이라(그게 분리 조건이다) 시각만 묻는다.
  if (!result.ok && result.reason === 'split_schedule_missing') {
    const detail = result.detail || {};
    const target = (detail.parts || []).find((p) => (detail.missingSchedule || []).includes(p.splitSeq));
    if (target) {
      await savePendingIntake(session, rawText, parsed.missing, { awaiting: 'split_schedule' });
      await botSay(session, buildScheduleQuestion(target), '분리 접수 시각 확인');
      return true;
    }
  }

  if (!result.ok) {
    // 등록을 못 한 이유는 고객에게 그대로 노출하지 않는다(내부 사정) — 상담원 인계 사유로만 남긴다.
    const labels = {
      origin_geocode_failed: '출발지 주소 좌표 확인 실패',
      operating_hours: '운영시간 밖 요청',
      incomplete_form: '필수 항목 누락',
      auto_register_off: '자동 등록 꺼짐',
      no_account: '채널 매핑 없음',
      waypoint_unsupported: '경유지 포함(같은 날 경유는 자동 접수 불가)',
      split_schedule_missing: '분리 접수 시각 미확인',
      exception: '자동 접수 오류',
    };
    await handoffWithParsedSlots(session, parsed, rawText, labels[result.reason] || result.reason);
    return true;
  }

  await botSay(session, result.message, '접수 확인');
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
  const account = await resolveIntakeContextCached(session).catch(() => null);
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

  // 조회는 LLM과 콜마너를 왕복해서 몇 초씩 걸린다. 그동안 아무 말이 없으면 고객은 못 알아들은
  // 줄 알고 다음 질문을 덧붙이는데, 그러면 새 질문으로 다시 분류돼 앞 조회가 헛돈다(실사용에서
  // 실제로 그랬다). 먼저 기다려달라고 알린다.
  //
  // 카카오는 보낸 말풍선을 고칠 수 없어서(발신 API에 메시지 수정·삭제가 없다) 이 안내는 그대로
  // 남고 결과가 새 말풍선으로 온다. 웹 위젯처럼 점이 깜빡이는 표시를 쓸 방법은 없다.
  await botSay(session, '요청하신 내용을 확인하고 있습니다. 잠시만 기다려주세요.', '조회 대기 안내');

  const result = await runDispatchAgent({ user, sessionId: session.id, text, history });
  if (!result || !result.handled || !result.message) return false;

  await botSay(session, result.message, '배차 도우미 응답');
  // 이 대화가 도우미와 이어지고 있다는 표시. 다음 메시지를 접수 요청으로 오해하지 않기 위해서다.
  await markMcpTurn(session);
  return true;
}

async function processBotTurn(session, text) {
  if (SMALL_TALK_RE.test(text)) return;

  // 인사·자기소개는 지식검색으로 보내지 않는다 — 웹 위젯과 같은 규칙(lib/smallTalk.js).
  const smallTalk = getSmalltalkMessage(text);
  if (smallTalk) {
    await botSay(session, smallTalk, '스몰토크 응답');
    return;
  }

  if (ESCALATION_RE.test(text)) {
    // 상담원 연결 앞에서는 동의를 요구하지 않는다 — 사람이 붙어서 직접 물어보면 된다.
    // 동의 버튼은 조회·접수 시점에만 쓴다(사용자 확정 규칙).
    return handleUnsupported(session, text, '사고·클레임 문의');
  }

  // 정형 접수 폼이 이 채널 트래픽의 절반이라 LLM 분류보다 먼저 태운다.
  const handled = await tryHandleIntake(session, text);
  if (handled) return;

  // 운영시간 문의도 LLM 분류보다 먼저 처리한다. 분기 안(intent==='faq')에 두었더니 실측에서
  // "고객센터 운영시간은?"이 unsupported로 분류돼 그대로 상담원 연결로 넘어갔다 — 답을 우리가
  // 데이터로 갖고 있는 질문에 사람을 부르는 건 낭비다. 키워드 판정이라 LLM 호출도 아낀다.
  if (await tryAnswerOperatingHours(session, text)) return;

  // 사진 요청도 마찬가지로 분류보다 먼저 본다 — 우리가 이미 갖고 있는 파일을 건네는 일이라
  // 상담원을 부를 이유가 없다. 이 대화로 접수한 오더가 있을 때만 반응한다.
  if (await tryAnswerPhotoRequest(session, text).catch((e) => {
    console.error('카카오 사진 요청 처리 실패:', e.message);
    return false;
  })) return;

  // 주행거리도 우리가 이미 갖고 있는 값이다(기사가 계기판 사진과 함께 적어둔 숫자).
  if (await tryAnswerOdometer(session, text).catch((e) => {
    console.error('카카오 주행거리 처리 실패:', e.message);
    return false;
  })) return;

  // 자유 문장 되묻기 중이면 앞선 원문에 이어붙여 분류한다 — 폼 파서는 블록 형식만 매칭하므로
  // 보충 답변("지금요")만 넘기면 앞서 받은 출발지·도착지·차량이 사라져 처음부터 다시 묻게 된다.
  const pendingIntake = await loadPendingIntake(session);
  const intakeText = pendingIntake && pendingIntake.raw && pendingIntake.purpose !== 'agent'
    ? pendingIntake.raw + '\n' + text
    : text;

  // 도우미와 대화 중이면 분류보다 먼저 그쪽으로 돌린다 — 이어지는 답이 새 접수로 읽히면
  // 방금 물어본 맥락이 사라진다.
  if (isMcpFollowUp(session)) {
    const continued = await tryDispatchAgent(session, text).catch((e) => {
      console.error('카카오 배차 도우미 이어가기 실패:', e.message);
      return false;
    });
    if (continued) return;
  }

  // 분류(Gemini)가 도는 동안 접수 주체(거래처)도 미리 확정해둔다 — 조회(unsupported)·접수
  // (dispatch_order) 분기에서 곧 필요하다. 세션에 캐시되므로 그 분기에서 다시 부르면 이미
  // 끝나 있어, ~1초 걸리는 분류와 DB 조회가 겹쳐 순차 지연이 사라진다. (fire-and-forget)
  resolveIntakeContextCached(session).catch(() => null);

  // 지식검색(임베딩 API 호출)은 원문 텍스트만 있으면 시작할 수 있어, 의도분류(Gemini) 결과를
  // 기다리지 않고 미리 같이 시작해둔다 — 웹 위젯(routes/orders.js)에 이미 있는 패턴과 같다.
  // faq가 아닌 의도로 판정되면 버리지만, 임베딩 호출 자체는 가벼워서 그 낭비보다 FAQ 응답
  // 지연이 줄어드는 이득이 크다(웹 쪽 실측: 순차 대비 응답 지연 절반 가까이 감소).
  const knowledgeSearchPromise = searchKnowledgeBase(text, { limit: 1, threshold: 0.7 })
    .catch((e) => { console.error('카카오 상담톡 FAQ 사전 검색 실패:', e.message); return []; });

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
    // 조회를 못 한 이유가 "누구인지 몰라서"일 수 있다 — 동의로 번호를 받으면 거래처가 매칭돼
    // 그다음부터는 조회가 된다(linkUserKeyToAccount). 그래서 조회 실패 자리에서는 동의를 청한다.
    // 이미 버튼을 보냈으면 재촉하지 않고 그대로 상담원에게 넘어간다.
    if (!await ensurePersonalConsent(session, 'lookup', text)) return;
    return handleUnsupported(session, text, classified.requestedFeature);
  }
  if (classified.intent === 'faq') {
    // 요금문의·지식검색은 동의 없이 응답한다. 답을 못 찾아 상담원으로 넘길 때만 동의를 요구한다.
    // 구간이 있는 요금 문의는 지식검색보다 먼저 실제 요금표로 계산한다.
    if (await tryAnswerFare(session, text, classified)) return;
    const answered = await tryAnswerFaq(session, text, knowledgeSearchPromise);
    if (answered) return;
    // 답을 못 찾아 사람에게 넘길 뿐이다 — 여기서 동의를 받을 이유가 없다.
    await handleUnsupported(session, text, null);
    return;
  }
  // dispatch_order / proxy_order / daily_driver_order — 폼 파서가 못 잡은 자유 문장 접수다.
  // Gemini가 뽑은 필드를 폼과 같은 모양으로 바꿔 같은 등록 경로를 태운다. 탁송(dispatch_order)만
  // 대상이다 — 프리미엄/일일기사는 오더 컬럼과 요금 체계가 달라 이번 범위 밖이다.
  // 경유지가 있어도 여기서 막지 않는다. 수행일이 갈리면 구간마다 별도 오더로 나뉘어(lib/orderSplit.js)
  // 각 건이 A→B가 되므로 경유지가 사라질 일이 없다. 나뉘지 않는 경우(같은 날 경유)는
  // createOrdersFromIntake가 waypoint_unsupported로 되돌려 상담원에게 넘긴다 — 판단을 한 곳에
  // 모아둔다. 예전에는 여기서 미리 막아서, 날짜가 갈린 접수까지 전부 상담원에게 갔다.
  if (classified.intent === 'dispatch_order') {
    const parsed = buildParsedFromClassified(classified, intakeText);
    if (!parsed.complete) {
      // 빠진 항목만 되묻는다 — 폼 경로와 같은 문구를 쓴다. 다음 메시지는 위 intakeText 병합으로
      // 앞 원문에 이어붙여 다시 분류하므로, 고객이 전체를 다시 쓸 필요가 없다.
      //
      // 동의는 여기서 받지 않는다(폼 경로와 동일) — 동의 말풍선은 세션당 1회뿐이라, 아직 등록할지도
      // 모르는 단계에서 써버리면 정작 등록 직전에 다시 띄울 수 없다. completeIntake가 요구한다.
      // 이번 답변으로 채워진 항목이 있으면 먼저 되읽어준다 — 그 뒤에 남은 항목을 묻는다.
      await announceFilledFields(session, pendingIntake, parsed);
      await savePendingIntake(session, intakeText, parsed.missing);
      await saveIntakeDraft(session, parsed); // 대화 도중에도 카드 폼에 지금까지 값 반영
      const addressPreview = await previewIntakeAddresses(parsed);
      const question = buildMissingQuestion(parsed.missing, parsed, addressPreview);
      await botSay(session, question, '접수 되묻기(자유문장)');
      return;
    }
    // 필수 항목이 다 찼을 때도 이번 답변으로 채워진 값은 되읽어준다 — 여기서 확인을 건너뛰면
    // 차량번호를 보낸 고객이 아무 응답 없이 주소 후보 질문만 받는다.
    await announceFilledFields(session, pendingIntake, parsed);
    // 이 턴에서 지오코딩한 결과를 아래 두 단계가 공유한다 — 같은 주소를 각자 다시 조회하지 않는다.
    const geoCache = new Map();
    // 자유 문장도 주소가 애매하면 먼저 확정한다 — 폼 경로와 같은 규칙이다. 여기가 빠져 있으면
    // "판교역에서 사당역까지"처럼 지명만 말한 접수가 첫 검색 결과로 조용히 등록된다.
    if (await askAddressChoiceIfNeeded(session, parsed, intakeText, geoCache)) return;
    await completeIntake(session, parsed, intakeText, geoCache);
    return;
  }

  // 접수 자동화가 다루지 못하는 형태(경유지 미지원 등)라 상담원에게 넘긴다. 다만 이것도 접수다 —
  // 누구의 요청인지 모른 채 오더를 만들 수는 없으므로 여기서는 동의를 청한다(사용자 확정 규칙:
  // 동의 버튼은 조회와 접수 자리에서 나온다). 사고·클레임이나 FAQ 실패처럼 "그냥 사람에게
  // 넘기는" 경우와는 다르다.
  // 이미 버튼을 보냈으면 재촉하지 않고 그대로 상담원에게 넘어간다(ensurePersonalConsent).
  if (!await ensurePersonalConsent(session, 'intake', text)) return;
  return handleOrderIntake(session, text, classified.requestedFeature);
}

// 텍스트가 없는 수신 메시지를 대화 이력에 남길 때 쓸 표시. 섹션 타입(image/file/…)을 그대로
// 보여줘 상담원이 "무엇이 왔는지"는 알 수 있게 한다. 첨부 URL은 남기지 않는다 — 카카오 첨부
// 링크는 만료되고, 원본 보관은 사진 파이프라인(기획서 Phase 3)에서 따로 다룰 문제다.
const NON_TEXT_LABEL = { image: '사진', file: '파일', video: '동영상', audio: '음성' };

function describeNonTextMessage(body) {
  const types = [];
  if (body && Array.isArray(body.chapters)) {
    body.chapters.forEach((chapter) => {
      (chapter.sections || []).forEach((section) => {
        if (section && section.type && section.type !== 'text') types.push(section.type);
      });
    });
  }
  if (!types.length) return '[내용 없는 메시지]';
  const counts = types.reduce((acc, t) => { acc[t] = (acc[t] || 0) + 1; return acc; }, {});
  return '[' + Object.entries(counts)
    .map(([t, n]) => `${NON_TEXT_LABEL[t] || t}${n > 1 ? ' ' + n + '건' : ''}`)
    .join(', ') + ']';
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

  // 고객 발화를 **가장 먼저** 저장하고 브로드캐스트한다. 이 앞에 조회를 끼워 넣으면 그만큼
  // 상담원 화면에 늦게 뜬다 — 예전에는 재전송 판정·반복 판정·이벤트 로그(모두 DB 왕복)를
  // 먼저 돌리느라 저장이 뒤로 밀렸다. 그 셋은 "봇이 답할지"를 정하는 판단일 뿐이라 응답 뒤로
  // 미뤄도 되고, 상담원이 고객 질문을 보는 일이 그보다 급하다.
  // (AI 초안 생성은 원래도 응답 뒤였다 — 초안 때문에 메시지가 늦은 게 아니다.)
  const placeholder = text ? null : describeNonTextMessage(req.body);
  const stored = await insertMessage(session.id, 'user', text || placeholder);

  // 여기까지가 화면에 뜨는 데 필요한 전부다. 나머지(감사로그·중복판정·봇 처리·초안)는
  // 응답 뒤로 넘긴다(계획서 8.4).
  res.json({ code: 200, message: 'SUCCESS' });

  runAfterResponse((async () => {
    // 중복 판정은 **봇이 두 번 답하지 않게 하는 용도로만** 쓴다. 고객 발화는 이미 저장됐다 —
    // 상담원 화면에서 사라지는 것이 중복 말풍선이 하나 더 보이는 것보다 훨씬 나쁘다.
    const serialNumber = req.body && req.body.meta && req.body.meta.serialNumber;
    const resent = text ? await isResentEvent(serialNumber) : false;
    const repeated = resent || (text && !serialNumber ? await looksRepeated(keys.userKey, text) : false);
    if (resent) console.warn(`카카오 상담톡 재전송 감지 — 저장은 하고 봇 응답만 생략 (session=${session.id}, serial=${serialNumber})`);

    await logEvent({ sessionId: session.id, eventType: 'message', keys, body: req.body, headers, handled: true });

    if (!text) {
      // 사진·파일만 온 경우 — 내용은 못 읽어도 "보냈다"는 사실은 위에서 이미 남겼다.
      if (kakaoConsult.hasNonTextSection(req.body) && session.status !== 'agent_active') {
        const notice = '사진·파일은 아직 확인이 어려워요. 상담원을 연결해드릴게요.';
        await botSay(session, notice, '비텍스트 메시지 안내');
        await markNeedsAgent(session, placeholder, '사진/파일 문의');
      }
      return;
    }
    if (repeated) {
      console.warn(`카카오 상담톡 반복 문구 — 저장만 하고 봇 응답은 생략 (session=${session.id})`);
      return;
    }
    await handleBotTurnOrSuggestion(session, text);
  })().catch((e) => console.error('카카오 상담톡 수신 후처리 실패:', e.message)), 'inbound_followup');
}));

// 봇 응대 / 상담원 도우미 초안 — 수신 후처리에서 갈라지는 지점만 따로 뺐다.
async function handleBotTurnOrSuggestion(session, text) {
  // 상담원이 이미 응대 중인 세션은 봇이 끼어들지 않는다(기존 웹 위젯 규칙과 동일).
  if (session.status !== 'agent_active') {
    // 동의 요청은 첫 메시지에 무조건 보내지 않는다 — 요금문의·지식검색만 하고 끝나는 고객에게는
    // 불필요하다. 상담원 연결이나 접수처럼 실제로 신원이 필요한 시점에만 요청한다
    // (ensurePersonalConsent, 사용자 확정 규칙).
    try {
      await processBotTurn(session, text);
    } catch (e) {
      console.error('카카오 상담톡 봇 처리 실패:', e.message);
      await markNeedsAgent(session, text, null);
    }
    return;
  }
  // 상담원 응대 중 — 봇은 고객에게 답하지 않지만(기존 규칙 유지) 답변 초안은 만들어 둔다.
  // 상담원 화면에 "채택 대기"로 뜨고, 승인해야 고객에게 나간다(lib/agentAssist.js).
  await createAgentSuggestion(session, text);
}

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
        await botSay(resumeSession, notice, '동의 후 상담원 연결');
        await markNeedsAgent(resumeSession, raw,
          isNewCustomer ? '상담원 연결(미등록 고객 — 계정 등록 필요)' : '상담원 연결(동의 완료)');
        return;
      }
      if (purpose === 'lookup') {
        // 조회를 못 해서 동의를 청했던 경우 — 번호를 받았으니 다시 시도한다. 방금 저장한
        // external_phone이 반영된 세션을 써야 거래처가 매칭된다(resumeSession은 저장 전 값이다).
        const fresh = await db.get('SELECT * FROM chat_sessions WHERE id = ?', [resumeSession.id]).catch(() => null);
        const looked = await tryDispatchAgent(fresh || resumeSession, raw).catch((e) => {
          console.error('동의 후 조회 재시도 실패:', e.message);
          return false;
        });
        if (looked) return;
        await markNeedsAgent(resumeSession, raw,
          isNewCustomer ? '주문 조회(미등록 고객 — 계정 등록 필요)' : '주문 조회(동의 후 거래처 확인 필요)');
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

// 능동 통보(배차 완료 / 배차 취소) — 매분 크론이 부른다.
//
// 웹훅 수신과 달리 중계서버가 아니라 우리 크론이 부르는 것이라, 이 파일의 공유 시크릿이 아니라
// 다른 크론들과 같은 CRON_SECRET으로 검증한다.
router.get('/cron/order-notifications', asyncHandler(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: 'CRON_SECRET 환경변수가 설정되어 있지 않습니다.' });
  if (req.get('Authorization') !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const result = await runKakaoOrderNotifications();
  res.json(result);
}));

module.exports = router;
// 상담원 무응답으로 봇에게 응대를 넘길 때(routes/chat.js), 고객이 이미 한 발화를 그대로
// 봇 경로에 태우기 위해 노출한다.
module.exports.processBotTurn = processBotTurn;
// 반복 판정에서 빼야 하는 짧은 답인지 — 이 판정이 헐거우면 고객이 번호로 고른 답에 봇이
// 침묵한다. DB 없이 확인할 수 있게 노출한다(scripts/check-kakao-repeat-guard.js).
module.exports.isTooShortForRepeatCheck = isTooShortForRepeatCheck;
