// 하이브리드 챗봇 대화 세션 — 고객측 메시지 영속화/실시간 수신 + 관리자측 모니터링/개입.
// 봇이 처리 못하는 요청(intent: unsupported)이 오면 세션을 needs_agent로 바꾸고 관리자에게 푸시 알림을 보낸다.
// 관리자가 답장을 보내면 세션이 agent_active로 바뀌고, 그 이후 해당 세션은 봇 호출 없이 상담원이 직접 응대한다.
// 메시지 실시간 전달은 Supabase Realtime Broadcast를 서버(서비스 롤 키)만 사용하고,
// 브라우저에는 SSE로 중계한다 — Supabase 키가 브라우저에 노출되지 않는다.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole, keepSessionAlive } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
// Gemini/MCP를 부르는 경로는 사용량을 제한한다(middleware/aiRateLimit.js의 주석 참조).
const { aiRateLimit } = require('../middleware/aiRateLimit');
const { notify } = require('../lib/push');
const { kstNow } = require('../lib/period');
const { getEffectivePaymentMethods } = require('../lib/branchPolicy');
const { runDispatchAgent, checkDispatchDelay } = require('../lib/mcpDispatchAgent');
const { buildSuggestion, toIntakeFields } = require('../lib/agentAssist');
const { runWebIntakeTurn } = require('../lib/webIntakeTurn');
const kakaoConsult = require('../lib/kakaoConsult');
const { describeMappedAccount } = require('../lib/kakaoIntakeService');
const { logIntegrationErrorAsync } = require('../lib/integrationLog');
const {
  broadcastMessage, broadcastReadReceipt, broadcastSessionListChanged, openSessionStream, openSessionListStream, closeChannel,
  startAgentPresence, isAnyAgentOnline, listOnlineAgentNames, PRESENCE_STALE_SECONDS,
} = require('../lib/realtimeChat');

const router = express.Router();
// 초안 자동 발송 크론 — 세션 로그인 사용자가 없는 서버 대 서버 호출이라 requireAuth 앞에 둔다
// (routes/callmanerSync.js와 같은 방식). 상담원이 화면을 보고 있지 않을 때도 돌아야 해서
// 브라우저 타이머가 아니라 서버에서 처리한다.
function checkCronAuth(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: 'CRON_SECRET 환경변수가 설정되어 있지 않습니다.' });
  if (req.get('Authorization') !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// 별도 라우터로 뺀다 — server.js가 '/'에 마운트한 authRoutes/dashboardRoutes가 모든 경로를
// 가로채기 때문에, 이 라우터를 그보다 **먼저** 등록해야 세션 없는 크론 호출이 로그인 화면으로
// 리다이렉트되지 않는다(/callmaner, /kakao-consult와 같은 이유).
const cronRouter = express.Router();
cronRouter.get('/cron/auto-send-suggestions', checkCronAuth, asyncHandler(async (req, res) => {
  const sent = await autoSendPendingSuggestions();
  // 같은 크론에서 유휴 세션도 정리한다 — 둘 다 "상담원이 이어받지 않은 대화"를 다루는 일이다.
  const released = await releaseIdleAgentSessions();
  res.json({ ok: true, sent: sent.length, details: sent, released });
}));

router.use(requireAuth);

const DEFAULT_SESSION_CREATE_LIMIT = 20;
const parsedTestSessionCreateLimit = Number.parseInt(process.env.TEST_SESSION_CREATE_LIMIT || '', 10);
const SESSION_CREATE_LIMIT = process.env.NODE_ENV === 'test' && Number.isInteger(parsedTestSessionCreateLimit) && parsedTestSessionCreateLimit > 0
  ? parsedTestSessionCreateLimit
  : DEFAULT_SESSION_CREATE_LIMIT;
const SESSION_CREATE_WINDOW_SQL = `to_char(now() at time zone 'Asia/Seoul' - interval '1 hour', 'YYYY-MM-DD HH24:MI:SS')`;

// 카카오 상담톡 고객은 b2b-car 계정이 없어(chat_sessions.user_id가 NULL) users 조인 결과가
// 전부 NULL이다. 목록·상세 화면이 하나같이 `user_name || '-'`로 그리기 때문에, 실제로 대화가
// 오간 세션인데도 "#672 · -"처럼 빈 행으로 보여 상담원이 찾을 수가 없었다. 표시 지점이 여섯
// 군데(EJS 목록/표/상세 + Next.js 카드/표/상세)라 화면마다 고치면 또 갈라지므로, 조회 시점에
// 채널을 반영한 표시값을 만들어 내려보낸다. 연락처는 접수 폼에서 받은 external_phone으로 채운다.
// 개인정보 제공동의를 받은 카카오 고객은 실제 이름이 external_name에 들어온다
// (routes/kakaoConsult.js /receive/personal_info) — 있으면 그 이름을 먼저 쓴다.
//
// 동의 전에는 이름이 없어 모든 고객이 "카카오 상담톡 고객"으로 똑같이 보인다 — 목록에 여러
// 세션이 나란히 있으면 누가 누구인지 구분할 수가 없다. 그 경우 UserKey를 함께 보여준다.
// UserKey는 채널별로 고정이라(명세서 용어집) 같은 고객의 재방문을 알아보는 데도 쓸 수 있다.
//
// 동의 후(external_name이 채워진 뒤)에도 UserKey는 계속 보여준다(실사용 지적) — 카카오 채널
// 매핑(kakao_consult_accounts)을 이 UserKey로 등록해야 하는데, 동의하는 순간 이름만 보이고
// UserKey가 사라지면 관리자가 그 값을 어디서도 다시 볼 수 없다. 이미 매핑된 세션은 화면(카드/
// 목록)이 이 값 대신 mapped_group_name(법인명)을 우선 보여주므로(sessionDisplayName,
// CardBoard.js·session_list.ejs) 실제로는 "매핑 전"에만 이 UserKey 병기가 눈에 띈다.
const CUSTOMER_NAME_SQL = `COALESCE(
  u.name,
  CASE WHEN cs.channel = 'kakao' AND cs.external_name IS NOT NULL THEN
    cs.external_name ||
    COALESCE(' (' || NULLIF(COALESCE(cs.external_user_key, cs.kakao_user_key), '') || ')', '')
  END,
  cs.external_name,
  CASE WHEN cs.channel = 'kakao' THEN
    '카카오 상담톡 고객' ||
    COALESCE(' (' || NULLIF(COALESCE(cs.external_user_key, cs.kakao_user_key), '') || ')', '')
  END
)`;
const CUSTOMER_ROLE_SQL = `COALESCE(u.role, CASE WHEN cs.channel = 'kakao' THEN '카카오' END)`;
const CUSTOMER_PHONE_SQL = `COALESCE(u.phone, cs.external_phone)`;

// 상담원 도우미 — 상담원이 응대 중인 세션의 고객 메시지마다 답변 초안을 만들어 둔다.
// 고객 응답 경로를 붙잡지 않도록 fire-and-forget으로 돌리고(초안이 몇 초 늦게 떠도 무방),
// 실패는 삼킨다 — 초안이 없다고 상담 자체가 막히면 안 된다.
function createSuggestionAsync(session, text, userMessageId) {
  (async () => {
    // 요금 초안은 지사 요금표로 계산한다(세션 소유자의 소속 지사).
    const owner = session.user_id
      ? await db.get('SELECT branch_id FROM users WHERE id = ?', [session.user_id]).catch(() => null)
      : null;
    const suggestion = await buildSuggestion(text, { branchId: owner && owner.branch_id, sessionId: session.id });
    if (!suggestion) return; // 확신이 없으면 제안하지 않는다(소음 방지)

    // 같은 세션에 쌓인 이전 대기 제안은 닫는다 — 고객이 새 메시지를 보냈으면 직전 초안은 낡았다.
    await db.run(
      `UPDATE chat_suggestions SET status = 'dismissed',
       decided_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
       WHERE session_id = ? AND status = 'pending'`,
      [session.id]
    );

    await db.run(
      `INSERT INTO chat_suggestions (session_id, user_message_id, kind, suggested_text, intake_json)
       VALUES (?, ?, ?, ?, ?)`,
      [session.id, userMessageId || null, suggestion.kind, suggestion.text,
        suggestion.intake ? JSON.stringify(suggestion.intake) : null]
    );
    // 별도 실시간 신호는 보내지 않는다 — 메시지 스트림에 흘리면 클라이언트가 그걸 대화
    // 말풍선으로 그려버린다(그 순간 제안이 고객에게 보이는 것과 같아진다). 상담원 화면은
    // 고객 메시지가 도착할 때 초안을 따로 조회한다.
  })().catch((e) => console.error('상담원 도우미 초안 생성 실패:', e.message));
}

function defaultReservedDateTime() {
  const now = kstNow();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    reserved_date: `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`,
    reserved_time: `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`,
  };
}

function extractWaypointsFromSummary(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg.message !== 'string' || msg.sender !== 'bot') continue;
    if (msg.message.indexOf('▪ 경유지:') === -1) continue;

    const lines = String(msg.message).split('\n');
    const waypoints = [];
    lines.forEach((line) => {
      const m = line.match(/^▪\s*경유지:\s*(.+?)(?:\s+\(([^)]+)\))?\s*$/);
      if (!m) return;
      waypoints.push({
        address: (m[1] || '').trim(),
        contact: (m[2] || '').trim() || null,
      });
    });
    if (waypoints.length) return waypoints;
  }
  return [];
}

// 고객 자신의 세션인지 확인(관리자는 모든 세션 열람 가능) — 없으면 응답까지 처리하고 null을 반환한다.
async function loadOwnedSession(req, res) {
  const sessionId = Number(req.params.sessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    res.status(400).json({ error: '유효하지 않은 세션 ID입니다.' });
    return null;
  }
  const session = await db.get('SELECT * FROM chat_sessions WHERE id = ?', [sessionId]);
  if (!session) { res.status(404).json({ error: '세션을 찾을 수 없습니다.' }); return null; }
  if (req.session.user.role !== 'admin' && session.user_hidden_at) {
    res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
    return null;
  }
  if (session.user_id !== req.session.user.id && req.session.user.role !== 'admin') {
    res.status(403).json({ error: '접근 권한이 없습니다.' });
    return null;
  }
  return session;
}

function sseHeaders(res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
}

// 메시지 브로드캐스트는 응답을 기다리게 하지 않는다(fire-and-forget) — Realtime이 느려도
// 이미 DB에 저장된 메시지에 대한 응답은 즉시 나가야 한다. 실패해도 로그만 남긴다.
function broadcastMessageAsync(sessionId, message) {
  broadcastMessage(sessionId, message).catch((e) => console.error('브로드캐스트 실패:', e.message));
}

function broadcastSessionListChangedAsync(payload) {
  broadcastSessionListChanged(payload).catch((e) => console.error('세션 목록 갱신 신호 실패:', e.message));
}

function wantsJsonResponse(req) {
  return req.xhr || req.is('application/json') || ((req.get('accept') || '').indexOf('application/json') >= 0);
}

function broadcastReadReceiptAsync(sessionId, reader) {
  broadcastReadReceipt(sessionId, reader).catch((e) => console.error('읽음 신호 실패:', e.message));
}

