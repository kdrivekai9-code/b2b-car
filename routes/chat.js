// 하이브리드 챗봇 대화 세션 — 고객측 메시지 영속화/실시간 수신 + 관리자측 모니터링/개입.
// 봇이 처리 못하는 요청(intent: unsupported)이 오면 세션을 needs_agent로 바꾸고 관리자에게 푸시 알림을 보낸다.
// 관리자가 답장을 보내면 세션이 agent_active로 바뀌고, 그 이후 해당 세션은 봇 호출 없이 상담원이 직접 응대한다.
// 메시지 실시간 전달은 Supabase Realtime Broadcast를 서버(서비스 롤 키)만 사용하고,
// 브라우저에는 SSE로 중계한다 — Supabase 키가 브라우저에 노출되지 않는다.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { notify } = require('../lib/push');
const { kstNow } = require('../lib/period');
const {
  broadcastMessage, broadcastReadReceipt, broadcastSessionListChanged, openSessionStream, openSessionListStream, closeChannel,
  startAgentPresence, isAnyAgentOnline, listOnlineAgentNames,
} = require('../lib/realtimeChat');

const router = express.Router();
router.use(requireAuth);

const SESSION_CREATE_LIMIT = 20;
const SESSION_CREATE_WINDOW_SQL = `to_char(now() at time zone 'Asia/Seoul' - interval '1 hour', 'YYYY-MM-DD HH24:MI:SS')`;

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

async function markUserMessagesReadByAgent(sessionId) {
  const { rowCount } = await db.run(
    `UPDATE chat_messages
     SET read_by_agent_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
     WHERE session_id = ? AND sender = 'user' AND read_by_agent_at IS NULL`,
    [sessionId]
  );
  if (rowCount > 0) broadcastReadReceiptAsync(sessionId, 'agent');
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
  res.json({ status: session.status });
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
    const inserted = await db.get(
      `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'bot', ?) RETURNING *`,
      [session.id, finalMessage]
    );
    broadcastMessageAsync(session.id, inserted);
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
  const keepAlive = setInterval(() => res.write(':\n\n'), 20000);
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
router.get('/guide', requireRole('admin'), asyncHandler(async (req, res) => {
  res.render('chat/guide', { title: '상담 운영안' });
}));

// 우측 상단 알림센터 패널이 새로고침 후에도 "현재 대기 중인" 상담을 바로 보여주기 위한 요약 조회.
// 반드시 아래 '/sessions/:id...' 와일드카드보다 먼저 등록해야 한다(이 파일의 다른 라우트들과 같은 이유).
router.get('/sessions/needs-agent-summary', requireRole('admin'), asyncHandler(async (req, res) => {
  const rows = await db.all(`
    SELECT cs.id, cs.updated_at,
      COALESCE(g.name, u.name) AS customer_name,
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

router.get('/sessions', requireRole('admin'), asyncHandler(async (req, res) => {
  const view = req.query.view === 'list' ? 'list' : 'card';
  const notice = req.query.notice || null;
  const error = req.query.error || null;
  const [sessions, onlineAgents, branches, groups, paymentMethods, defaults] = await Promise.all([
    db.all(`
      SELECT cs.*, u.name AS user_name, u.role AS user_role, u.phone AS user_phone,
        a.name AS assigned_agent_name,
        (SELECT message FROM chat_messages WHERE session_id = cs.id ORDER BY id DESC LIMIT 1) AS last_message,
        (SELECT COUNT(*) FROM chat_messages WHERE session_id = cs.id) AS message_count
      FROM chat_sessions cs
      LEFT JOIN users u ON u.id = cs.user_id
      LEFT JOIN users a ON a.id = cs.assigned_agent_id
      ORDER BY (cs.status = 'needs_agent') DESC, cs.updated_at DESC
    `),
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
  const session = await db.get('SELECT id, status, draft_json FROM chat_sessions WHERE id = ?', [req.params.id]);
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
  };

  res.json({
    sessionId: Number(session.id),
    sessionStatus: session.status,
    intakeOrder,
  });
}));

// ---------------- 관리자: 세션 상세/모니터링/개입 ----------------
router.get('/sessions/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const session = await db.get(`
    SELECT cs.*, u.name AS user_name, u.role AS user_role, u.phone AS user_phone, u.login_id AS user_login_id,
      a.name AS agent_name
    FROM chat_sessions cs
    LEFT JOIN users u ON u.id = cs.user_id
    LEFT JOIN users a ON a.id = cs.assigned_agent_id
    WHERE cs.id = ?
  `, [req.params.id]);
  if (!session) return res.status(404).send('세션을 찾을 수 없습니다.');
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
  };

  res.render('chat/session_detail', {
    title: '상담 · #' + session.id,
    layoutMode: 'top-nav',
    session,
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
  if (!session) return res.status(404).send('세션을 찾을 수 없습니다.');

  const agentId = Number(req.body.agent_id);
  if (!agentId) return res.redirect('/chat/sessions/' + req.params.id + '?error=' + encodeURIComponent('담당 상담원을 선택해주세요.'));

  const agent = await db.get("SELECT id, name FROM users WHERE id = ? AND role = 'admin' AND status = 'active'", [agentId]);
  if (!agent) return res.redirect('/chat/sessions/' + req.params.id + '?error=' + encodeURIComponent('유효한 상담원이 아닙니다.'));

  if (session.assigned_agent_id && Number(session.assigned_agent_id) === Number(agent.id)) {
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
  res.redirect('/chat/sessions/' + req.params.id + '?notice=' + encodeURIComponent('담당 상담원이 지정되었습니다.'));
}));

router.post('/sessions/:id/reply', requireRole('admin'), asyncHandler(async (req, res) => {
  const existing = await db.get('SELECT id, assigned_agent_id FROM chat_sessions WHERE id = ?', [req.params.id]);
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

  let inserted = null;
  if (text) {
    inserted = await db.get(
      `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'agent', ?) RETURNING *`,
      [req.params.id, text]
    );
    await db.run(
      `UPDATE chat_sessions SET status = 'agent_active', assigned_agent_id = ?,
       updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
      [u.id, req.params.id]
    );
    broadcastMessageAsync(req.params.id, inserted);
    broadcastSessionListChangedAsync();
  }

  if (wantsJson) {
    return res.json({ ok: true, message: inserted || null, status: 'agent_active' });
  }
  res.redirect('/chat/sessions/' + req.params.id);
}));

router.post('/sessions/:id/close', requireRole('admin'), asyncHandler(async (req, res) => {
  const existing = await db.get('SELECT id FROM chat_sessions WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).send('세션을 찾을 수 없습니다.');
  await db.run(`UPDATE chat_sessions SET status = 'closed' WHERE id = ?`, [req.params.id]);
  broadcastSessionListChangedAsync();
  res.redirect('/chat/sessions');
}));

// 상담원 응대를 종료하고 다시 봇이 처리하도록 되돌린다.
router.post('/sessions/:id/return-to-bot', requireRole('admin'), asyncHandler(async (req, res) => {
  const existing = await db.get('SELECT id FROM chat_sessions WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).send('세션을 찾을 수 없습니다.');
  await db.run(`UPDATE chat_sessions SET status = 'bot', assigned_agent_id = NULL WHERE id = ?`, [req.params.id]);
  broadcastSessionListChangedAsync();
  res.redirect('/chat/sessions/' + req.params.id);
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
  const keepAlive = setInterval(() => res.write(':\n\n'), 20000);
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