// 세션 단위 일괄 읽음 처리는 반드시 await해서 써야 한다 — 호출 직후 같은 요청 안에서
// 메시지 목록을 SELECT해 응답하는 경로들이 있는데, fire-and-forget으로 두면 그 SELECT가
// UPDATE보다 먼저 끝나버려 방금 읽음 처리한 메시지도 응답에는 '미읽음'으로 나가는 경합이 있었다.
async function markAgentMessagesReadByUser(sessionId) {
  const { rowCount } = await db.run(
    `UPDATE chat_messages
     SET read_by_user_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
     WHERE session_id = ? AND sender = 'agent' AND read_by_user_at IS NULL`,
    [sessionId]
  );
  if (rowCount > 0) broadcastReadReceiptAsync(sessionId, 'user');
}

// 카카오톡 고객 화면의 "1"(안읽음)을 지우는 방법은 메시지를 실제로 보내는 것뿐이다 —
// 상담톡 명세서(v1.5.6)의 읽음 관련 API는 /receive/seen_info 하나이고 그것도 "고객이 우리
// 메시지를 읽었다"는 반대 방향이다. 용어집에도 "상담원이 배정되었는지 여부는 카카오에서는 알 수
// 없습니다"라고 못박혀 있다.
//
// 그래서 상담원이 실제로 읽은 순간에만 한 줄 보낸다. 판단 기준은 아래 UPDATE의 rowCount다 —
// 0이면 이번에 새로 읽은 메시지가 없다는 뜻(재열람)이라 보내지 않는다. 상담원이 목록만 훑어본
// 경우에도 이 함수 자체가 불리지 않으므로, "읽지도 않았는데 읽음으로 표시되는" 일이 없다.
const AGENT_READ_NOTICE = '상담원이 확인했습니다. 곧 답변드리겠습니다.';

// 같은 안내를 이 간격 안에 두 번 보내지 않는다. 상담원 화면이 주기적으로 폴링하며 읽음 처리를
// 하기 때문에, 제한이 없으면 고객이 메시지를 보낼 때마다 "상담원이 확인했습니다"가 따라붙는다.
// 고객 입장에서는 답을 기다리는데 같은 말만 반복되는 꼴이라 오히려 신뢰를 깎는다.
const AGENT_READ_NOTICE_COOLDOWN_MINUTES = 5;

async function shouldSendAgentReadNotice(sessionId) {
  // 최근에 같은 안내를 이미 보냈으면 생략.
  const recentNotice = await db.get(
    `SELECT id FROM chat_messages
     WHERE session_id = ? AND sender = 'system' AND message = ?
       AND created_at >= to_char((now() at time zone 'Asia/Seoul') - interval '${AGENT_READ_NOTICE_COOLDOWN_MINUTES} minutes', 'YYYY-MM-DD HH24:MI:SS')
     LIMIT 1`,
    [sessionId, AGENT_READ_NOTICE]
  ).catch(() => null);
  if (recentNotice) return false;

  // 상담원이 최근에 실제로 답장을 보냈으면 생략 — 답장 자체가 "확인했다"는 신호이고,
  // 카카오 쪽 안읽음 표시도 그 답장으로 이미 지워진다.
  const recentReply = await db.get(
    `SELECT id FROM chat_messages
     WHERE session_id = ? AND sender = 'agent'
       AND created_at >= to_char((now() at time zone 'Asia/Seoul') - interval '${AGENT_READ_NOTICE_COOLDOWN_MINUTES} minutes', 'YYYY-MM-DD HH24:MI:SS')
     LIMIT 1`,
    [sessionId]
  ).catch(() => null);
  return !recentReply;
}

async function notifyKakaoAgentRead(sessionId) {
  const session = await db.get(
    `SELECT id, channel, status, kakao_service_key, kakao_user_key, kakao_event_key
     FROM chat_sessions WHERE id = ?`,
    [sessionId]
  );
  if (!session || session.channel !== 'kakao') return;
  // "상담원이 확인했습니다"는 고객이 상담원 연결을 요청한 세션에서만 보낸다. 봇이 응대 중인
  // 세션(status='bot')을 상담원이 목록에서 카드만 열어봐도 이 안내가 나가면, 고객은 부르지도
  // 않은 상담원이 붙은 줄 알게 된다(실사용 지적). needs_agent(요청 후 진입)·agent_active(이미
  // 응대 중)에서만 보낸다.
  if (session.status !== 'needs_agent' && session.status !== 'agent_active') return;
  if (!await shouldSendAgentReadNotice(sessionId)) return;

  const result = await kakaoConsult.sendMessage(session, AGENT_READ_NOTICE);
  if (!result.ok) {
    logIntegrationErrorAsync({
      source: 'kakao', operation: 'send', refType: 'chat_session', refId: Number(sessionId),
      message: result.error, context: { label: '상담원 읽음 알림' },
    });
    return;
  }
  // 발송된 것만 대화 이력에 남긴다 — 실패한 안내가 이력에만 남아 "보냈다"고 오해하지 않도록.
  const inserted = await db.get(
    `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'system', ?) RETURNING *`,
    [sessionId, AGENT_READ_NOTICE]
  );
  broadcastMessageAsync(sessionId, inserted);
}

async function markUserMessagesReadByAgent(sessionId) {
  const { rowCount } = await db.run(
    `UPDATE chat_messages
     SET read_by_agent_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
     WHERE session_id = ? AND sender = 'user' AND read_by_agent_at IS NULL`,
    [sessionId]
  );
  if (rowCount > 0) {
    broadcastReadReceiptAsync(sessionId, 'agent');
    // 카카오 발신은 외부 호출이라 응답을 붙잡지 않는다(이 함수는 목록/스트림 응답 경로에서 await된다).
    notifyKakaoAgentRead(sessionId).catch((e) => console.error('카카오 읽음 알림 실패:', e.message));
  }
}

// 실시간 스트림으로 방금 도착한 메시지 한 건을 상대가 이미 화면을 보고 있는 상태에서 즉시 읽음
// 처리 — 이 경로는 응답을 SELECT하지 않는 fire-and-forget 콜백 안이라 await 없이 써도 안전하다.
function markSingleMessageReadByUserAsync(messageId, sessionId) {
  db.run(
    `UPDATE chat_messages
     SET read_by_user_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
     WHERE id = ? AND sender = 'agent' AND read_by_user_at IS NULL`,
    [messageId]
  ).then(({ rowCount }) => { if (rowCount > 0) broadcastReadReceiptAsync(sessionId, 'user'); })
    .catch((e) => console.error('고객 단건 읽음 처리 실패:', e.message));
}

function markSingleMessageReadByAgentAsync(messageId, sessionId) {
  db.run(
    `UPDATE chat_messages
     SET read_by_agent_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
     WHERE id = ? AND sender = 'user' AND read_by_agent_at IS NULL`,
    [messageId]
  ).then(({ rowCount }) => { if (rowCount > 0) broadcastReadReceiptAsync(sessionId, 'agent'); })
    .catch((e) => console.error('상담원 단건 읽음 처리 실패:', e.message));
}

async function getNeedsAgentCount() {
  const row = await db.get(`SELECT COUNT(*) AS cnt FROM chat_sessions WHERE status = 'needs_agent'`);
  return Number(row.cnt);
}

// 상담원이 0명 -> 1명이 되는 순간, 대기 중이던 needs_agent 세션에 시스템 메시지로 알려준다.
async function notifyWaitingSessions() {
  const waiting = await db.all(`SELECT id FROM chat_sessions WHERE status = 'needs_agent'`);
  for (const s of waiting) {
    const inserted = await db.get(
      `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'system', ?) RETURNING *`,
      [s.id, '상담원이 접속했습니다. 곧 답변드리겠습니다.']
    );
    broadcastMessageAsync(s.id, inserted);
  }
}

// ---------------- 고객측: 세션 생성 ----------------
router.post('/session', asyncHandler(async (req, res) => {
  const u = req.session.user;
  const recent = await db.get(
    `SELECT COUNT(*) AS cnt FROM chat_sessions WHERE user_id = ? AND created_at > ${SESSION_CREATE_WINDOW_SQL}`,
    [u.id]
  );
  if (Number(recent.cnt) >= SESSION_CREATE_LIMIT) {
    return res.status(429).json({ error: '너무 많은 상담 세션이 생성되었습니다. 잠시 후 다시 시도해주세요.' });
  }
  const inserted = await db.run(`INSERT INTO chat_sessions (user_id, status) VALUES (?, 'bot') RETURNING id`, [u.id]);
  broadcastSessionListChangedAsync();
  res.json({ sessionId: Number(inserted.lastInsertRowid) });
}));

// ---------------- 관리자: 상담원 접속 여부(Presence) ----------------
// 반드시 아래 '/:sessionId/...' 와일드카드 라우트보다 먼저 등록해야 한다.
// 순서가 바뀌면 '/agent-presence/stream' 요청이 '/:sessionId/stream'에 매칭되어
// "agent-presence" 문자열이 세션 ID로 잘못 쓰이게 된다(실제로 겪은 버그).
// 상담 관리 화면(목록/상세)을 열어두는 동안 이 연결이 유지되며, 그동안 "접속 중"으로 집계된다.
// 이 연결 하나로 사이드바 전역 배지/알림음까지 겸한다(연결을 페이지마다 따로 늘리지 않기 위해) —
// 최초 접속 시 현재 상담대기(needs_agent) 건수를 한 번 보내고, 이후 세션 목록이 바뀔 때마다(같은
// 브로드캐스트 채널을 재사용) 다시 세어서 보낸다. initial 플래그로 "최초 동기화"와 "실제 변화"를
// 구분해야 클라이언트가 페이지 진입 시점에 이미 대기 중이던 건으로 잘못 알림음을 울리지 않는다.
router.get('/agent-presence/stream', requireRole('admin'), asyncHandler(async (req, res) => {
  const u = req.session.user;
  sseHeaders(res);
  res.write(':\n\n');

  // 클라이언트가 연결이 채 열리기도 전(readyState=CONNECTING)에 빠르게 페이지를 이동해버리면,
  // 브라우저가 EventSource.close()를 불러도 req/res의 'close' 이벤트가 서버에 아예 전달되지
  // 않는 경우가 실측으로 확인됐다(메뉴를 빠르게 5~10번 연속 이동하며 재현) — 그 결과 정리 로직이
  // 영영 안 불리고 chat_agent_presence 행과 하트비트 setInterval이 무한정 쌓였다. 그래서 이벤트
  // 기반 정리(있으면 더 빠르게 정리됨)에만 기대지 않고, keep-alive 핑을 실제 소켓에 써보고
  // 실패하면(연결이 죽어있으면) 그 자리에서 직접 정리하는 이중 안전장치를 둔다. 아직 초기화 전인
  // 자원(presence 등)을 close 이벤트가 먼저 참조하는 일이 없도록 변수를 미리 선언해둔다.
  let closed = false;
  let cleaned = false;
  let keepAlive = null;
  let presence = null;
  let listStreamHandle = null;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    closed = true;
    if (keepAlive) clearInterval(keepAlive);
    if (presence) presence.stop();
    if (listStreamHandle) closeChannel(listStreamHandle);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);

  keepAlive = setInterval(() => {
    if (res.writableEnded || res.destroyed || !res.writable) return cleanup();
    keepSessionAlive(req);
    try { res.write(':\n\n'); } catch (e) { cleanup(); }
  }, 20000);

  presence = await startAgentPresence(u.id, u.name);
  if (closed) return presence.stop();
  if (!presence.wasAnyoneOnlineBefore) {
    notifyWaitingSessions().catch((e) => console.error('상담원 접속 알림 실패:', e.message));
  }

  const sendNeedsAgentCount = async (initial) => {
    try {
      const count = await getNeedsAgentCount();
      res.write(`data: ${JSON.stringify({ type: 'needs_agent_count', count, initial: !!initial })}\n\n`);
    } catch (e) { console.error('상담대기 건수 조회 실패:', e.message); }
  };
  sendNeedsAgentCount(true);
  listStreamHandle = openSessionListStream((payload) => {
    sendNeedsAgentCount(false);
    if (payload && payload.event === 'needs_agent') {
      res.write(`data: ${JSON.stringify({ type: 'new_agent_call', sessionId: payload.sessionId, customerName: payload.customerName, message: payload.message })}\n\n`);
    }
  });
  if (closed) closeChannel(listStreamHandle);
}));

// 세션 목록 변경 신호는 더 이상 여기서 별도 SSE로 내려주지 않는다 — 관리자 페이지에 이미 상시
// 열려 있는 '/agent-presence/stream' 연결이 같은 신호를 실어 보내고, 리스트/카드뷰는 그 이벤트를
// 재사용한다(브라우저 호스트당 동시연결 제한 때문에 뷰 전환을 반복하면 로딩이 지연되는 문제가 있었음).

// ---------------- 고객측: 사용자 메시지 저장 ----------------
router.post('/:sessionId/user-message', asyncHandler(async (req, res) => {
  const session = await loadOwnedSession(req, res);
  if (!session) return;
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: '메시지를 입력해주세요.' });

  const inserted = await db.get(
    `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'user', ?) RETURNING *`,
    [session.id, text]
  );
  await db.run(`UPDATE chat_sessions SET updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`, [session.id]);
  broadcastMessageAsync(session.id, inserted);
  // 상담관리 목록이 열려 있으면 스스로 다시 그리도록 신호를 준다 — 세션을 선택해 열어두지
  // 않은 상담원에게는 이 신호가 새 메시지를 알아채는 유일한 경로다.
  broadcastSessionListChangedAsync({ event: 'new_message', sessionId: session.id });

  // 상담원 응대 중이면 봇이 답하지는 않되(기존 규칙 유지) 답변 초안은 만들어 둔다 —
  // 상담원 화면에 "채택 대기"로 뜨고, 승인해야 고객에게 나간다.
  if (session.status === 'agent_active') {
    createSuggestionAsync(session, text, inserted.id);
  }

  res.json({ status: session.status });
}));

// ---------------- 고객측: AI 접수 대화 판단(서버 이전, Stage A — 탁송만) ----------------
// 카카오 상담톡 채널이 이미 서버에서 하고 있는 판단(다음 질문 결정·요금/운영시간 응답·확인
// 요약)을 웹 로그인 사용자용으로도 제공한다. fallthrough:true로 오면 이 요청은 다루지 않은
// 것이니(탁송이 아니거나 프리미엄/일일기사 등) 클라이언트는 기존 로컬 판단 경로를 그대로
// 탄다 — dispatch-agent와 같은 안전장치.
router.post('/:sessionId/intake-turn', aiRateLimit, asyncHandler(async (req, res) => {
  const session = await loadOwnedSession(req, res);
  if (!session) return;
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, fallthrough: true, reason: 'empty_text' });

  // 상담원이 붙은 세션은 봇이 끼어들지 않는다(기존 규칙과 동일).
  if (session.status !== 'bot') return res.json({ ok: false, fallthrough: true, reason: 'not_bot_status' });

  let result;
  try {
    result = await runWebIntakeTurn({ user: req.session.user, session, text });
  } catch (e) {
    console.error('웹 AI 접수 턴 처리 실패:', e.message);
    logIntegrationErrorAsync({ source: 'web_intake', operation: 'intake_turn', refType: 'chat_session', refId: session.id, message: e.message });
    return res.json({ ok: false, fallthrough: true, reason: 'exception' });
  }

  if (result.fallthrough || !result.replyText) {
    // 턴 엔진이 이미 분류를 돌렸으면(faq/unsupported 등) 그 결과를 함께 넘긴다 — 클라이언트가
    // 뒤이어 부르는 /ai-intake/parse가 같은 문장에 Gemini를 다시 태우지 않게 한다(응답 지연 절반).
    return res.json({ ok: true, fallthrough: true, classified: result.classified || null });
  }

  const inserted = await db.get(
    `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'bot', ?) RETURNING *`,
    [session.id, result.replyText]
  );
  broadcastMessageAsync(session.id, inserted);

  if (result.closeSession) {
    await db.run(`UPDATE chat_sessions SET status = 'closed' WHERE id = ?`, [session.id]);
    broadcastSessionListChangedAsync();
  }

  res.json({
    ok: result.ok,
    fallthrough: false,
    message: result.replyText,
    awaitingConfirmation: !!result.awaitingConfirmation,
    closeSession: !!result.closeSession,
    status: result.closeSession ? 'closed' : session.status,
    // 화면 우측 "AI 파싱 결과 자동 반영 폼"이 쓴다(AiIntakeClient.js onOrderPrefill) — 서버가
    // 이번 턴에 필수 항목을 다 채운 경우에만 있다(runWebIntakeTurn이 parsed를 실어준다).
    intake: result.parsed ? toIntakeFields(result.parsed) : null,
  });
}));

// ---------------- 고객측: 배차 주문 도우미(콜마너 MCP 도구 호출) ----------------
// 지금까지 intent:'unsupported'(주문 조회/변경/취소 등)로 분류되면 곧바로 상담원 연결로 넘어갔다.
// 그 앞단에 이 라우트를 두고, MCP 도구로 실제 처리가 가능한 요청이면 봇이 직접 답한다.
// handled:false로 돌아오면 클라이언트는 기존 상담원 연결 경로를 그대로 탄다(기능 회귀 없음).
router.post('/:sessionId/dispatch-agent', aiRateLimit, asyncHandler(async (req, res) => {
  const session = await loadOwnedSession(req, res);
  if (!session) return;
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ handled: false, reason: 'empty_text' });

  // 상담원이 이미 붙은 세션은 봇이 끼어들지 않는다(기존 봇 호출 규칙과 동일).
  if (session.status === 'agent_active') return res.json({ handled: false, reason: 'agent_active' });

  const history = await db.all(
    `SELECT sender, message FROM chat_messages
     WHERE session_id = ? AND sender IN ('user', 'bot') AND message IS NOT NULL
     ORDER BY id DESC LIMIT 12`,
    [session.id]
  );
  history.reverse();
  // 방금 저장된 이번 메시지는 runDispatchAgent가 별도로 받으므로 히스토리 끝에서 제거한다.
  if (history.length && history[history.length - 1].sender === 'user' && history[history.length - 1].message === text) {
    history.pop();
  }

  try {
    const result = await runDispatchAgent({ user: req.session.user, sessionId: session.id, text, history });
    return res.json(result);
  } catch (e) {
    console.error('배차 주문 도우미 처리 실패:', e.message);
    return res.json({ handled: false, reason: 'error', error: e.message });
  }
}));

// ---------------- 고객측: 배차 지연 감지(요금 인상 선제 제안) ----------------
// 챗봇 화면이 열려 있는 동안 주기적으로 호출된다. 기사 미배정 상태로 접수 후 5분이 지난 주문이
// 있으면 요금 인상 확인 질문을 돌려준다(실행은 고객이 "네"라고 답할 때 /dispatch-agent가 처리).
router.post('/:sessionId/dispatch-delay-check', asyncHandler(async (req, res) => {
  const session = await loadOwnedSession(req, res);
  if (!session) return;
  if (session.status !== 'bot') return res.json({ offer: false, reason: 'not_bot_session' });

  try {
    const result = await checkDispatchDelay({ user: req.session.user, sessionId: session.id });
    return res.json(result);
  } catch (e) {
    console.error('배차 지연 확인 실패:', e.message);
    return res.json({ offer: false, reason: 'error' });
  }
}));

// ---------------- 고객측: 봇 응답 저장 (+ 상담원 호출 처리) ----------------
router.post('/:sessionId/bot-message', asyncHandler(async (req, res) => {
  const session = await loadOwnedSession(req, res);
  if (!session) return;
  const { message, needsAgent, requestedFeature, draftState, closeSession } = req.body;

  // 다른 메뉴로 이동했다 돌아왔을 때 대화 내용뿐 아니라 오더접수 진행 상태(입력 필드/phase 등)도
  // 이어갈 수 있도록, 매 턴마다 클라이언트가 보내주는 진행 상태 스냅샷을 저장한다(fire-and-forget).
  if (draftState !== undefined) {
    db.run('UPDATE chat_sessions SET draft_json = ? WHERE id = ?', [JSON.stringify(draftState), session.id])
      .catch((e) => console.error('세션 draft 저장 실패:', e.message));
  }

  let finalMessage = message || null;
  let agentOnline = null;

  if (needsAgent && session.status === 'bot') {
    agentOnline = await isAnyAgentOnline();
    // "상담원 연결" 자체를 요청한 경우("아직 준비 중인 기능"이 아니라 지금 하려는 바로 그 행동)에는
    // "'상담원 연결' 기능은 아직 준비 중입니다"라는 모순된 문구를 빼고 바로 안내한다.
    const isDirectAgentRequest = requestedFeature === '상담원 연결';
    const featurePrefix = (requestedFeature && !isDirectAgentRequest) ? `'${requestedFeature}' ` : '';
    const featureNotice = isDirectAgentRequest ? '' : `${featurePrefix}기능은 아직 준비 중입니다. `;
    finalMessage = agentOnline
      ? `${featureNotice}상담원 연결해드릴게요. 잠시만 기다려주세요.`
      : `${featureNotice}지금은 응답 시간이 아니거나 응답할 수 있는 상담원이 없습니다. 문의 내용을 남겨주시면 확인 후 연락드리겠습니다.`;

    await db.run(
      `UPDATE chat_sessions SET status = 'needs_agent', requested_feature = ?,
       updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
      [requestedFeature || null, session.id]
    );
    // 알림센터 팝업에 바로 띄울 내용(고객업체명/직전 고객 메시지)까지 함께 넘긴다.
    const [lastUserMsg, customerInfo] = await Promise.all([
      db.get(`SELECT message FROM chat_messages WHERE session_id = ? AND sender = 'user' ORDER BY id DESC LIMIT 1`, [session.id]),
      db.get(`SELECT g.name AS company_name FROM users u LEFT JOIN groups_tbl g ON g.id = u.group_id WHERE u.id = ?`, [session.user_id]),
    ]);
    broadcastSessionListChangedAsync({
      event: 'needs_agent',
      sessionId: session.id,
      customerName: (customerInfo && customerInfo.company_name) || req.session.user.name,
      message: (lastUserMsg && lastUserMsg.message) || requestedFeature || '상담원 연결을 요청했습니다.',
    });
    try {
      const u = req.session.user;
      await notify({
        eventType: 'agent_call', excludeUserId: u.id,
        title: '🔔 상담원 연결 요청',
        body: `${u.name}님이 상담원 연결을 요청했습니다${requestedFeature ? ' (' + requestedFeature + ')' : ''}.`,
        url: `/chat/sessions/${session.id}`,
      });
    } catch (e) { console.error('상담원 호출 알림 실패:', e.message); }
  }

  if (finalMessage) {
    // 클라이언트(public/js/ai-intake.js retryBotMessageSave)는 응답을 못 받으면(네트워크 유실 등)
    // 최대 2회 재시도한다 — 문제는 서버가 이미 INSERT까지 마친 뒤에 응답만 유실된 경우도 구분 없이
    // 재시도되어 같은 봇 메시지가 그대로 두 번 저장된다는 점이다. 실사용 사고: 일일기사 인사말/
    // "연락처를 다시 말씀해주세요?"/"최종 목적지 주소를 다시 알려주세요." 등이 매번 정확히 두 번씩
    // 찍혔다. 마이그레이션 없이 막기 위해, 같은 세션의 direct 직전 봇 메시지가 짧은 시간 안에 같은
    // 텍스트면 재시도로 보고 새로 넣지 않고 그 메시지를 그대로 재사용한다.
    const recentDuplicate = await db.get(
      `SELECT * FROM chat_messages WHERE session_id = ? AND sender = 'bot' AND message = ?
       AND created_at >= to_char((now() at time zone 'Asia/Seoul') - interval '10 seconds', 'YYYY-MM-DD HH24:MI:SS')
       ORDER BY id DESC LIMIT 1`,
      [session.id, finalMessage]
    ).catch(() => null);
    const inserted = recentDuplicate || await db.get(
      `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'bot', ?) RETURNING *`,
      [session.id, finalMessage]
    );
    if (!recentDuplicate) broadcastMessageAsync(session.id, inserted);
  }

  // 오더 등록이 완료된 세션은 닫는다 — 안 그러면 다음 방문 시 세션 복원 기능이 방금 끝난
  // 오더의 진행 상태(phase/필드 값)를 그대로 되살려서 새 오더 접수를 방해하게 된다.
  if (closeSession) {
    await db.run(`UPDATE chat_sessions SET status = 'closed' WHERE id = ?`, [session.id]);
    broadcastSessionListChangedAsync(); // 관리자 목록 화면이 열려 있으면 '종료'로 바로 반영되도록
  }

  res.json({
    ok: true,
    message: finalMessage,
    agentOnline,
    status: closeSession ? 'closed' : (needsAgent && session.status === 'bot' ? 'needs_agent' : session.status),
  });
}));

// ---------------- 고객측: 실시간 수신(SSE, Realtime Broadcast 중계) ----------------
router.get('/:sessionId/stream', asyncHandler(async (req, res) => {
  const session = await loadOwnedSession(req, res);
  if (!session) return;

  await markAgentMessagesReadByUser(session.id);

  sseHeaders(res);
  const streamHandle = openSessionStream(session.id, (payload) => {
    if (payload && payload.sender === 'agent' && payload.id) markSingleMessageReadByUserAsync(payload.id, session.id);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  });
  const keepAlive = setInterval(() => { keepSessionAlive(req); res.write(':\n\n'); }, 20000);
  req.on('close', () => { clearInterval(keepAlive); closeChannel(streamHandle); });
}));

// ---------------- 고객측: 재연결 시 유실 메시지 보충용(끊긴 동안 놓친 것만) ----------------
router.get('/:sessionId/messages', asyncHandler(async (req, res) => {
  const session = await loadOwnedSession(req, res);
  if (!session) return;
  await markAgentMessagesReadByUser(session.id);
  const since = Number(req.query.since) || 0;
  const messages = await db.all('SELECT * FROM chat_messages WHERE session_id = ? AND id > ? ORDER BY id', [session.id, since]);
  res.json({ messages, status: session.status });
}));

// ---------------- 관리자: 세션 목록 ----------------
router.get('/guide/data.json', requireRole('admin'), asyncHandler(async (req, res) => {
  res.json({ currentUser: req.session.user });
}));

router.get('/guide', requireRole('admin'), asyncHandler(async (req, res) => {
  res.render('chat/guide', { title: '상담 운영안' });
}));

// 우측 상단 알림센터 패널이 새로고침 후에도 "현재 대기 중인" 상담을 바로 보여주기 위한 요약 조회.
// 반드시 아래 '/sessions/:id...' 와일드카드보다 먼저 등록해야 한다(이 파일의 다른 라우트들과 같은 이유).
router.get('/sessions/needs-agent-summary', requireRole('admin'), asyncHandler(async (req, res) => {
  const rows = await db.all(`
    SELECT cs.id, cs.updated_at, cs.channel,
      COALESCE(g.name, ${CUSTOMER_NAME_SQL}) AS customer_name,
      (SELECT message FROM chat_messages WHERE session_id = cs.id AND sender = 'user' ORDER BY id DESC LIMIT 1) AS message
    FROM chat_sessions cs
    LEFT JOIN users u ON u.id = cs.user_id
    LEFT JOIN groups_tbl g ON g.id = u.group_id
    WHERE cs.status = 'needs_agent'
    ORDER BY cs.updated_at DESC
    LIMIT 30
  `);
  res.json({ sessions: rows });
}));

// 목록이 바뀌었는지만 싸게 확인하는 "버전". 목록 전체를 다시 읽지 않고 이 값만 비교한다.
//
// 왜 필요한가: 관리자 화면은 10초마다 card-data.json을 부르는데, 그 조회가 세션마다 상관
// 서브쿼리 2개(last_message, COUNT(*))에 LATERAL 조인까지 돈다. 세션 168개면 서브쿼리 336개다.
// 실측: card-data.json 120~155ms vs 이 버전 쿼리 15ms. 더 중요한 것은 증가 곡선이다 —
// 목록 조회는 세션 수에 비례해 무거워지지만(O(세션 수)) 이 버전은 인덱스 조회 네 번이라
// 세션이 늘어도 그대로다(O(1)). 폴링의 대부분은 "바뀐 것 없음"으로 끝나므로 그 경우의 비용이
// 전체 비용을 정한다.
//
// 무엇을 담아야 하는가 — 카드 목록이 달라지는 모든 원인을 덮어야 한다:
//   · 세션이 늘거나 상태가 바뀜        → max(updated_at), count(*)
//   · 새 메시지(마지막 메시지·건수 변화) → max(chat_messages.id)
//   · 상담원 접속 현황(카드뷰가 함께 그림) → 살아 있는 presence 행 수
// count(*)를 chat_messages에 쓰지 않은 이유는 순차 스캔이 되기 때문이다 — max(id)면 충분하다
// (메시지는 지워지지 않는다).
async function buildSessionListVersion() {
  const row = await db.get(`
    SELECT
      (SELECT max(updated_at) FROM chat_sessions) AS s_updated,
      (SELECT count(*)::int FROM chat_sessions) AS s_count,
      (SELECT max(id) FROM chat_messages) AS m_max,
      (SELECT count(*)::int FROM chat_agent_presence
        WHERE last_seen_at > now() - interval '${PRESENCE_STALE_SECONDS} seconds') AS agents
  `);
  return [row.s_updated, row.s_count, row.m_max, row.agents].join('|');
}

// 목록(list/card 뷰 공통)이 쓰는 세션 조회만 따로 뺐다 — Next.js Stage 1 프리뷰(list 뷰의
// 읽기 전용 테이블만 대상)는 이 데이터만 있으면 되고, 카드뷰 전용 데이터(onlineAgents,
// branches 등 — 실시간 채팅/오더등록폼에서만 쓰임)는 필요 없다.
async function buildSessionListSessions() {
  // 카카오 세션은 UserKey만으로는 누구인지 알 수 없다 — 매핑된 거래처(계정→지사→그룹)를 함께
  // 붙여 카드에 띄운다. findIntakeAccount와 같은 규칙: 고객 단위 매핑(external_user_key)을
  // 먼저, 없으면 채널 전체 매핑(service_key). 계정 테이블이 작아 세션당 LATERAL 조회가 가볍다.
  return db.all(`
    SELECT cs.*, ${CUSTOMER_NAME_SQL} AS user_name, ${CUSTOMER_ROLE_SQL} AS user_role, ${CUSTOMER_PHONE_SQL} AS user_phone,
      a.name AS assigned_agent_name,
      macct.mapped_user_name, macct.mapped_branch_name, macct.mapped_group_name, macct.mapped_auto_register,
      (SELECT message FROM chat_messages WHERE session_id = cs.id ORDER BY id DESC LIMIT 1) AS last_message,
      (SELECT COUNT(*) FROM chat_messages WHERE session_id = cs.id) AS message_count
    FROM chat_sessions cs
    LEFT JOIN users u ON u.id = cs.user_id
    LEFT JOIN users a ON a.id = cs.assigned_agent_id
    LEFT JOIN LATERAL (
      SELECT u2.name AS mapped_user_name, b2.name AS mapped_branch_name,
             g2.name AS mapped_group_name, ka.auto_register AS mapped_auto_register
      FROM kakao_consult_accounts ka
      LEFT JOIN users u2 ON u2.id = ka.user_id
      LEFT JOIN branches b2 ON b2.id = ka.branch_id
      LEFT JOIN groups_tbl g2 ON g2.id = ka.requester_group_id
      WHERE ka.enabled = true
        AND (
          (ka.external_user_key IS NOT NULL
            AND ka.external_user_key = COALESCE(cs.external_user_key, cs.kakao_user_key)
            AND (ka.service_key IS NULL OR ka.service_key = cs.kakao_service_key))
          OR (ka.external_user_key IS NULL AND ka.service_key = cs.kakao_service_key)
        )
      ORDER BY (ka.external_user_key IS NOT NULL) DESC, ka.id DESC
      LIMIT 1
    ) macct ON cs.channel = 'kakao'
    ORDER BY (cs.status = 'needs_agent') DESC, cs.updated_at DESC
  `);
}

router.get('/sessions', requireRole('admin'), asyncHandler(async (req, res) => {
  const view = req.query.view === 'list' ? 'list' : 'card';
  const notice = req.query.notice || null;
  const error = req.query.error || null;
  const [sessions, onlineAgents, branches, groups, paymentMethods, defaults] = await Promise.all([
    buildSessionListSessions(),
    listOnlineAgentNames(),
    db.all("SELECT id, name FROM branches WHERE status = 'active' ORDER BY name"),
    db.all('SELECT id, name FROM groups_tbl ORDER BY name'),
    db.all('SELECT id, name FROM payment_methods WHERE is_active = 1 ORDER BY id'),
    Promise.resolve(defaultReservedDateTime()),
  ]);
  res.render('chat/session_list', {
    title: '상담 관리',
    sessions,
    onlineAgents,
    view,
    notice,
    error,
    branches,
    groups,
    paymentMethods,
    defaultReservedDate: defaults.reserved_date,
    defaultReservedTime: defaults.reserved_time,
  });
}));

// Next.js Stage 1 프리뷰(src/app/chat/sessions/page.js, view=list만 대상)가 fetch()로
// 호출하는 JSON 버전 — 같은 requireRole('admin')과 같은 세션 조회를 그대로 재사용한다.
// 카드뷰(실시간 채팅/답장/배정/삭제/오더등록폼)는 범위 밖이라 이 엔드포인트에 없다.
router.get('/sessions/data.json', requireRole('admin'), asyncHandler(async (req, res) => {
  const sessions = await buildSessionListSessions();
  res.json({ sessions, currentUser: req.session.user });
}));

// Next.js Stage 3 프리뷰(src/app/chat/sessions/page.js, view=card 대상)가 fetch()로
// 호출하는 JSON 버전 — 카드뷰의 좌측 세션목록 + 온라인 상담원 배지에 필요한 초기 데이터.
// 실시간 갱신은 이 엔드포인트가 아니라 클라이언트가 여는 EventSource(/sessions/:id/stream,
// /agent-presence/stream)가 담당한다 — 이 라우트는 최초 로드/수동 새로고침 시에만 호출된다.
// 목록이 바뀌었는지만 묻는다. 화면은 이 값이 달라졌을 때만 card-data.json을 부른다.
router.get('/sessions/card-version.json', requireRole('admin'), asyncHandler(async (req, res) => {
  res.json({ version: await buildSessionListVersion() });
}));

router.get('/sessions/card-data.json', requireRole('admin'), asyncHandler(async (req, res) => {
  const [sessions, onlineAgents, version] = await Promise.all([
    buildSessionListSessions(),
    listOnlineAgentNames(),
    // 전체를 받을 때 버전도 같이 준다 — 화면이 "이 데이터의 버전"을 알아야 다음 확인에서
    // 비교할 수 있다. 따로 부르면 그 사이 변경을 놓친다.
    buildSessionListVersion(),
  ]);
  // Stage 3 슬라이스 3: "접수 마무리" 탭은 카드뷰 자체보다 더 세밀하게 롤백할 수 있도록
  // 별도 플래그로 게이팅한다(카드뷰 전체를 끄지 않고 이 탭만 껐다 켤 수 있음).
  res.json({ sessions, onlineAgents, version, currentUser: req.session.user, intakeEnabled: process.env.NEXT_STAGE3_CHAT_INTAKE_ENABLED === 'true' });
}));

// ---------------- 관리자: 카드뷰용 메시지 지연 로딩 ----------------
router.get('/sessions/:id/messages', requireRole('admin'), asyncHandler(async (req, res) => {
  const session = await db.get('SELECT id, status FROM chat_sessions WHERE id = ?', [req.params.id]);
  if (!session) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
  await markUserMessagesReadByAgent(session.id);

  const maxLimit = 100;
  const requestedLimit = Number(req.query.limit) || 30;
  const limit = Math.max(1, Math.min(maxLimit, requestedLimit));
  const beforeId = Number(req.query.beforeId);

  let rows;
  if (Number.isFinite(beforeId) && beforeId > 0) {
    rows = await db.all(`
      SELECT * FROM (
        SELECT * FROM chat_messages
        WHERE session_id = ? AND id < ?
        ORDER BY id DESC
        LIMIT ?
      ) x
      ORDER BY id ASC
    `, [req.params.id, beforeId, limit]);
  } else {
    rows = await db.all(`
      SELECT * FROM (
        SELECT * FROM chat_messages
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT ?
      ) x
      ORDER BY id ASC
    `, [req.params.id, limit]);
  }

  const firstId = rows.length ? rows[0].id : null;
  let hasMore = false;
  if (firstId != null) {
    const older = await db.get('SELECT id FROM chat_messages WHERE session_id = ? AND id < ? LIMIT 1', [req.params.id, firstId]);
    hasMore = !!older;
  }

  res.json({ messages: rows, hasMore, status: session.status });
}));

router.get('/sessions/:id/intake-order', requireRole('admin'), asyncHandler(async (req, res) => {
  const session = await db.get(`
    SELECT cs.id, cs.status, cs.draft_json, u.branch_id AS user_branch_id, u.group_id AS user_group_id
    FROM chat_sessions cs
    LEFT JOIN users u ON u.id = cs.user_id
    WHERE cs.id = ?
  `, [req.params.id]);
  if (!session) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });

  const messages = await db.all('SELECT id, sender, message FROM chat_messages WHERE session_id = ? ORDER BY id', [req.params.id]);
  const branches = await db.all("SELECT id FROM branches WHERE status = 'active' ORDER BY name");

  const defaults = defaultReservedDateTime();
  let draft = null;
  try {
    draft = session.draft_json ? JSON.parse(session.draft_json) : null;
  } catch (e) {
    draft = null;
  }
  const fields = (draft && draft.fields) ? draft.fields : {};
  const extractedWaypoints = extractWaypointsFromSummary(messages);
  // 채팅으로 접수한 고객(chat_sessions.user_id)이 소속된 지사/법인을 기본값으로 쓴다 —
  // 초안에 이미 값이 있으면(예: 챗봇이 대화 중 물어서 받은 값) 그게 우선. 소속 지사가 없는
  // 사용자(예: 지사 미배정 관리자)만 "활성 지사가 하나뿐이면 그걸로" 폴백을 쓴다.
  const branchId = fields.branch_id || (session.user_branch_id ? String(session.user_branch_id) : '')
    || (branches.length === 1 ? String(branches[0].id) : '');
  const requesterGroupId = fields.requester_group_id || (session.user_group_id ? String(session.user_group_id) : '');

  let paymentMethodId = fields.payment_method_id || '';
  if (!paymentMethodId && branchId) {
    const effectiveMethods = await getEffectivePaymentMethods(branchId);
    const defaultMethod = effectiveMethods.find((pm) => pm.is_default);
    if (defaultMethod) paymentMethodId = String(defaultMethod.id);
  }

  // 상담원 도우미가 만든 초안에 접수 슬롯이 있으면 그걸로 접수장을 채운다 — 상담원이 고객
  // 메시지를 눈으로 읽고 폼에 옮겨 적던 일이 사라진다. 다만 draft_json(챗봇이 대화로 되물어
  // 확정한 값)이 있으면 그쪽이 우선이다 — 사람이 확인한 값이 파싱 추정치보다 낫다.
  const pendingSuggestion = await db.get(
    `SELECT intake_json FROM chat_suggestions
     WHERE session_id = ? AND status IN ('pending', 'handed_to_bot') AND intake_json IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
    [req.params.id]
  ).catch(() => null);
  let parsedFields = {};
  if (pendingSuggestion && pendingSuggestion.intake_json) {
    try { parsedFields = JSON.parse(pendingSuggestion.intake_json) || {}; } catch (e) { parsedFields = {}; }
  }
  const pick = (key) => fields[key] || parsedFields[key] || '';

  const intakeOrder = {
    reserved_date: pick('reserved_date') || defaults.reserved_date,
    reserved_time: pick('reserved_time') || defaults.reserved_time,
    origin_address: pick('origin_address'),
    origin_detail_address: fields.origin_detail_address || '',
    origin_contact: pick('origin_contact'),
    vehicle_number: pick('vehicle_number'),
    vehicle_type: pick('vehicle_type'),
    destination_address: pick('destination_address'),
    destination_detail_address: fields.destination_detail_address || '',
    destination_contact: pick('destination_contact'),
    memo_customer: pick('memo_customer'),
    branch_id: branchId,
    requester_group_id: requesterGroupId,
    payment_method_id: paymentMethodId,
    fare_amount: fields.fare_amount || '',
    waypoints: extractedWaypoints,
    reservation_basis: (draft && (draft.reservationBasis === 'delivery' || draft.reservationBasis === 'immediate')) ? draft.reservationBasis : 'pickup',
  };

  res.json({
    sessionId: Number(session.id),
    sessionStatus: session.status,
    intakeOrder,
    // 폼에는 첫 차량만 들어간다 — 여러 대가 온 경우 상담원이 알 수 있게 함께 내려준다.
    extraVehicles: parsedFields.extra_vehicles || [],
  });
}));

// ---------------- 관리자: 세션 상세/모니터링/개입 ----------------
router.get('/sessions/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const session = await db.get(`
    SELECT cs.*, ${CUSTOMER_NAME_SQL} AS user_name, ${CUSTOMER_ROLE_SQL} AS user_role,
      ${CUSTOMER_PHONE_SQL} AS user_phone, u.login_id AS user_login_id,
      a.name AS agent_name
    FROM chat_sessions cs
    LEFT JOIN users u ON u.id = cs.user_id
    LEFT JOIN users a ON a.id = cs.assigned_agent_id
    WHERE cs.id = ?
  `, [req.params.id]);
  if (!session) return res.status(404).send('세션을 찾을 수 없습니다.');
  // 카카오 세션이면 어떤 거래처로 이어지는지 카드 상단에 띄운다(매핑 없으면 null).
  const mappedAccount = await describeMappedAccount(session).catch(() => null);
  const messages = await db.all('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id', [req.params.id]);
  const [agents, branches, groups, paymentMethods] = await Promise.all([
    db.all("SELECT id, name FROM users WHERE role = 'admin' AND status = 'active' ORDER BY name"),
    db.all("SELECT id, name FROM branches WHERE status = 'active' ORDER BY name"),
    db.all('SELECT id, name FROM groups_tbl ORDER BY name'),
    db.all('SELECT id, name FROM payment_methods WHERE is_active = 1 ORDER BY id'),
  ]);

  const defaults = defaultReservedDateTime();
  let draft = null;
  try {
    draft = session.draft_json ? JSON.parse(session.draft_json) : null;
  } catch (e) {
    draft = null;
  }
  const fields = (draft && draft.fields) ? draft.fields : {};
  const extractedWaypoints = extractWaypointsFromSummary(messages);
  const branchId = fields.branch_id || (branches.length === 1 ? String(branches[0].id) : '');

  const intakeOrder = {
    reserved_date: fields.reserved_date || defaults.reserved_date,
    reserved_time: fields.reserved_time || defaults.reserved_time,
    origin_address: fields.origin_address || '',
    origin_detail_address: fields.origin_detail_address || '',
    origin_contact: fields.origin_contact || '',
    vehicle_number: fields.vehicle_number || '',
    vehicle_type: fields.vehicle_type || '',
    destination_address: fields.destination_address || '',
    destination_detail_address: fields.destination_detail_address || '',
    destination_contact: fields.destination_contact || '',
    memo_customer: fields.memo_customer || '',
    branch_id: branchId,
    requester_group_id: fields.requester_group_id || '',
    payment_method_id: fields.payment_method_id || '',
    fare_amount: fields.fare_amount || '',
    waypoints: extractedWaypoints,
    reservation_basis: (draft && (draft.reservationBasis === 'delivery' || draft.reservationBasis === 'immediate')) ? draft.reservationBasis : 'pickup',
  };

  res.render('chat/session_detail', {
    title: '상담 · #' + session.id,
    layoutMode: 'top-nav',
    session,
    mappedAccount,
    messages,
    agents,
    branches,
    groups,
    paymentMethods,
    intakeOrder,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
}));

// Next.js Stage 3 슬라이스 2 프리뷰(src/app/chat/sessions/[id]/page.js)가 fetch()로
// 호출하는 JSON 버전 — 세션 메타 + 담당자 지정용 admin 유저 목록만 반환한다(메시지는
// 카드뷰와 동일하게 GET /sessions/:id/messages를 별도로 호출, 접수 마무리 폼은 이번
// 슬라이스 범위 밖이라 branches/groups/paymentMethods/intakeOrder는 싣지 않는다).
router.get('/sessions/:id/data.json', requireRole('admin'), asyncHandler(async (req, res) => {
  const session = await db.get(`
    SELECT cs.id, cs.status, cs.assigned_agent_id, cs.requested_feature, cs.created_at, cs.updated_at, cs.channel,
      cs.external_user_key, cs.kakao_user_key, cs.kakao_service_key, cs.external_phone,
      ${CUSTOMER_NAME_SQL} AS user_name, ${CUSTOMER_ROLE_SQL} AS user_role, ${CUSTOMER_PHONE_SQL} AS user_phone,
      a.name AS assigned_agent_name
    FROM chat_sessions cs
    LEFT JOIN users u ON u.id = cs.user_id
    LEFT JOIN users a ON a.id = cs.assigned_agent_id
    WHERE cs.id = ?
  `, [req.params.id]);
  if (!session) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
  const mappedAccount = await describeMappedAccount(session).catch(() => null);
  const agents = await db.all("SELECT id, name FROM users WHERE role = 'admin' AND status = 'active' ORDER BY name");
  res.json({ session, mappedAccount, agents, currentUser: req.session.user });
}));

router.post('/sessions/:id/assign-self', requireRole('admin'), asyncHandler(async (req, res) => {
  const session = await db.get(`
    SELECT cs.id, cs.status, cs.assigned_agent_id, a.name AS assigned_agent_name
    FROM chat_sessions cs
    LEFT JOIN users a ON a.id = cs.assigned_agent_id
    WHERE cs.id = ?
  `, [req.params.id]);
  const wantsJson = wantsJsonResponse(req);
  if (!session) {
    if (wantsJson) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
    return res.status(404).send('세션을 찾을 수 없습니다.');
  }

  const u = req.session.user;
  if (session.assigned_agent_id && Number(session.assigned_agent_id) === Number(u.id)) {
    if (wantsJson) return res.json({ ok: true, assignedAgentId: u.id, assignedAgentName: u.name, status: session.status });
    return res.redirect('/chat/sessions/' + req.params.id + '?notice=' + encodeURIComponent('이미 본인이 담당 중입니다.'));
  }

  await db.run(
    `UPDATE chat_sessions
     SET assigned_agent_id = ?,
         updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
     WHERE id = ?`,
    [u.id, req.params.id]
  );

  const systemText = session.assigned_agent_id
    ? `담당 상담원이 '${session.assigned_agent_name || '미지정'}'에서 '${u.name}'(으)로 변경되었습니다.`
    : `담당 상담원이 '${u.name}'(으)로 지정되었습니다.`;
  const systemMsg = await db.get(
    `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'system', ?) RETURNING *`,
    [req.params.id, systemText]
  );
  broadcastMessageAsync(req.params.id, systemMsg);
  broadcastSessionListChangedAsync();

  if (wantsJson) return res.json({ ok: true, assignedAgentId: u.id, assignedAgentName: u.name, status: session.status });
  return res.redirect('/chat/sessions/' + req.params.id + '?notice=' + encodeURIComponent('담당자가 지정되었습니다.'));
}));

router.post('/sessions/:id/assign', requireRole('admin'), asyncHandler(async (req, res) => {
  const session = await db.get(`
    SELECT cs.id, cs.status, cs.assigned_agent_id, a.name AS assigned_agent_name
    FROM chat_sessions cs
    LEFT JOIN users a ON a.id = cs.assigned_agent_id
    WHERE cs.id = ?
  `, [req.params.id]);
  const wantsJson = wantsJsonResponse(req);
  if (!session) {
    if (wantsJson) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
    return res.status(404).send('세션을 찾을 수 없습니다.');
  }

  const agentId = Number(req.body.agent_id);
  if (!agentId) {
    if (wantsJson) return res.status(400).json({ error: '담당 상담원을 선택해주세요.' });
    return res.redirect('/chat/sessions/' + req.params.id + '?error=' + encodeURIComponent('담당 상담원을 선택해주세요.'));
  }

  const agent = await db.get("SELECT id, name FROM users WHERE id = ? AND role = 'admin' AND status = 'active'", [agentId]);
  if (!agent) {
    if (wantsJson) return res.status(400).json({ error: '유효한 상담원이 아닙니다.' });
    return res.redirect('/chat/sessions/' + req.params.id + '?error=' + encodeURIComponent('유효한 상담원이 아닙니다.'));
  }

  if (session.assigned_agent_id && Number(session.assigned_agent_id) === Number(agent.id)) {
    if (wantsJson) return res.json({ ok: true, assignedAgentId: agent.id, assignedAgentName: agent.name, status: session.status });
    return res.redirect('/chat/sessions/' + req.params.id + '?notice=' + encodeURIComponent('이미 해당 상담원이 담당 중입니다.'));
  }

  await db.run(
    `UPDATE chat_sessions
     SET assigned_agent_id = ?,
         updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
     WHERE id = ?`,
    [agent.id, req.params.id]
  );

  const systemText = session.assigned_agent_id
    ? `담당 상담원이 '${session.assigned_agent_name || '미지정'}'에서 '${agent.name}'(으)로 변경되었습니다.`
    : `담당 상담원이 '${agent.name}'(으)로 지정되었습니다.`;
  const systemMsg = await db.get(
    `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'system', ?) RETURNING *`,
    [req.params.id, systemText]
  );
  broadcastMessageAsync(req.params.id, systemMsg);
  broadcastSessionListChangedAsync();
  if (wantsJson) return res.json({ ok: true, assignedAgentId: agent.id, assignedAgentName: agent.name, status: session.status });
  res.redirect('/chat/sessions/' + req.params.id + '?notice=' + encodeURIComponent('담당 상담원이 지정되었습니다.'));
}));

// 상담원 답장 발송 — 직접 입력(/reply)과 봇 초안 승인(/suggestions/:sid/approve)이 같은 경로를
// 타야 한다. 갈라지면 카카오 발신·상태 전이·읽음 처리가 경로마다 달라져 운영 중 원인 추적이
// 불가능해진다.
async function deliverAgentReply(session, agentUser, text) {
  const inserted = await db.get(
    `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'agent', ?) RETURNING *`,
    [session.id, text]
  );
  // 상담원이 답하면 봇 인계 기록(bot_handover_at)을 지운다 — 사람이 다시 응대를 맡았다는 뜻이다.
  // 컬럼이 아직 없는 DB(마이그레이션 전)에서도 답장 자체는 되어야 하므로 폴백을 둔다.
  await db.run(
    `UPDATE chat_sessions SET status = 'agent_active', assigned_agent_id = ?, bot_handover_at = NULL,
     updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [agentUser.id, session.id]
  ).catch(() => db.run(
    `UPDATE chat_sessions SET status = 'agent_active', assigned_agent_id = ?,
     updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [agentUser.id, session.id]
  ));
  broadcastMessageAsync(session.id, inserted);
  broadcastSessionListChangedAsync();

  // 카카오 출신 세션(routes/kakaoConsult.js)이면 상담원 답장을 중계서버로도 내보낸다
  // (계획서 5.5 — 지금까지는 웹 위젯에만 반영되고 끝났다).
  if (session.channel === 'kakao') {
    // 카카오는 봇·상담원 메시지가 한 스트림으로 섞여 도착한다 — 누가 보낸 말인지 첫 줄에 밝힌다
    // (봇은 "AI 상담사", 상담원은 "상담원 : 이름"). 저장(chat_messages)은 sender='agent'로 이미
    // 구분되므로 원문만 남기고, 카카오로 나가는 텍스트에만 라벨을 붙인다.
    const labeled = `상담원 : ${(agentUser && agentUser.name) || '상담원'}\n${text}`;
    const sendResult = await kakaoConsult.sendMessage(session, labeled);
    if (!sendResult.ok) {
      logIntegrationErrorAsync({ source: 'kakao', operation: 'send', refType: 'chat_session', refId: Number(session.id),
        message: sendResult.error, context: { label: '상담원 답장', textHead: String(text).slice(0, 60) } });
    }
  }
  return inserted;
}

router.post('/sessions/:id/reply', requireRole('admin'), asyncHandler(async (req, res) => {
  const existing = await db.get(
    `SELECT id, assigned_agent_id, channel, kakao_service_key, kakao_user_key, kakao_event_key
     FROM chat_sessions WHERE id = ?`,
    [req.params.id]
  );
  const wantsJson = wantsJsonResponse(req);
  if (!existing) {
    if (wantsJson) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
    return res.status(404).send('세션을 찾을 수 없습니다.');
  }

  const u = req.session.user;
  if (existing.assigned_agent_id && Number(existing.assigned_agent_id) !== Number(u.id)) {
    const denyMessage = '이미 다른 상담원이 담당 중인 세션입니다. 담당자 변경 후 응답해주세요.';
    if (wantsJson) return res.status(409).json({ error: denyMessage });
    return res.redirect('/chat/sessions/' + req.params.id + '?error=' + encodeURIComponent(denyMessage));
  }

  const text = (req.body.text || '').trim();
  if (!text) {
    if (wantsJson) return res.status(400).json({ error: '메시지를 입력해주세요.' });
    return res.redirect('/chat/sessions/' + req.params.id);
  }

  const inserted = await deliverAgentReply(existing, u, text);

  if (wantsJson) {
    return res.json({ ok: true, message: inserted || null, status: 'agent_active' });
  }
  res.redirect('/chat/sessions/' + req.params.id);
}));

// ---------------- 상담원 도우미: 답변 채택 대기 ----------------
// 대기 중인 초안 조회 — 상담원 화면이 고객 메시지를 받을 때마다 호출한다.
router.get('/sessions/:id/suggestion', requireRole('admin'), asyncHandler(async (req, res) => {
  const row = await db.get(
    `SELECT * FROM chat_suggestions WHERE session_id = ? AND status = 'pending'
     ORDER BY id DESC LIMIT 1`,
    [req.params.id]
  ).catch(() => null);
  if (!row) return res.json({ suggestion: null });

  let intake = null;
  try { intake = row.intake_json ? JSON.parse(row.intake_json) : null; } catch (e) { intake = null; }
  res.json({
    suggestion: {
      id: row.id,
      kind: row.kind,
      text: row.suggested_text,
      userMessageId: row.user_message_id,
      intake,
      createdAt: row.created_at,
    },
  });
}));

// 승인 — 상담원이 초안을 그대로 또는 고쳐서 보낸다. 실제 발송은 직접 답장과 같은 경로를 탄다.
router.post('/sessions/:id/suggestions/:sid/approve', requireRole('admin'), asyncHandler(async (req, res) => {
  const session = await db.get(
    `SELECT id, assigned_agent_id, channel, kakao_service_key, kakao_user_key, kakao_event_key
     FROM chat_sessions WHERE id = ?`,
    [req.params.id]
  );
  if (!session) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });

  const u = req.session.user;
  if (session.assigned_agent_id && Number(session.assigned_agent_id) !== Number(u.id)) {
    return res.status(409).json({ error: '이미 다른 상담원이 담당 중인 세션입니다.' });
  }

  const suggestion = await db.get(
    'SELECT * FROM chat_suggestions WHERE id = ? AND session_id = ?',
    [req.params.sid, req.params.id]
  );
  if (!suggestion) return res.status(404).json({ error: '초안을 찾을 수 없습니다.' });
  if (suggestion.status !== 'pending') return res.status(409).json({ error: '이미 처리된 초안입니다.' });

  // 상담원이 고친 문구가 오면 그걸 보낸다. 원문(suggested_text)은 그대로 남겨 두어
  // "얼마나 고쳐 쓰는가"를 나중에 측정할 수 있게 한다.
  const text = String(req.body.text || suggestion.suggested_text || '').trim();
  if (!text) return res.status(400).json({ error: '보낼 내용이 비어 있습니다.' });

  const inserted = await deliverAgentReply(session, u, text);
  await db.run(
    `UPDATE chat_suggestions SET status = 'approved', sent_text = ?, decided_by = ?,
     decided_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [text, u.id, suggestion.id]
  );

  res.json({ ok: true, message: inserted, edited: text !== suggestion.suggested_text });
}));

// ---------------- 상담원 무응답 시 초안 자동 발송 ----------------
//
// 규칙(사용자 확정):
//   · 승인 대기(pending) 초안이 있는 세션만 대상이다 — 상담원 연결 중에 봇이 새로 끼어드는 게
//     아니라, 이미 대기열에 올라와 있던 초안만 내보낸다.
//   · 초안이 뜬 뒤 30초 동안 상담원이 아무 입력(타이핑·발송)도 하지 않으면 발송한다.
//   · 상담원이 타이핑을 시작하면 발송하지 않는다 — 답이 두 번 나가는 걸 막는다. 카카오는
//     발송 취소가 안 되므로 이 판단은 되돌릴 수 없다.
const AUTO_SEND_DELAY_SECONDS = 30;

// 상담원 상태로 붙잡혀 있는 세션을 봇으로 되돌리기까지의 기본 유휴 시간(분).
// 지사가 branches.agent_idle_release_minutes로 따로 정하면 그 값이 우선한다.
//
// 고객이 상담원 연결을 한 번 요청하면 그 뒤로 세션이 계속 needs_agent/agent_active로 남았다.
// 자동 개입(autoSendPendingSuggestions)은 "초안이 대기 중일 때"만 도는데, 고객이 말을 멈추면
// 초안도 안 생기니 아무것도 세션을 되돌리지 않는다(실사용 지적 — 하루 넘게 상담원 상태로 남은
// 세션이 있었다). 그러면 한참 뒤 고객이 다시 말을 걸어도 봇이 답하지 않고 계속 사람을 기다린다.
const AGENT_IDLE_RELEASE_MINUTES = 30;

// 오래 조용한 상담 세션을 봇 응대로 되돌린다.
//
// 마지막 대화(고객·상담원 어느 쪽이든)로부터 유휴 시간이 지난 세션만 대상이다 — 방금 상담원이
// 답한 세션을 빼앗으면 응대 중인 대화가 끊긴다. 담당자 배정도 함께 비운다(다음에 다시
// 연결되면 그때 배정된다).
//
// 유휴 시간은 지사마다 다르게 둘 수 있다(branches.agent_idle_release_minutes). 상담원이
// 상주하는 지사는 길게, 야간에 사람이 없는 지사는 짧게 두고 싶어 한다. 값이 없으면 코드
// 기본값을 쓰고, 0이면 그 지사는 자동 복귀를 하지 않는다.
//
// 세션에는 지사가 없어서(chat_sessions에 branch_id가 없다) 되짚어 찾는다 — 그 세션에서 만든
// 오더 → 고객 계정 → 카카오 채널 매핑 → 배정된 상담원 순이다. 어디서도 못 찾으면 기본값을 쓴다.
//
// 고객에게 따로 알리지 않는다. 이미 대화가 끊긴 지 오래라 그 시점에 말을 걸면 뜬금없고,
// 다음 메시지에 봇이 자연스럽게 답하는 것으로 충분하다. 대신 상담원이 나중에 이력을 볼 때
// 왜 봇으로 돌아갔는지 알 수 있도록 시스템 메시지를 남긴다.
const SESSION_BRANCH_SQL = `COALESCE(
  (SELECT o.branch_id FROM orders o WHERE o.chat_session_id = cs.id ORDER BY o.id DESC LIMIT 1),
  (SELECT cu.branch_id FROM users cu WHERE cu.id = cs.user_id),
  (SELECT a.branch_id FROM kakao_consult_accounts a
     WHERE a.enabled = true
       AND (a.external_user_key = cs.external_user_key
            OR (a.external_user_key IS NULL AND a.service_key = cs.kakao_service_key))
     ORDER BY (a.external_user_key IS NOT NULL) DESC, a.id DESC LIMIT 1),
  (SELECT ag.branch_id FROM users ag WHERE ag.id = cs.assigned_agent_id)
)`;

async function loadIdleReleaseTargets() {
  // 지사별 값이 없으면 기본값으로 판정한다. 0이면 그 지사는 아예 제외한다.
  const sql = `
    SELECT cs.id,
           COALESCE(b.agent_idle_release_minutes, ${AGENT_IDLE_RELEASE_MINUTES}) AS idle_minutes
      FROM chat_sessions cs
      LEFT JOIN branches b ON b.id = ${SESSION_BRANCH_SQL}
     WHERE cs.status IN ('needs_agent', 'agent_active')
       AND COALESCE(b.agent_idle_release_minutes, ${AGENT_IDLE_RELEASE_MINUTES}) > 0
       AND COALESCE(
             (SELECT max(m.created_at) FROM chat_messages m WHERE m.session_id = cs.id),
             cs.updated_at,
             cs.created_at
           ) <= to_char(
             (now() at time zone 'Asia/Seoul')
               - (COALESCE(b.agent_idle_release_minutes, ${AGENT_IDLE_RELEASE_MINUTES}) || ' minutes')::interval,
             'YYYY-MM-DD HH24:MI:SS')`;
  try {
    return await db.all(sql);
  } catch (e) {
    // agent_idle_release_minutes는 마이그레이션(20260810010000)으로 추가된다 — 적용 전 DB에서도
    // 자동 복귀 자체는 돌아야 하므로 기본값만 쓰는 형태로 한 번 더 시도한다.
    if (!e || e.code !== '42703') {
      console.error('유휴 상담 세션 조회 실패:', e.message);
      return [];
    }
    return db.all(`
      SELECT cs.id, ${AGENT_IDLE_RELEASE_MINUTES} AS idle_minutes
        FROM chat_sessions cs
       WHERE cs.status IN ('needs_agent', 'agent_active')
         AND COALESCE(
               (SELECT max(m.created_at) FROM chat_messages m WHERE m.session_id = cs.id),
               cs.updated_at,
               cs.created_at
             ) <= to_char((now() at time zone 'Asia/Seoul') - interval '${AGENT_IDLE_RELEASE_MINUTES} minutes', 'YYYY-MM-DD HH24:MI:SS')`)
      .catch((err) => { console.error('유휴 상담 세션 조회 실패:', err.message); return []; });
  }
}

async function releaseIdleAgentSessions() {
  const rows = await loadIdleReleaseTargets();

  const released = [];
  for (const row of rows) {
    try {
      await db.run(
        `UPDATE chat_sessions SET status = 'bot', assigned_agent_id = NULL,
         updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
         WHERE id = ? AND status IN ('needs_agent', 'agent_active')`,
        [row.id]
      );
      await db.run(
        `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'system', ?)`,
        [row.id, `${row.idle_minutes}분 동안 대화가 없어 봇 응대로 돌아갔습니다.`]
      );
      released.push(row.id);
    } catch (e) {
      console.error(`유휴 상담 세션 해제 실패 (session=${row.id}):`, e.message);
    }
  }
  if (released.length) broadcastSessionListChangedAsync({ event: 'idle_released' });
  return released;
}

async function loadAutoSendTargets() {
  const sql = `
    SELECT g.id AS suggestion_id, g.session_id, g.suggested_text, g.kind, g.created_at,
           COALESCE(um.message, (SELECT m2.message FROM chat_messages m2
             WHERE m2.session_id = s.id AND m2.sender = 'user' ORDER BY m2.id DESC LIMIT 1)) AS user_text,
           s.channel, s.status, s.assigned_agent_id, s.agent_typing_at,
           s.kakao_service_key, s.kakao_user_key, s.kakao_event_key,
           (SELECT max(m.created_at) FROM chat_messages m
             WHERE m.session_id = s.id AND m.sender = 'agent') AS last_agent_at
      FROM chat_suggestions g
      JOIN chat_sessions s ON s.id = g.session_id
      LEFT JOIN chat_messages um ON um.id = g.user_message_id
     WHERE g.status = 'pending'
       AND s.status = 'agent_active'
       -- 초안이 뜬 지 충분히 지났고
       AND g.created_at <= to_char((now() at time zone 'Asia/Seoul') - interval '${AUTO_SEND_DELAY_SECONDS} seconds', 'YYYY-MM-DD HH24:MI:SS')
       -- 그 사이 상담원이 타이핑하지 않았고
       AND (s.agent_typing_at IS NULL OR s.agent_typing_at < g.created_at)
     ORDER BY g.id`;
  try {
    return await db.all(sql);
  } catch (e) {
    console.error('자동 발송 대상 조회 실패:', e.message);
    return [];
  }
}

async function autoSendPendingSuggestions() {
  const rows = await loadAutoSendTargets();
  const sent = [];
  for (const row of rows) {
    // 초안이 만들어진 뒤 상담원이 이미 답을 보냈으면 자동 발송할 이유가 없다.
    if (row.last_agent_at && row.last_agent_at >= row.created_at) {
      await db.run(
        `UPDATE chat_suggestions SET status = 'dismissed',
         decided_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
        [row.suggestion_id]
      ).catch(() => {});
      continue;
    }

    try {
      const session = await db.get('SELECT * FROM chat_sessions WHERE id = ?', [row.session_id]);

      if (row.kind === 'intake') {
        // 접수 건은 봇에게 응대를 넘긴다. 초안 문구("접수하겠습니다…")를 대신 보내면 약속만
        // 나가고 오더는 만들어지지 않는다 — 봇이 이어받아 실제 접수 경로를 태우게 한다.
        await deliverBotMessage(session, BOT_HANDOVER_NOTICE);
        // bot_handover_at을 함께 세운다 — "언제 상담원에서 봇으로 넘어왔는지"의 기록이다.
        // (카카오 봇 응답은 항상 첫 줄에 "AI 상담사" 라벨이 붙으므로 응답 주체 구분은 그
        // 라벨이 담당한다. 예전의 "(AI 자동응답)" 꼬리표는 그 상시 라벨로 대체됐다.)
        await db.run(
          `UPDATE chat_sessions SET status = 'bot',
           bot_handover_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
           updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
          [row.session_id]
        ).catch(async (e) => {
          // 마이그레이션(20260808030000) 전이면 컬럼이 없다 — 표시만 못 붙일 뿐 인계는 되어야 한다.
          console.error('봇 인계 표시 기록 실패(인계는 계속):', e.message);
          await db.run(
            `UPDATE chat_sessions SET status = 'bot',
             updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
            [row.session_id]
          );
        });
        // 초안은 handed_to_bot으로 남긴다 — dismissed로 지우면 상담원이 뒤늦게 들어왔을 때
        // 우측 접수장 프리필(intake_json)이 사라진다.
        await db.run(
          `UPDATE chat_suggestions SET status = 'handed_to_bot',
           decided_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
          [row.suggestion_id]
        );
        broadcastSessionListChangedAsync({ event: 'bot_handover', sessionId: row.session_id });

        // 안내만 하고 끝내면 고객이 같은 말을 다시 해야 한다 — 이미 한 발화를 그대로 봇 경로에
        // 태워 실제 접수까지 진행한다. 카카오만 서버에서 봇 턴을 돌릴 수 있다(웹 위젯은 브라우저가
        // /orders/ai-parse를 호출하는 구조라 서버가 대신 실행할 수 없다).
        const userText = String(row.user_text || '').trim();
        if (userText && session.channel !== 'kakao') {
          // 웹 위젯은 대화 진행을 브라우저 FSM이 들고 있어 서버가 봇 턴을 대신 돌릴 수 없다.
          // 대신 "이 문장을 다시 처리하라"는 신호만 SSE로 보내 열려 있는 창이 평소 쓰는 봇
          // 경로를 스스로 한 번 태우게 한다. 창이 닫혀 있으면 신호를 못 받지만, 그 경우
          // 세션이 이미 bot 상태라 다음 메시지부터 봇이 정상 응대한다.
          broadcastMessageAsync(row.session_id, { type: 'bot_handover_replay', text: userText });
        }
        if (userText && session.channel === 'kakao') {
          try {
            // 지연 require — server.js가 두 라우터를 모두 로드하므로 최상단에서 서로 참조하면
            // 로드 순서에 묶인다.
            const { processBotTurn } = require('./kakaoConsult');
            // 봇 경로는 최신 세션 상태(bot)를 봐야 한다.
            const fresh = await db.get('SELECT * FROM chat_sessions WHERE id = ?', [row.session_id]);
            await processBotTurn(fresh, userText);
          } catch (e) {
            console.error(`봇 인계 후 처리 실패(세션 ${row.session_id}):`, e.message);
            logIntegrationErrorAsync({ source: 'kakao', operation: 'bot_handover', refType: 'chat_session',
              refId: Number(row.session_id), message: e.message, context: { textHead: userText.slice(0, 60) } });
          }
        }

        sent.push({ sessionId: row.session_id, suggestionId: row.suggestion_id, kind: row.kind, action: 'bot_handover' });
        continue;
      }

      // 담당 상담원을 그대로 유지한다 — 자동 발송이 담당자를 바꾸면 안 된다.
      const text = `${row.suggested_text}\n\n${AUTO_SEND_NOTICE}`;
      await deliverAgentReply(session, { id: session.assigned_agent_id || null }, text);
      await db.run(
        `UPDATE chat_suggestions SET status = 'auto_sent', sent_text = ?,
         decided_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
        [text, row.suggestion_id]
      );
      sent.push({ sessionId: row.session_id, suggestionId: row.suggestion_id, kind: row.kind, action: 'auto_sent' });
    } catch (e) {
      console.error(`초안 자동 발송 실패(세션 ${row.session_id}):`, e.message);
      logIntegrationErrorAsync({
        source: 'kakao', operation: 'auto_send', refType: 'chat_session', refId: Number(row.session_id),
        message: e.message, context: { suggestionId: row.suggestion_id },
      });
    }
  }
  return sent;
}

// 무시 — 쓰지 않은 초안도 남겨 둔다(채택률 측정용).
router.post('/sessions/:id/suggestions/:sid/dismiss', requireRole('admin'), asyncHandler(async (req, res) => {
  const { rowCount } = await db.run(
    `UPDATE chat_suggestions SET status = 'dismissed', decided_by = ?,
     decided_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
     WHERE id = ? AND session_id = ? AND status = 'pending'`,
    [req.session.user.id, req.params.sid, req.params.id]
  );
  res.json({ ok: rowCount > 0 });
}));

router.post('/sessions/:id/close', requireRole('admin'), asyncHandler(async (req, res) => {
  const existing = await db.get(
    `SELECT id, channel, kakao_service_key, kakao_user_key, kakao_event_key FROM chat_sessions WHERE id = ?`,
    [req.params.id]
  );
  const wantsJson = wantsJsonResponse(req);
  if (!existing) {
    if (wantsJson) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
    return res.status(404).send('세션을 찾을 수 없습니다.');
  }
  await db.run(`UPDATE chat_sessions SET status = 'closed' WHERE id = ?`, [req.params.id]);
  broadcastSessionListChangedAsync();

  // 카카오 출신 세션은 종료 시 중계서버에도 상담 종료를 알린다(계획서 5.6).
  if (existing.channel === 'kakao') {
    const closeResult = await kakaoConsult.sendClose(existing, '상담이 종료되었습니다. 이용해주셔서 감사합니다.');
    if (!closeResult.ok) console.error('카카오 상담톡 발신 실패(상담 종료):', closeResult.error);
  }

  if (wantsJson) return res.json({ ok: true, status: 'closed' });
  res.redirect('/chat/sessions');
}));

// 상담원 응대를 종료하고 다시 봇이 처리하도록 되돌린다.
router.post('/sessions/:id/return-to-bot', requireRole('admin'), asyncHandler(async (req, res) => {
  const existing = await db.get('SELECT id FROM chat_sessions WHERE id = ?', [req.params.id]);
  const wantsJson = wantsJsonResponse(req);
  if (!existing) {
    if (wantsJson) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
    return res.status(404).send('세션을 찾을 수 없습니다.');
  }
  await db.run(`UPDATE chat_sessions SET status = 'bot', assigned_agent_id = NULL WHERE id = ?`, [req.params.id]);
  broadcastSessionListChangedAsync();
  if (wantsJson) return res.json({ ok: true, status: 'bot' });
  res.redirect('/chat/sessions/' + req.params.id);
}));

router.post('/sessions/bulk-delete', requireRole('admin'), asyncHandler(async (req, res) => {
  const view = req.body.view === 'card' ? 'card' : 'list';
  const expectsJson = req.body.ajax === '1' || wantsJsonResponse(req);

  let rawIds = req.body.ids;
  if (typeof rawIds === 'string') {
    try { rawIds = JSON.parse(rawIds); } catch (e) { rawIds = rawIds.split(','); }
  }
  const ids = Array.isArray(rawIds)
    ? Array.from(new Set(rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)))
    : [];

  if (ids.length === 0) {
    if (expectsJson) return res.status(400).json({ error: '삭제할 세션을 선택해주세요.' });
    return res.redirect('/chat/sessions?view=' + view + '&error=' + encodeURIComponent('삭제할 세션을 선택해주세요.'));
  }

  const placeholders = ids.map(() => '?').join(',');
  const existingRows = await db.all(`SELECT id FROM chat_sessions WHERE id IN (${placeholders})`, ids);
  const existingIds = existingRows.map((r) => r.id);

  if (existingIds.length > 0) {
    const delPlaceholders = existingIds.map(() => '?').join(',');
    await db.run(`DELETE FROM chat_sessions WHERE id IN (${delPlaceholders})`, existingIds);
    broadcastSessionListChangedAsync();
  }

  if (expectsJson) return res.json({ ok: true, ids: existingIds });
  res.redirect('/chat/sessions?view=' + view + '&notice=' + encodeURIComponent(existingIds.length + '개의 상담 세션이 삭제되었습니다.'));
}));

router.post('/sessions/:id/delete', requireRole('admin'), asyncHandler(async (req, res) => {
  const view = req.body.view === 'card' ? 'card' : 'list';
  const expectsJson = req.body.ajax === '1' || wantsJsonResponse(req);
  const sessionId = Number(req.params.id);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    if (expectsJson) return res.status(400).json({ error: '유효하지 않은 세션 ID입니다.' });
    return res.redirect('/chat/sessions?view=' + view + '&error=' + encodeURIComponent('유효하지 않은 세션 ID입니다.'));
  }

  const existing = await db.get('SELECT id FROM chat_sessions WHERE id = ?', [sessionId]);
  if (!existing) {
    if (expectsJson) return res.status(404).json({ error: '이미 삭제되었거나 존재하지 않는 세션입니다.' });
    return res.redirect('/chat/sessions?view=' + view + '&error=' + encodeURIComponent('이미 삭제되었거나 존재하지 않는 세션입니다.'));
  }
  await db.run('DELETE FROM chat_sessions WHERE id = ?', [sessionId]);
  broadcastSessionListChangedAsync();
  if (expectsJson) return res.json({ ok: true, id: sessionId });
  res.redirect('/chat/sessions?view=' + view + '&notice=' + encodeURIComponent('상담 세션이 삭제되었습니다.'));
}));

// ---------------- 관리자: 세션 상세 실시간 수신(SSE, Realtime Broadcast 중계) ----------------
router.get('/sessions/:id/stream', requireRole('admin'), asyncHandler(async (req, res) => {
  const session = await db.get('SELECT id FROM chat_sessions WHERE id = ?', [req.params.id]);
  if (!session) return res.status(404).end();

  await markUserMessagesReadByAgent(session.id);

  sseHeaders(res);
  const streamHandle = openSessionStream(session.id, (payload) => {
    if (payload && payload.sender === 'user' && payload.id) markSingleMessageReadByAgentAsync(payload.id, session.id);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }, (receipt) => {
    // 상대측(고객 또는 다른 탭의 상담원)이 방금 읽음 처리를 했다는 신호 — 이미 렌더링된
    // 말풍선의 배지를 클라이언트가 즉시 갱신할 수 있도록 그대로 중계한다.
    res.write(`data: ${JSON.stringify({ type: 'read_receipt', reader: receipt && receipt.reader })}\n\n`);
  });
  const keepAlive = setInterval(() => { keepSessionAlive(req); res.write(':\n\n'); }, 20000);
  req.on('close', () => { clearInterval(keepAlive); closeChannel(streamHandle); });
}));

// ---------------- 관리자: 세션 상세 재연결 시 유실 메시지 보충용 ----------------
router.get('/sessions/:id/poll', requireRole('admin'), asyncHandler(async (req, res) => {
  await markUserMessagesReadByAgent(req.params.id);
  const since = Number(req.query.since) || 0;
  const messages = await db.all('SELECT * FROM chat_messages WHERE session_id = ? AND id > ? ORDER BY id', [req.params.id, since]);
  const session = await db.get('SELECT status FROM chat_sessions WHERE id = ?', [req.params.id]);
  res.json({ messages, status: session ? session.status : null });
}));

module.exports = router;
module.exports.cronRouter = cronRouter;
