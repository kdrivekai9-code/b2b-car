const express = require('express');
const db = require('../db');
const { requireAuth, requireRole, scopeFilter, getSessionProblem, keepSessionAlive } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ORDER_STATUSES } = require('../config');
const { getEffectivePaymentMethods, getEffectiveStatuses, checkOperatingHours, calculateFareWithFerry, calculatePremiumFare } = require('../lib/branchPolicy');
const { notify } = require('../lib/push');
const { kstNow } = require('../lib/period');
const { parseIntakeText } = require('../lib/aiIntakeParser');
const { classifyAndExtract, classifyPhaseReply } = require('../lib/hybridChat');
const { searchKnowledgeBase } = require('../lib/knowledgeSearch');
const { broadcastMessage, broadcastSessionListChanged, broadcastOrderListChanged, openOrderListStream, closeChannel } = require('../lib/realtimeChat');
const { splitTypeAndPlate } = require('../lib/vehicleInfo');
const callmaner = require('../lib/callmaner');

// 폼에서 온 좌표 문자열을 숫자로 — 빈 문자열/미입력/숫자 아님은 전부 null(컬럼이 numeric이라
// 빈 문자열을 그대로 넣으면 22P02로 터진다). 출발·도착지와 경유지 양쪽에서 같이 쓴다.
function toNumOrNullShared(v) {
  return v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
}

function defaultReservedDateTime() {
  const now = kstNow();
  const pad = (n) => String(n).padStart(2, '0');
  // 예약 시간은 10분 단위(00/10/20.../50)로만 받으므로, 기본값도 항상 그 단위에 맞도록
  // 다음 10분 단위로 올림한다(자정을 넘기면 다음날로 넘어가지 않고 같은 날 자정으로 처리).
  let hour = now.getUTCHours();
  let minute = Math.ceil(now.getUTCMinutes() / 10) * 10;
  if (minute >= 60) { minute = 0; hour = (hour + 1) % 24; }
  return {
    reserved_date: `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`,
    reserved_time: `${pad(hour)}:${pad(minute)}`,
  };
}

function getEffectiveOrderSchedule(body) {
  return {
    reservedDate: String(body.pickup_reserved_date || body.reserved_date || '').trim(),
    reservedTime: String(body.pickup_reserved_time || body.reserved_time || '').trim(),
  };
}

function getCurrentOperatingMoment() {
  const now = kstNow();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`,
    time: `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`,
  };
}

async function getCurrentOperatingMomentFromDb() {
  try {
    const row = await db.get(
      "SELECT to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD') AS date, to_char(now() at time zone 'Asia/Seoul', 'HH24:MI') AS time"
    );
    if (row && row.date && row.time) {
      return { date: String(row.date), time: String(row.time) };
    }
  } catch (e) {
    console.error('DB 현재시각 조회 실패, 로컬 시각으로 폴백:', e.message);
  }
  return getCurrentOperatingMoment();
}

const router = express.Router();
router.use((req, res, next) => {
  if (req.path === '/ai-intake/health') return next();
  return requireAuth(req, res, next);
});

const AI_HEALTH_CACHE_MS = 60000;
let aiHealthCache = { ok: null, checkedAt: 0, error: null };

function broadcastMessageAsync(sessionId, message) {
  broadcastMessage(sessionId, message).catch((e) => console.error('오더 등록 후 상담 메시지 브로드캐스트 실패:', e.message));
}

function broadcastSessionListChangedAsync(payload) {
  broadcastSessionListChanged(payload).catch((e) => console.error('오더 등록 후 상담 목록 갱신 신호 실패:', e.message));
}

// 오더 리스트 화면(고객/관리자 공용) 실시간 갱신 신호 — fire-and-forget(응답을 기다리게 하지 않음).
// 생성/수정/상태변경/배정/VOC 등 리스트에 영향을 줄 수 있는 지점마다 호출한다.
function broadcastOrderListChangedAsync() {
  broadcastOrderListChanged().catch((e) => console.error('오더 목록 갱신 신호 실패:', e.message));
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

const ORDERS_PAGE_SIZE = 50;

// 이 상태로 바뀔 때만 콜마너 오더접수를 보낸다 — POST /:id/status(전송 트리거)와
// GET /:id/callmaner-status.json(진행중 판정)이 같은 기준을 써야 한다.
const CALLMANER_TRIGGER_STATUSES = ['접수', '대기'];

// EJS 렌더 라우트와 Next.js 프리뷰(GET /orders/data.json)가 완전히 동일한 쿼리/스코핑/필터
// 로직을 공유하도록 분리했다 — dashboard.js의 buildDashboardData와 같은 패턴.
async function buildOrdersListData(scope, query) {
  const { branch_id, status, from, to, q } = query;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const offset = (page - 1) * ORDERS_PAGE_SIZE;

  // status를 뺀 필터(지사/기간/검색)만 따로 모아둔다 — 상태별 집계(총/오더등록/완료/...)는
  // 지금 어떤 상태를 골라 보고 있는지와 무관하게 "이 지사·기간·검색 조건에서 상태별로 몇 건씩
  // 있는지"를 보여줘야 탭처럼 자연스럽게 동작한다(상태 필터를 걸어도 다른 상태 건수가 0으로
  // 안 바뀜).
  const whereNoStatus = [];
  const paramsNoStatus = [];
  if (scope.branch_id) { whereNoStatus.push('o.branch_id = ?'); paramsNoStatus.push(scope.branch_id); }
  if (scope.group_id) { whereNoStatus.push('o.requester_group_id = ?'); paramsNoStatus.push(scope.group_id); }
  if (!scope.branch_id && branch_id) { whereNoStatus.push('o.branch_id = ?'); paramsNoStatus.push(branch_id); }
  if (from) { whereNoStatus.push('o.reserved_date >= ?'); paramsNoStatus.push(from); }
  if (to) { whereNoStatus.push('o.reserved_date <= ?'); paramsNoStatus.push(to); }
  if (q) { whereNoStatus.push('(o.oid LIKE ? OR o.origin_address LIKE ? OR o.destination_address LIKE ?)'); paramsNoStatus.push(`%${q}%`, `%${q}%`, `%${q}%`); }

  const where = whereNoStatus.slice();
  const params = paramsNoStatus.slice();
  if (status) { where.push('o.status = ?'); params.push(status); }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const whereNoStatusSql = whereNoStatus.length ? 'WHERE ' + whereNoStatus.join(' AND ') : '';

  const sql = `
    SELECT o.*, b.name AS branch_name, g.name AS group_name, g.main_phone AS group_phone,
      pm.name AS payment_method_name, d.name AS driver_name, d.phone AS driver_phone,
      (SELECT string_agg(w.address, ', ' ORDER BY w.seq) FROM order_waypoints w WHERE w.order_id = o.id) AS waypoints_text,
      (SELECT COUNT(*) FROM order_photos p WHERE p.order_id = o.id) AS photo_count,
      (SELECT COUNT(*) FROM order_legs ol WHERE ol.order_id = o.id) AS leg_count,
      (SELECT COUNT(*) FROM order_legs ol WHERE ol.order_id = o.id AND ol.driver_id IS NOT NULL) AS legs_assigned_count,
      (SELECT string_agg(DISTINCT ld.name, ', ') FROM order_legs ol2 JOIN drivers ld ON ld.id = ol2.driver_id WHERE ol2.order_id = o.id) AS leg_driver_names
    FROM orders o
    JOIN branches b ON b.id = o.branch_id
    LEFT JOIN groups_tbl g ON g.id = o.requester_group_id
    LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
    LEFT JOIN drivers d ON d.id = o.assigned_driver_id
    ${whereSql}
    -- 기본 정렬은 "가장 최근에 등록된 오더가 맨 위"(사용자 확정 사항). 예전에는 예약일시
    -- 기준이라 방금 등록한 오더가 예약이 먼 미래가 아니면 목록 중간에 묻혀서 찾기 어려웠다.
    -- created_at은 'YYYY-MM-DD HH24:MI:SS' 텍스트라 사전식 정렬이 곧 시간순이고, 같은 초에
    -- 등록된 오더는 id로 안정적으로 갈라준다(NULLS LAST는 방어용 — 현재 null은 없음).
    ORDER BY o.created_at DESC NULLS LAST, o.id DESC
    LIMIT ? OFFSET ?
  `;
  const countSql = `SELECT COUNT(*) AS total FROM orders o ${whereSql}`;
  // 상태별 집계 — 지사/기간/검색 필터는 그대로 반영하되 상태 필터는 뺀 whereNoStatusSql을 쓴다.
  const summarySql = `
    SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE o.status = '오더등록') AS registered,
      COUNT(*) FILTER (WHERE o.status = '완료') AS completed,
      COUNT(*) FILTER (WHERE o.status = '대기') AS pending,
      COUNT(*) FILTER (WHERE o.status = '취소') AS cancelled,
      COUNT(*) FILTER (WHERE o.status = '문의') AS inquiry
    FROM orders o ${whereNoStatusSql}
  `;

  // 서로 의존관계 없는 조회라 병렬로 실행한다 — 순차로 기다리면 왕복시간이 그대로 더해진다.
  const [orders, countRow, summaryRow, branches] = await Promise.all([
    db.all(sql, [...params, ORDERS_PAGE_SIZE, offset]),
    db.get(countSql, params),
    db.get(summarySql, paramsNoStatus),
    db.all('SELECT * FROM branches ORDER BY name'),
  ]);

  const totalCount = Number(countRow.total);
  const totalPages = Math.max(1, Math.ceil(totalCount / ORDERS_PAGE_SIZE));
  const statusSummary = {
    total: Number(summaryRow.total) || 0,
    registered: Number(summaryRow.registered) || 0,
    completed: Number(summaryRow.completed) || 0,
    pending: Number(summaryRow.pending) || 0,
    cancelled: Number(summaryRow.cancelled) || 0,
    inquiry: Number(summaryRow.inquiry) || 0,
  };

  return {
    orders, branches, ORDER_STATUSES, statusSummary,
    filters: { branch_id: branch_id || '', status: status || '', from: from || '', to: to || '', q: q || '' },
    pagination: { page, pageSize: ORDERS_PAGE_SIZE, totalCount, totalPages },
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const data = await buildOrdersListData(scopeFilter(req), req.query);
  res.render('orders/list', { title: '오더 리스트', ...data });
}));

// Next.js Stage 1 프리뷰(src/app/orders/page.js)가 fetch()로 호출하는 JSON 버전 — 같은
// requireAuth(라우터 상단에 이미 적용됨)와 같은 scopeFilter/쿼리를 그대로 재사용한다.
router.get('/data.json', asyncHandler(async (req, res) => {
  const data = await buildOrdersListData(scopeFilter(req), req.query);
  // EJS 버전은 res.locals.currentUser(서버 전역)로 지사 필터 노출 여부를 판단한다 —
  // JSON 응답에는 그 값이 없으므로 role만 별도로 실어준다(다른 정보는 안 실음).
  res.json({ ...data, currentUserRole: req.session.user.role, currentUser: req.session.user });
}));

// 오더 리스트 화면(고객/관리자 공용) 실시간 갱신 — 상담 세션 목록(routes/chat.js의
// /agent-presence/stream)과 동일한 패턴: Supabase Realtime Broadcast를 서버가 SSE로
// 중계한다. 페이로드 없이 "뭔가 바뀌었다"는 신호만 보내고, 브라우저는 이미 인증/스코프가
// 적용된 자기 화면의 /orders/data.json을 다시 불러온다 — 그래서 전체 공용 채널 하나만으로도
// 고객마다 자기 오더만 다시 보이는 게 안전하게 유지된다.
// 반드시 아래 '/:id' 와일드카드 라우트보다 먼저 등록해야 한다(그렇지 않으면 '/stream'
// 요청이 '/:id'에 매칭되어 "stream"이 오더 id로 잘못 쓰인다 — chat.js의 agent-presence/stream과
// 같은 이유로 겪었던 버그를 여기서도 피한다).
router.get('/stream', asyncHandler(async (req, res) => {
  sseHeaders(res);
  res.write(':\n\n');

  let cleaned = false;
  let keepAlive = null;
  let streamHandle = null;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (keepAlive) clearInterval(keepAlive);
    if (streamHandle) closeChannel(streamHandle);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);

  keepAlive = setInterval(() => {
    if (res.writableEnded || res.destroyed || !res.writable) return cleanup();
    keepSessionAlive(req);
    try { res.write(':\n\n'); } catch (e) { cleanup(); }
  }, 20000);

  streamHandle = openOrderListStream(() => {
    if (cleaned) return;
    try { res.write(`data: ${JSON.stringify({ type: 'changed' })}\n\n`); } catch (e) { cleanup(); }
  });
}));

// EJS 생성폼 라우트와 Next.js Stage 2 프리뷰(GET /orders/new/data.json)가 완전히 동일한
// 조회 로직을 공유하도록 분리했다 — dashboard.js/orders.js(목록)/inquiries.js/chat.js에서
// 이미 쓴 것과 같은 패턴.
async function buildOrderFormInitData(scope, userId) {
  // 서로 의존관계 없는 조회들이라 순차적으로 기다릴 필요가 없다 — 병렬로 실행해서
  // 콜드스타트/커넥션 재연결로 왕복시간이 늘어난 상황에서 지연이 곱연산되는 걸 막는다.
  const [branches, groups, paymentMethods, favorites] = await Promise.all([
    scope.branch_id
      ? db.all('SELECT * FROM branches WHERE id = ?', [scope.branch_id])
      : db.all("SELECT * FROM branches WHERE status='active' ORDER BY name"),
    db.all('SELECT * FROM groups_tbl ORDER BY name'),
    scope.branch_id
      ? getEffectivePaymentMethods(scope.branch_id)
      : db.all('SELECT * FROM payment_methods WHERE is_active = 1 ORDER BY id'),
    db.all('SELECT * FROM favorite_addresses WHERE user_id = ? ORDER BY id DESC', [userId]),
  ]);
  return {
    order: defaultReservedDateTime(), branches, groups, paymentMethods, favorites,
    defaultBranch: scope.branch_id || '', defaultGroup: scope.group_id || '',
  };
}

async function buildAiIntakeInitData(scope, userId) {
  const data = await buildOrderFormInitData(scope, userId);
  return {
    ...data,
    kakaoJsKey: process.env.KAKAO_JS_KEY || '',
  };
}

async function loadAiIntakeRestoreData(userId, requestedSessionId) {
  const existingSession = await (requestedSessionId
    ? db.get(
        `SELECT id, status, draft_json FROM chat_sessions WHERE id = ? AND user_id = ? AND user_hidden_at IS NULL`,
        [requestedSessionId, userId]
      )
    : db.get(
        `SELECT id, status, draft_json FROM chat_sessions WHERE user_id = ? AND status != 'closed' AND user_hidden_at IS NULL ORDER BY created_at DESC LIMIT 1`,
        [userId]
      ));

  let existingMessages = [];
  let existingDraft = null;
  if (existingSession) {
    existingMessages = await db.all(
      `SELECT id, sender, message, created_at FROM chat_messages WHERE session_id = ? ORDER BY id ASC`,
      [existingSession.id]
    );
    if (existingSession.draft_json) {
      try { existingDraft = JSON.parse(existingSession.draft_json); } catch (e) { existingDraft = null; }
    }
  }

  return { existingSession, existingMessages, existingDraft };
}

router.get('/new', asyncHandler(async (req, res) => {
  const scope = scopeFilter(req);
  const data = await buildOrderFormInitData(scope, req.session.user.id);
  res.render('orders/form', {
    title: '오더 등록', ...data, mode: 'create', error: null,
    kakaoJsKey: process.env.KAKAO_JS_KEY || '',
  });
}));

// Next.js Stage 2 프리뷰(src/app/orders/new/page.js)가 fetch()로 호출하는 JSON 버전 — 같은
// requireAuth(라우터 상단에 이미 적용됨)와 같은 scopeFilter/조회를 그대로 재사용한다.
// currentUserRole/currentUserPhone은 EJS가 res.locals.currentUser에서 바로 읽는 값들이라
// JSON 응답에는 따로 실어준다("요청자 연락처와 동일" 체크박스, client 요금 읽기전용 판단에 필요).
router.get('/new/data.json', asyncHandler(async (req, res) => {
  const scope = scopeFilter(req);
  const data = await buildOrderFormInitData(scope, req.session.user.id);
  res.json({
    ...data,
    currentUserRole: req.session.user.role,
    currentUserPhone: req.session.user.phone || '',
    currentUser: req.session.user,
  });
}));

// Next.js AI 접수 화면이 초기 표시용 공통 데이터만 따로 fetch할 수 있게 하는 JSON 버전.
router.get('/ai-intake/data.json', asyncHandler(async (req, res) => {
  const scope = scopeFilter(req);
  const data = await buildAiIntakeInitData(scope, req.session.user.id);
  res.json({
    ...data,
    currentUserRole: req.session.user.role,
    currentUserPhone: req.session.user.phone || '',
    currentUser: req.session.user,
  });
}));

// 복원 대상 세션/메시지/draft를 화면 렌더와 분리해 JSON 계약으로 고정한다.
router.get('/ai-intake/session/data.json', asyncHandler(async (req, res) => {
  const requestedSessionId = Number(req.query.session) || null;
  const data = await loadAiIntakeRestoreData(req.session.user.id, requestedSessionId);
  res.json(data);
}));

router.get('/ai-intake', asyncHandler(async (req, res) => {
  const scope = scopeFilter(req);
  // 최근 대화 목록(햄버거 메뉴)에서 과거 세션을 클릭하면 ?session=<id>로 넘어온다 — 이때는
  // "가장 최근의 열린 세션" 대신 사용자가 직접 고른 그 세션을 복원한다(본인 소유일 때만).
  const requestedSessionId = Number(req.query.session) || null;
  const [initData, restoreData] = await Promise.all([
    buildAiIntakeInitData(scope, req.session.user.id),
    loadAiIntakeRestoreData(req.session.user.id, requestedSessionId),
  ]);

  req.session.aiLastInputAt = Date.now();

  res.render('orders/ai_intake', {
    title: 'AI 챗봇',
    ...initData,
    ...restoreData,
    mode: 'create',
    error: null,
  });
}));

router.post('/ai-intake/activity', asyncHandler(async (req, res) => {
  req.session.aiLastInputAt = Date.now();
  req.session.lastSeenAt = req.session.aiLastInputAt;
  res.json({ ok: true, touchedAt: req.session.aiLastInputAt });
}));

router.post('/ai-intake/submit-precheck', asyncHandler(async (req, res) => {
  const scope = scopeFilter(req);
  const finalBranch = toPositiveIntOrNull(scope.branch_id || req.body.branch_id);

  if (!finalBranch) {
    return res.status(400).json({ error: '지사를 선택해주세요.' });
  }

  const currentMoment = await getCurrentOperatingMomentFromDb();
  const hoursCheck = await checkOperatingHours(finalBranch, currentMoment.date, currentMoment.time);
  if (!hoursCheck.allowed) {
    return res.status(400).json({ error: hoursCheck.reason });
  }

  res.json({ ok: true });
}));

router.post('/ai-intake/sessions/:id/delete', asyncHandler(async (req, res) => {
  const sessionId = Number(req.params.id);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return res.status(400).json({ error: '유효하지 않은 세션 ID입니다.' });
  }

  const session = await db.get('SELECT id, user_id, user_hidden_at FROM chat_sessions WHERE id = ?', [sessionId]);
  if (!session || Number(session.user_id) !== Number(req.session.user.id)) {
    return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
  }
  if (!session.user_hidden_at) {
    await db.run(
      `UPDATE chat_sessions
       SET user_hidden_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
           updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
       WHERE id = ?`,
      [sessionId]
    );
  }
  res.json({ ok: true, id: sessionId });
}));

// 세션의 draft_json(출발지 장소명/차량번호)이나, 그마저 없으면 첫 사용자 메시지 한 줄로
// 햄버거 메뉴의 "최근 항목" 목록에 표시할 요약을 만든다.
function summarizeChatSession(draftJsonText, firstUserMessage) {
  let draft = null;
  if (draftJsonText) {
    try { draft = JSON.parse(draftJsonText); } catch (e) { draft = null; }
  }
  const fields = (draft && draft.fields) || {};
  const place = fields.origin_detail_address || fields.origin_address || '';
  const vehicle = fields.vehicle_number || '';
  const vehicleType = fields.vehicle_type || '';
  if (place || vehicleType || vehicle) return [place, vehicleType, vehicle].filter(Boolean).join(' · ');
  if (firstUserMessage) {
    const oneLine = String(firstUserMessage).replace(/\s+/g, ' ').trim();
    return oneLine.length > 40 ? oneLine.slice(0, 40) + '…' : oneLine;
  }
  return '(내용 없음)';
}

// 햄버거 메뉴 "최근 항목" 목록 — 10개씩 커서(id) 기반 페이지네이션, 검색어(q)가 있으면
// 요약 대상(출발지/차량번호)이나 사용자 메시지에 포함된 것만 필터링한다.
router.get('/ai-intake/sessions', asyncHandler(async (req, res) => {
  const PAGE_SIZE = 10;
  const before = Number(req.query.before) || null;
  const q = (req.query.q || '').trim();
  const rows = await db.all(
    `SELECT id, status, draft_json, updated_at
     FROM chat_sessions
     WHERE user_id = ?
       AND user_hidden_at IS NULL
       AND (?::int IS NULL OR id < ?::int)
       AND (
         ?::text = '' OR
         draft_json ILIKE '%' || ?::text || '%' OR
         EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.session_id = chat_sessions.id AND cm.sender = 'user' AND cm.message ILIKE '%' || ?::text || '%')
       )
     ORDER BY id DESC
     LIMIT ?`,
    [req.session.user.id, before, before, q, q, q, PAGE_SIZE + 1]
  );
  const hasMore = rows.length > PAGE_SIZE;
  const pageRows = rows.slice(0, PAGE_SIZE);

  const ids = pageRows.map((r) => r.id);
  let firstMessageMap = {};
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const firstMessages = await db.all(
      `SELECT DISTINCT ON (session_id) session_id, message
       FROM chat_messages WHERE session_id IN (${placeholders}) AND sender = 'user'
       ORDER BY session_id, id ASC`,
      ids
    );
    firstMessages.forEach((m) => { firstMessageMap[m.session_id] = m.message; });
  }

  const sessions = pageRows.map((r) => ({
    id: r.id,
    status: r.status,
    updatedAt: r.updated_at,
    summary: summarizeChatSession(r.draft_json, firstMessageMap[r.id]),
  }));
  res.json({ sessions, hasMore });
}));

// Gemini(camelCase) 추출 결과를 기존 클라이언트 계약(snake_case, 오더 폼 필드명)에 맞춰 변환한다.
function normalizeGeminiOrderFields(parsed) {
  const splitVehicle = splitTypeAndPlate(parsed.vehicleType || null, parsed.originVehicleNumber || null);
  return {
    reserved_date: parsed.reservationDate || null,
    reserved_time: parsed.reservationTime || null,
    origin_address: parsed.originAddress || '',
    origin_detail_address: parsed.originAddressDetail || null,
    origin_contact: parsed.originContact || null,
    origin_vehicle_number: splitVehicle.vehicleNumber,
    vehicle_type: splitVehicle.vehicleType,
    waypoints: parsed.waypointAddress
      ? [{ address: parsed.waypointAddress, contact: parsed.waypointContact || null, vehicle_number: parsed.waypointVehicleNumber || null }]
      : [],
    destination_address: parsed.destinationAddress || '',
    destination_detail_address: parsed.destinationAddressDetail || null,
    destination_contact: parsed.destinationContact || null,
    memo_customer: parsed.memo || null,
    memo_billing: parsed.billingMemo || null,
  };
}

// 오더유형(탁송/일일기사/대리) 판별은 LLM의 의미 판단보다 아래 결정적 규칙을 우선한다 — 실무 기준상
// 탁송은 항상 "차량 인수증"/"성능점검기록부" 같은 서류 언급이 함께 오고, 일일기사는 8시간 이상 장시간·
// 왕복 근무를, 대리는 예약일시 없이 즉시 요청되는 경우가 대부분이라 이 편이 LLM 분류보다 안정적이다.
const DISPATCH_WORDING_RE = /탁송|인수증|성능\s*점검\s*기록부|점검\s*기록부/;
const DAILY_DRIVER_WORDING_RE = /일일\s*기사|왕복/;

function hasLongDurationWording(text) {
  const re = /([0-9]+)\s*시간/g;
  let m;
  while ((m = re.exec(text))) {
    if (Number(m[1]) >= 8) return true;
  }
  return false;
}

// fields는 normalizeGeminiOrderFields()/parseIntakeText()가 이미 계산해둔 reserved_date/reserved_time을 쓴다.
// 탁송 서류 문구는 예약일시 유무와 무관하게 최우선 신호다(예약일시를 안 적고 차량만 지금 보내는
// 탁송 요청도 흔함) — 이 경우 시간은 classifyOrderIntentByRule 호출부가 현재 시각으로 채운다.
// 규칙으로 판별되지 않으면(예약일시는 있는데 탁송/일일기사 신호가 전혀 없음) null을 돌려줘 호출부가
// Gemini의 intent(또는 기본값 dispatch_order)로 대체하게 한다.
function classifyOrderIntentByRule(text, fields) {
  if (DISPATCH_WORDING_RE.test(text)) return 'dispatch_order';
  const hasReservation = !!(fields.reserved_date || fields.reserved_time);
  if (!hasReservation) return 'proxy_order';
  if (DAILY_DRIVER_WORDING_RE.test(text) || hasLongDurationWording(text)) return 'daily_driver_order';
  return null;
}

// 인사말은 의미 검색에 필요한 정보가 없어 어떤 지식 항목과도 우연히 유사해질 수 있다.
// 이 경우 RAG와 의도 분류를 건너뛰고 대화 시작 안내를 반환한다.
function isGreeting(text) {
  return /^(?:안녕(?:하세요)?|안녕하십니까|반갑습니다|하이|hi|hello|헬로|좋은\s?(?:아침|오후|저녁))[!！?.\s]*$/i.test(text);
}

function hasBusinessKeyword(text) {
  return /(오더|접수|출발|도착|경유|요금|결제|주소|연락처|배정|기사|등록|취소|수정|공지|푸시|알림|지사)/i.test(text);
}

// FAQ 검색 전에 스몰토크를 우선 처리해 "답변을 찾지 못했습니다" 같은 어색한 실패 응답을 줄인다.
function getSmalltalkMessage(text) {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  if (!hasBusinessKeyword(normalized) && /(넌\s*누구(?:니|야)?|너(는|가)?\s*누구(?:니|야)?|누구(?:니|야)|정체|자기소개|소개해\s*줘|봇이야|ai야)/i.test(normalized)) {
    return '저는 탁송·대리운전(프리미엄) 오더 접수와 업무 안내를 도와드리는 AI 챗봇입니다. 오더 접수 내용을 입력하시거나, 궁금한 점을 질문해주세요.';
  }

  if (!hasBusinessKeyword(normalized) && /(뭘\s*할\s*수\s*있|무엇을\s*도와|어떤\s*업무|사용법|어떻게\s*써|도움\s*줘)/i.test(normalized)) {
    return '오더 접수 내용 자동 입력(탁송·대리운전), FAQ 안내, 처리 어려운 요청의 상담원 연결을 도와드릴 수 있습니다. 원하시는 내용을 말씀해주세요.';
  }

  if (/(^|\s)(안녕(?:하세요)?|하이|hello|hi|헬로|반가워)(\s|$)/i.test(normalized)) {
    return '안녕하세요. 오더 접수 내용을 입력하시거나, 궁금한 점을 질문해주세요.';
  }

  return null;
}

// 하이브리드 챗봇 1단계: 지식검색(FAQ) + 오더접수. Gemini로 의도를 분류해 두 갈래로 라우팅하고,
// Gemini 호출이 실패하면(쿼터/네트워크 등) 예전 규칙 기반 파서로 대체해 오더접수만이라도 동작하게 한다.
router.post('/ai-intake/parse', asyncHandler(async (req, res) => {
  const text = (req.body.text || '').trim();
  const pendingField = req.body.pendingField || null;
  if (!text) return res.status(400).json({ error: '접수 내용을 입력해주세요.' });
  const ORDER_INTENTS = new Set(['dispatch_order', 'proxy_order', 'daily_driver_order']);

  const smalltalkMessage = getSmalltalkMessage(text);
  if (smalltalkMessage) {
    return res.json({ intent: 'greeting', message: smalltalkMessage });
  }

  if (isGreeting(text)) {
    return res.json({
      intent: 'greeting',
      message: '안녕하세요. 오더 접수 내용을 입력하시거나, 궁금한 점을 질문해주세요.',
    });
  }

  // 지식검색(임베딩 API 호출)은 사용자 원문 텍스트만 있으면 바로 시작할 수 있어, 의도분류(Gemini) 결과를
  // 기다리지 않고 미리 같이 시작해둔다 — FAQ로 판정될 때만 그 결과를 기다리면 두 외부 API 호출이
  // 순차가 아니라 병렬로 진행되어 FAQ 응답 지연이 절반 가까이 줄어든다. FAQ가 아니면 결과는 버려진다
  // (임베딩 호출 자체는 가벼워서, 다른 의도일 때 낭비되는 비용보다 FAQ 응답 지연 감소가 더 크다).
  const knowledgeSearchPromise = searchKnowledgeBase(text, { limit: 1, threshold: 0.7 })
    .catch((e) => { console.error('지식베이스 사전 검색 실패:', e.message); return []; });

  let geminiResult = null;
  try {
    geminiResult = await classifyAndExtract(text, pendingField);
  } catch (e) {
    console.error('Gemini 의도분류/추출 실패, 규칙 기반 파서로 대체:', e.message);
  }

  // 화남/답답함 신호는 의도(intent)와 무관하게 감지될 수 있어 응답 분기와 상관없이 항상 함께 내려준다.
  const seemsFrustrated = !!(geminiResult && geminiResult.seemsFrustrated);

  if (geminiResult && geminiResult.intent === 'faq') {
    const matches = await knowledgeSearchPromise;
    return res.json({ intent: 'faq', matches, seemsFrustrated });
  }

  if (geminiResult && geminiResult.intent === 'unsupported') {
    return res.json({ intent: 'unsupported', requestedFeature: geminiResult.requestedFeature || null, seemsFrustrated });
  }

  const fields = geminiResult ? normalizeGeminiOrderFields(geminiResult) : parseIntakeText(text);
  const fallbackIntent = (geminiResult && ORDER_INTENTS.has(geminiResult.intent)) ? geminiResult.intent : 'dispatch_order';
  const intent = classifyOrderIntentByRule(text, fields) || fallbackIntent;
  // 예약일시가 없으면 현재 시각으로 조용히 채우지 않고 챗봇이 직접 물어보게 한다 — 이전에는
  // "지금 바로 보내는 차량"으로 임의 가정했는데, 사용자가 실제로 정한 적 없는 값을 마치 확인한
  // 것처럼 안내해버리는 문제가 있었다.
  res.json({ intent, ...fields, seemsFrustrated });
}));

// AI 챗봇 연결 상태 표시용: Vertex 분류 호출이 실제로 가능한지 확인한다.
// 페이지에서 짧은 주기로 조회하므로 최근 결과를 60초 캐시해 외부 API 호출을 줄인다.
router.get('/ai-intake/health', asyncHandler(async (req, res) => {
  const now = Date.now();
  const sessionProblem = await getSessionProblem(req);
  if (sessionProblem) {
    return res.status(200).json({ ok: false, checkedAt: now, reason: sessionProblem.reason, message: sessionProblem.message, cached: false });
  }

  if (aiHealthCache.ok !== null && (now - aiHealthCache.checkedAt) < AI_HEALTH_CACHE_MS) {
    return res.status(200).json({
      ok: aiHealthCache.ok,
      checkedAt: aiHealthCache.checkedAt,
      reason: aiHealthCache.reason,
      message: aiHealthCache.message,
      error: aiHealthCache.error,
      cached: true,
    });
  }

  try {
    await classifyAndExtract('AI 연결 상태 점검 요청', null);
    aiHealthCache = { ok: true, checkedAt: now, reason: null, message: null, error: null };
    return res.json({ ok: true, checkedAt: now, cached: false });
  } catch (e) {
    const errorMessage = e && e.message ? e.message : 'AI 서버 응답이 지연되고 있습니다.';
    aiHealthCache = { ok: false, checkedAt: now, reason: 'ai_server', message: 'AI 서버 응답이 지연되고 있습니다.', error: errorMessage };
    return res.status(200).json({ ok: false, checkedAt: now, reason: 'ai_server', message: 'AI 서버 응답이 지연되고 있습니다.', error: errorMessage, cached: false });
  }
}));

// 확인/수정/후보선택 단계의 답변 폴백 분류 — 클라이언트가 로컬 키워드로 먼저 판단해보고
// 애매할 때만("수정할 거 없어", "상담원연결" 같은 예상 못 한 표현 등) 호출한다.
router.post('/ai-intake/classify-reply', asyncHandler(async (req, res) => {
  const text = (req.body.text || '').trim();
  const phase = req.body.phase || '';
  const candidates = Array.isArray(req.body.candidates) ? req.body.candidates : [];
  if (!text || !phase) return res.status(400).json({ action: 'unclear' });

  try {
    const result = await classifyPhaseReply(text, phase, { candidates });
    res.json(result);
  } catch (e) {
    console.error('단계 응답 분류 실패:', e.message);
    res.json({ action: 'unclear' });
  }
}));

// 프리미엄/일일기사 시간 구간 기반 요금 미리보기
router.get('/premium-fare-preview', requireAuth, asyncHandler(async (req, res) => {
  const branchId = req.query.branch_id || null;
  const hoursBracket = req.query.hours_bracket || '';
  const HOURS_MAP = { within_4h: 4, within_8h: 8, over_8h: 10 };
  const hours = HOURS_MAP[hoursBracket];
  if (!hours) return res.json({ enabled: false });
  const result = await calculatePremiumFare(branchId, hours);
  res.json(result);
}));

router.get('/fare-preview', asyncHandler(async (req, res) => {
  const branchId = req.query.branch_id || null;
  const distanceKm = parseFloat(req.query.distance_km);
  if (!Number.isFinite(distanceKm)) return res.json({ enabled: false });
  const beforeKm = parseFloat(req.query.before_km);
  const afterKm = parseFloat(req.query.after_km);
  const beforeMinutes = parseFloat(req.query.before_minutes);
  const afterMinutes = parseFloat(req.query.after_minutes);
  const result = await calculateFareWithFerry(branchId, distanceKm, {
    vehicleType: req.query.vehicle_type || req.query.vehicleType || '',
    originAddress: req.query.origin_address || req.query.originAddress || '',
    hasFerryLeg: req.query.has_ferry_leg === '1' || req.query.has_ferry_leg === 'true',
    reservedDate: req.query.reserved_date || null,
    reservedTime: req.query.reserved_time || null,
    dayType: req.query.day_type || req.query.dayType || '',
    beforeKm: Number.isFinite(beforeKm) ? beforeKm : undefined,
    afterKm: Number.isFinite(afterKm) ? afterKm : undefined,
    beforeMinutes: Number.isFinite(beforeMinutes) ? beforeMinutes : undefined,
    afterMinutes: Number.isFinite(afterMinutes) ? afterMinutes : undefined,
    routeMeta: (() => {
      if (!req.query.route_meta_json) return null;
      try { return JSON.parse(req.query.route_meta_json); } catch (e) { return null; }
    })(),
  });
  res.json(result);
}));

// 차종 입력칸 자동완성 — ferry_fare_rules.vehicle_label(쉼표로 구분된 별칭 목록)을 유일한 차종
// 마스터 데이터로 재사용한다. 1글자부터 부분일치 검색하고, 접두일치를 우선 정렬해 보여준다.
router.get('/vehicle-type-suggest', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ suggestions: [] });

  const rows = await db.all('SELECT DISTINCT vehicle_label FROM ferry_fare_rules WHERE is_active = 1');
  const aliasSet = new Set();
  rows.forEach((row) => {
    String(row.vehicle_label || '').split(',').forEach((alias) => {
      const trimmed = alias.trim();
      if (trimmed) aliasSet.add(trimmed);
    });
  });

  const needle = q.toLowerCase();
  const matches = Array.from(aliasSet).filter((alias) => alias.toLowerCase().includes(needle));
  matches.sort((a, b) => {
    const aPrefix = a.toLowerCase().startsWith(needle);
    const bPrefix = b.toLowerCase().startsWith(needle);
    if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
    return a.localeCompare(b, 'ko');
  });

  res.json({ suggestions: matches.slice(0, 8) });
}));

function combineAddress(main, detail) {
  main = (main || '').trim();
  detail = (detail || '').trim();
  return detail ? (main + ' ' + detail) : main;
}

function toPositiveIntOrNull(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function normalizeChatTransition(raw) {
  const value = String(raw || '').trim();
  if (value === 'agent_active' || value === '상담 계속 진행' || value === '상담원 응대중 유지') {
    return 'agent_active';
  }
  if (value === 'closed' || value === '상담 종료') return 'closed';
  return 'closed';
}

async function finalizeChatSessionAfterOrder(options) {
  const { chatSessionId, transition, actorUser, oid, orderId } = options;
  const sessionId = Number(chatSessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return;
  if (!actorUser || actorUser.role !== 'admin') return;

  const existing = await db.get('SELECT id FROM chat_sessions WHERE id = ?', [sessionId]);
  if (!existing) return;

  const nextStatus = normalizeChatTransition(transition);
  if (nextStatus === 'agent_active') {
    await db.run(
      `UPDATE chat_sessions
       SET status = 'agent_active',
           assigned_agent_id = ?,
           updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
       WHERE id = ?`,
      [actorUser.id, sessionId]
    );
  } else {
    await db.run(
      `UPDATE chat_sessions
       SET status = 'closed',
           updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
       WHERE id = ?`,
      [sessionId]
    );
  }

  const systemText = nextStatus === 'closed'
    ? `상담원이 오더 ${oid} 접수를 등록하여 상담을 종료했습니다. (오더: /orders/${orderId})`
    : `상담원이 오더 ${oid} 접수를 등록했습니다. 상담 상태는 상담원 응대중으로 유지합니다. (오더: /orders/${orderId})`;

  const systemMsg = await db.get(
    `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'system', ?) RETURNING *`,
    [sessionId, systemText]
  );
  broadcastMessageAsync(sessionId, systemMsg);
  broadcastSessionListChangedAsync();
}

router.post('/', asyncHandler(async (req, res) => {
  const u = req.session.user;
  const scope = scopeFilter(req);
  const wantsJson = req.get('X-Requested-With') === 'fetch';
  const {
    branch_id, requester_group_id, origin_address, origin_detail_address, origin_contact,
    destination_address, destination_detail_address, destination_contact, vehicle_number, reserved_date, reserved_time,
    vehicle_type, payment_method_id, fare_amount, ferry_fare_amount, memo_customer, memo_billing, chat_session_id, chat_session_transition,
    pickup_reserved_date, pickup_reserved_time,
    order_type, trip_type, final_destination_address, final_destination_address_detail,
    destination_wait_minutes, reservation_hours_bracket,
    origin_lat, origin_lon, origin_sido, origin_sigugun, origin_dong,
    destination_lat, destination_lon, destination_sido, destination_sigugun, destination_dong,
  } = req.body;
  const validOrderTypes = ['dispatch', 'premium', 'daily_driver'];
  const finalOrderType = validOrderTypes.includes(order_type) ? order_type : 'dispatch';
  const waypoints = [].concat(req.body.waypoints || []);
  const waypointDetails = [].concat(req.body.waypoint_details || []);
  const waypointContacts = [].concat(req.body.waypoint_contacts || []);
  const waypointVehicleNumbers = [].concat(req.body.waypoint_vehicle_numbers || []);
  // 경유지 좌표는 그동안 폼에서 보내지도, 저장하지도 않아서 §7-2 자동승격 판정이 읽는
  // order_waypoints.lat/lon이 항상 NULL이었다 — 주소 확정 시 화면에 "✓ 좌표" 배지로 보여주는
  // 값과 실제 저장값이 어긋나지 않도록 함께 저장한다(콜마너 viaList 연동은 여전히 범위 밖).
  const waypointLats = [].concat(req.body.waypoint_lats || []);
  const waypointLons = [].concat(req.body.waypoint_lons || []);
  const finalWaypoints = waypoints
    .map((w, i) => ({
      address: combineAddress(w, waypointDetails[i]),
      addressDetail: waypointDetails[i] || null,
      contact: waypointContacts[i] || null,
      vehicleNumber: waypointVehicleNumbers[i] || null,
      lat: toNumOrNullShared(waypointLats[i]),
      lon: toNumOrNullShared(waypointLons[i]),
    }))
    .filter((w) => w.address);

  const splitVehicle = splitTypeAndPlate(vehicle_type || null, vehicle_number || null);
  const effectiveReservedDate = String(pickup_reserved_date || reserved_date || '').trim();
  const effectiveReservedTime = String(pickup_reserved_time || reserved_time || '').trim();

  const finalBranch = toPositiveIntOrNull(scope.branch_id || branch_id);
  const finalGroup = toPositiveIntOrNull(scope.group_id || requester_group_id);
  let formError = null;
  if (!finalBranch) formError = '지사를 선택해주세요.';
  else if (!String(origin_contact || '').trim()) formError = '출발지 연락처를 입력해주세요.';
  else if (!String(destination_contact || '').trim()) formError = '도착지 연락처를 입력해주세요.';
  else {
    const currentMoment = await getCurrentOperatingMomentFromDb();
    const hoursCheck = await checkOperatingHours(finalBranch, currentMoment.date, currentMoment.time);
    if (!hoursCheck.allowed) formError = hoursCheck.reason;
  }

  if (formError) {
    if (wantsJson) return res.status(400).json({ error: formError });
    // 서로 의존관계 없는 조회들이라 병렬로 실행한다 — 폼 검증 실패로 다시 그려주는 화면이라도
    // 순차 대기로 왕복시간이 곱연산되면 사용자가 다시 시도하기까지 체감 지연이 생긴다.
    const [branches, groups, paymentMethods, favorites] = await Promise.all([
      scope.branch_id
        ? db.all('SELECT * FROM branches WHERE id = ?', [scope.branch_id])
        : db.all("SELECT * FROM branches WHERE status='active' ORDER BY name"),
      db.all('SELECT * FROM groups_tbl ORDER BY name'),
      getEffectivePaymentMethods(finalBranch),
      db.all('SELECT * FROM favorite_addresses WHERE user_id = ? ORDER BY id DESC', [u.id]),
    ]);
    return res.status(400).render('orders/form', {
      title: '오더 등록', order: { ...req.body, waypoints }, branches, groups, paymentMethods, favorites, mode: 'create',
      error: formError,
      defaultBranch: scope.branch_id || '', defaultGroup: scope.group_id || '',
      kakaoJsKey: process.env.KAKAO_JS_KEY || '',
    });
  }

  const finalOriginAddress = combineAddress(origin_address, origin_detail_address);
  const finalDestinationAddress = combineAddress(destination_address, destination_detail_address);

  const toNumOrNull = toNumOrNullShared;
  const originLat = toNumOrNull(origin_lat);
  const originLon = toNumOrNull(origin_lon);
  const destinationLat = toNumOrNull(destination_lat);
  const destinationLon = toNumOrNull(destination_lon);

  const tempOid = 'PENDING-' + Date.now();
  let inserted;
  try {
    inserted = await db.run(`
      INSERT INTO orders (oid, branch_id, requester_group_id, origin_address, origin_address_detail, origin_contact,
        destination_address, destination_address_detail, destination_contact, vehicle_number,
        vehicle_type, reserved_date, reserved_time, payment_method_id, fare_amount, ferry_fare_amount,
        order_type, trip_type, final_destination_address, final_destination_address_detail,
        destination_wait_minutes, reservation_hours_bracket,
        origin_lat, origin_lon, origin_sido, origin_sigugun, origin_dong,
        destination_lat, destination_lon, destination_sido, destination_sigugun, destination_dong,
        status, memo_customer, memo_billing, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '오더등록', ?, ?, ?)
      RETURNING id
    `, [
      tempOid, finalBranch, finalGroup, finalOriginAddress, origin_detail_address || null, origin_contact || null,
      finalDestinationAddress, destination_detail_address || null, destination_contact || null, splitVehicle.vehicleNumber,
      splitVehicle.vehicleType, effectiveReservedDate, effectiveReservedTime, payment_method_id || null, Number(fare_amount) || 0, Number(ferry_fare_amount) || 0,
      finalOrderType, trip_type || null, final_destination_address || null, final_destination_address_detail || null,
      destination_wait_minutes ? Number(destination_wait_minutes) : null,
      ['within_4h', 'within_8h', 'over_8h'].includes(reservation_hours_bracket) ? reservation_hours_bracket : null,
      originLat, originLon, origin_sido || null, origin_sigugun || null, origin_dong || null,
      destinationLat, destinationLon, destination_sido || null, destination_sigugun || null, destination_dong || null,
      memo_customer || null, memo_billing || null, u.id,
    ]);
  } catch (e) {
    const msg = String((e && e.message) || '');
    const missingCompatColumns = e && e.code === '42703' && /(vehicle_type|ferry_fare_amount|memo_billing|order_type|trip_type|final_destination|destination_wait|reservation_hours|origin_lat|origin_lon|origin_sido|origin_sigugun|origin_dong|destination_lat|destination_lon|destination_sido|destination_sigugun|destination_dong)/.test(msg);
    if (!missingCompatColumns) throw e;

    // 구버전 DB(마이그레이션 미적용)에서는 vehicle_type/ferry_fare_amount/memo_billing 없이 저장해도 기본 흐름을 유지한다.
    inserted = await db.run(`
      INSERT INTO orders (oid, branch_id, requester_group_id, origin_address, origin_address_detail, origin_contact,
        destination_address, destination_address_detail, destination_contact, vehicle_number,
        reserved_date, reserved_time, payment_method_id, fare_amount, status, memo_customer, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '오더등록', ?, ?)
      RETURNING id
    `, [
      tempOid, finalBranch, finalGroup, finalOriginAddress, origin_detail_address || null, origin_contact || null,
      finalDestinationAddress, destination_detail_address || null, destination_contact || null, splitVehicle.vehicleNumber,
      effectiveReservedDate, effectiveReservedTime, payment_method_id || null, Number(fare_amount) || 0, memo_customer || null, u.id,
    ]);
  }

  const newId = Number(inserted.lastInsertRowid);
  const oid = 'OID' + (1000 + newId);
  await db.run('UPDATE orders SET oid = ? WHERE id = ?', [oid, newId]);

  for (let i = 0; i < finalWaypoints.length; i++) {
    await db.run(
      'INSERT INTO order_waypoints (order_id, seq, address, address_detail, contact_phone, vehicle_number, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [newId, i + 1, finalWaypoints[i].address, finalWaypoints[i].addressDetail, finalWaypoints[i].contact, finalWaypoints[i].vehicleNumber, finalWaypoints[i].lat, finalWaypoints[i].lon]
    );
  }

  // 구간 릴레이: 경유지 N개 = 구간 N+1개(출발지→경유지1→...→도착지). driver_id는 전부
  // NULL로 시작 — 상세페이지에서 구간별로 나중에 배정한다(기존 단일 기사배정과 같은 흐름,
  // 생성 시점엔 배정 안 함). order_legs 마이그레이션이 아직 안 된 DB에서도 오더 생성
  // 자체는 실패하면 안 되므로(구버전 DB 호환 처리, 위 catch 블록과 같은 방어), 실패해도
  // 무시하고 그 오더는 계속 레거시 단일 배정 화면으로 동작한다.
  try {
    for (let i = 0; i < finalWaypoints.length + 1; i++) {
      await db.run('INSERT INTO order_legs (order_id, seq, driver_id) VALUES (?, ?, NULL)', [newId, i + 1]);
    }
  } catch (e) {
    console.error('order_legs 생성 실패(마이그레이션 미적용 가능성, 무시하고 진행):', e.message);
  }

  await db.run(`
    INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note)
    VALUES (?, ?, NULL, '오더등록', '최초 등록')
  `, [newId, u.id]);

  // 콜마너 오더접수 — 오더 등록(생성) 시점에 바로 나간다(사용자 확정 사항). registerOrderWithCallmaner가
  // 항상 대기(status='5')로 등록하므로(lib/callmaner.js), 담당자가 검토하기 전에 곧바로 배차
  // 대상이 되지는 않는다. await로 기다리는 이유는 POST /:id/status와 동일하다 — 실측 약 1초라
  // 체감 지연이 적고, Vercel 서버리스는 응답 후 인스턴스를 얼려 기다리지 않은 백그라운드 작업이
  // 완료되지 않을 수 있다. 실패는 함수 안에서 잡아 DB에 기록하므로 오더 등록 자체는 항상
  // 성공한다. 이후 상태를 접수/대기로 바꾸면(POST /:id/status) 실패했던 등록이 재시도된다
  // (registerOrderWithCallmaner는 conf_slip이 이미 있으면 조용히 건너뛰어 중복 등록하지 않음).
  await registerOrderWithCallmaner(newId, finalBranch);

  // §7-2 자동 승격 판정 — premium 오더 접수 후 실제 소요시간이 8시간 이상이면 daily_driver로 전환
  // fire-and-forget: 경로탐색 실패/지연은 오더 등록 자체를 막지 않는다.
  if (finalOrderType === 'premium') {
    (async () => {
      try {
        const UPGRADE_THRESHOLD_SECONDS = 8 * 3600;
        const originCoord = await db.get('SELECT origin_lat AS lat, origin_lon AS lon FROM orders WHERE id = ?', [newId])
          .catch(() => null);

        // 좌표 미확보 시 1순위(계산값) 불가 → 2순위(사용자 답변 시간구간) 판정
        if (!originCoord || !originCoord.lat) {
          if (reservation_hours_bracket === 'over_8h') {
            await db.run('UPDATE orders SET order_type = ? WHERE id = ?', ['daily_driver', newId]);
            await db.run(
              `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note) VALUES (?, ?, NULL, NULL, ?)`,
              [newId, u.id, '오더 타입 자동 승격: daily_driver (시간구간 over_8h 기준)']
            );
          }
          return;
        }

        // 좌표 있으면 Kakao Mobility로 실제 소요시간 계산
        const kakaoKey = process.env.KAKAO_REST_API_KEY;
        if (!kakaoKey) return;

        const originLatLon = await db.get(
          'SELECT origin_lat AS lat, origin_lon AS lon FROM orders WHERE id = ?', [newId]
        );
        const destLatLon = await db.get(
          'SELECT destination_lat AS lat, destination_lon AS lon FROM orders WHERE id = ?', [newId]
        );
        if (!originLatLon || !originLatLon.lat || !destLatLon || !destLatLon.lat) return;

        const waypointCoords = await db.all(
          'SELECT lat, lon FROM order_waypoints WHERE order_id = ? ORDER BY seq', [newId]
        );

        const toCoordStr = (r) => `${r.lon},${r.lat}`;
        let routeDuration = 0;

        if (!waypointCoords.length) {
          const qs = new URLSearchParams({
            origin: toCoordStr(originLatLon),
            destination: toCoordStr(destLatLon),
            priority: 'RECOMMEND',
          });
          const r = await fetch('https://apis-navi.kakaomobility.com/v1/future/directions?' + qs.toString(), {
            headers: { Authorization: 'KakaoAK ' + kakaoKey },
          });
          if (r.ok) {
            const d = await r.json();
            const route = d.routes && d.routes[0];
            if (route && route.result_code === 0) routeDuration = route.summary.duration || 0;
          }
        } else {
          const body = {
            origin: { x: originLatLon.lon, y: originLatLon.lat },
            destination: { x: destLatLon.lon, y: destLatLon.lat },
            waypoints: waypointCoords.map((w) => ({ x: w.lon, y: w.lat })),
            priority: 'RECOMMEND',
          };
          const r = await fetch('https://apis-navi.kakaomobility.com/v1/waypoints/directions', {
            method: 'POST',
            headers: { Authorization: 'KakaoAK ' + kakaoKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (r.ok) {
            const d = await r.json();
            const route = d.routes && d.routes[0];
            if (route && route.result_code === 0) routeDuration = route.summary.duration || 0;
          }
        }

        // 대기시간 합산 (경유지 대기 + 도착지 대기)
        const waypointWait = await db.all(
          'SELECT COALESCE(wait_minutes, 0) AS wait_minutes FROM order_waypoints WHERE order_id = ?', [newId]
        );
        const totalWaitSeconds = waypointWait.reduce((s, w) => s + Number(w.wait_minutes || 0) * 60, 0)
          + (destination_wait_minutes ? Number(destination_wait_minutes) * 60 : 0);

        const totalSeconds = routeDuration + totalWaitSeconds;
        if (totalSeconds >= UPGRADE_THRESHOLD_SECONDS) {
          await db.run('UPDATE orders SET order_type = ? WHERE id = ?', ['daily_driver', newId]);
          await db.run(
            `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note) VALUES (?, ?, NULL, NULL, ?)`,
            [newId, u.id, `오더 타입 자동 승격: daily_driver (${Math.round(totalSeconds / 3600)}시간 초과)`]
          );
        }
      } catch (e) {
        console.error('자동 승격 판정 실패(무시하고 진행):', e.message);
      }
    })();
  }

  try {
    await notify({
      branchId: finalBranch, eventType: 'order_events', excludeUserId: u.id,
      title: '새 오더 등록', body: `${oid} 오더가 등록되었습니다.`, url: `/orders/${newId}`,
    });
  } catch (e) { console.error('알림 발송 실패:', e.message); }

  try {
    await finalizeChatSessionAfterOrder({
      chatSessionId: chat_session_id,
      transition: chat_session_transition,
      actorUser: u,
      oid,
      orderId: newId,
    });
  } catch (e) {
    console.error('오더 등록 후 상담 세션 상태 연동 실패:', e.message);
  }

  broadcastOrderListChangedAsync();
  if (wantsJson) return res.json({ orderId: newId, oid });
  res.redirect('/orders/' + newId);
}));

// 구간 릴레이: order_legs 행을 정류장 라벨(출발지→경유지1→...→도착지)과 짝지어 뷰에서
// 바로 렌더링할 수 있는 형태로 만든다. 주소는 저장돼 있지 않으므로(마이그레이션 주석 참고)
// 매번 order/waypoints에서 조립한다 — 오더가 생성 후 수정 불가라 매번 같은 결과가 나온다.
// order_legs 마이그레이션 이전에 생성된 오더는 빈 배열을 반환 → 뷰가 기존 단일 배정
// UI로 자동 폴백한다.
async function buildOrderLegs(orderId, order, waypoints) {
  let legRows;
  try {
    legRows = await db.all(`
      SELECT ol.seq, ol.driver_id, d.name AS driver_name, d.phone AS driver_phone
      FROM order_legs ol
      LEFT JOIN drivers d ON d.id = ol.driver_id
      WHERE ol.order_id = ?
      ORDER BY ol.seq ASC
    `, [orderId]);
  } catch (e) {
    return []; // order_legs 테이블이 아직 없는 DB(마이그레이션 미적용) — 조용히 폴백
  }
  if (!legRows.length) return [];

  const stopLabels = [order.origin_address, ...waypoints.map((w) => w.address), order.destination_address];
  return legRows.map((row) => ({
    seq: row.seq,
    fromLabel: stopLabels[row.seq - 1] || '-',
    toLabel: stopLabels[row.seq] || '-',
    driverId: row.driver_id,
    driverName: row.driver_name,
    driverPhone: row.driver_phone,
  }));
}

// origin_address/destination_address는 combineAddress(main, detail)로 이미 합쳐진 문자열이라
// (L591-595), OrderForm.js의 별도 "주소"/"상세주소" 두 칸에 되돌려 채우려면 detail 접미사를
// 역산해서 잘라내야 한다. combineAddress가 항상 `main + ' ' + detail` 형태로만 합치므로
// 안전하게 역산 가능하다.
function splitCombinedAddress(combined, detail) {
  const c = String(combined || '');
  const d = String(detail || '').trim();
  if (d && c.endsWith(' ' + d)) return c.slice(0, c.length - d.length - 1);
  return c;
}

// GET /orders/:id/data.json + POST /orders/:id(수정)가 공유하는 스코프/조회 로직 —
// loadOrderInScope와 별개인 이유는 client 역할도 "조회"는 허용해야 해서(client는 읽기전용
// edit 폼이 아니라 OrderReadOnlyView를 보지만, 그 컴포넌트도 같은 data.json을 쓴다). 기존
// GET /:id(EJS)와 같은 JOIN 형태를 그대로 재사용한다.
async function loadOrderForView(req, res) {
  const order = await db.get(`
    SELECT o.*, b.name AS branch_name, g.name AS group_name, pm.name AS payment_method_name, d.name AS driver_name,
      au.name AS assigned_agent_name
    FROM orders o
    JOIN branches b ON b.id = o.branch_id
    LEFT JOIN groups_tbl g ON g.id = o.requester_group_id
    LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
    LEFT JOIN drivers d ON d.id = o.assigned_driver_id
    LEFT JOIN users au ON au.id = o.assigned_agent_id
    WHERE o.id = ?
  `, [req.params.id]);
  if (!order) { res.status(404); return null; }
  const scope = scopeFilter(req);
  if (scope.branch_id && order.branch_id !== scope.branch_id) { res.status(403); return null; }
  if (scope.group_id && order.requester_group_id !== scope.group_id) { res.status(403); return null; }
  return order;
}

// GET /:id(EJS)가 쓰는 것과 같은 부가 데이터(변경이력/드라이버/구간/사진/상태목록)를
// 새 React 상세페이지의 관리자 패널(OrderDetailAdminPanels.js)에도 그대로 실어준다 —
// 그 패널이 재사용하는 기존 라우트(/:id/status, /:id/driver, /:id/legs/drivers)가
// 기대하는 것과 동일한 선택지 데이터다.
router.get('/:id/data.json', asyncHandler(async (req, res) => {
  const order = await loadOrderForView(req, res);
  if (!order) return res.json({ error: '오더를 찾을 수 없거나 접근 권한이 없습니다.' });

  const scope = scopeFilter(req);
  const u = req.session.user;
  const [waypoints, formInit, history, statusConfig, drivers, photoSettingsRow] = await Promise.all([
    db.all('SELECT * FROM order_waypoints WHERE order_id = ? ORDER BY seq ASC', [req.params.id]),
    buildOrderFormInitData(scope, u.id),
    db.all(`
      SELECT h.*, u.name AS actor_name
      FROM order_status_history h
      LEFT JOIN users u ON u.id = h.actor_user_id
      WHERE h.order_id = ?
      ORDER BY h.id ASC
    `, [req.params.id]),
    getEffectiveStatuses(order.branch_id),
    db.all("SELECT * FROM drivers WHERE branch_id = ? AND status = 'active' ORDER BY name", [order.branch_id]),
    db.get('SELECT * FROM branch_photo_settings WHERE branch_id = ?', [order.branch_id]),
  ]);
  const photoSettings = photoSettingsRow || {};
  const canViewPhotos = u.role === 'admin'
    || (u.role === 'branch_manager' && !!photoSettings.branch_manager_can_view)
    || (u.role === 'client' && !!photoSettings.client_can_view);
  const photos = canViewPhotos ? await db.all('SELECT * FROM order_photos WHERE order_id = ? ORDER BY id DESC', [req.params.id]) : [];
  const legs = await buildOrderLegs(req.params.id, order, waypoints);

  res.json({
    ...formInit,
    order: {
      ...order,
      origin_address: splitCombinedAddress(order.origin_address, order.origin_address_detail),
      origin_detail_address: order.origin_address_detail || '',
      destination_address: splitCombinedAddress(order.destination_address, order.destination_address_detail),
      destination_detail_address: order.destination_address_detail || '',
      waypoints: waypoints.map((w) => ({
        address: splitCombinedAddress(w.address, w.address_detail),
        detail: w.address_detail || '',
        contact: w.contact_phone || '',
        vehicleNumber: w.vehicle_number || '',
        // 저장된 경유지 좌표를 그대로 내려준다 — 폼이 "✓ 좌표" 배지와 경로 계산에 쓰고,
        // 저장 시 다시 보내므로 다시 확정하지 않아도 좌표가 유지된다.
        lat: w.lat, lon: w.lon,
      })),
    },
    rawWaypoints: waypoints,
    history, drivers, photos, canViewPhotos, legs,
    ORDER_STATUSES: statusConfig.map((s) => s.status_code),
    baseUrl: req.protocol + '://' + req.get('host'),
    currentUserRole: u.role,
    currentUserPhone: u.phone || '',
    currentUser: u,
  });
}));

// GET /:id/data.json와 같은 스코프 규칙(loadOrderForView)을 쓰되, 404/403 응답은
// loadOrderInScope와 같은 스타일(HTML render/send)로 맞춘다 — 오더 수정은 이제 client도
// 자기 소속 오더에 한해 직접 할 수 있다(상태변경/기사배정/관리자메모는 여전히
// loadOrderInScope로 admin/branch_manager만 허용).
async function loadOrderForEdit(req, res) {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!order) { res.status(404).send('오더를 찾을 수 없습니다.'); return null; }
  const scope = scopeFilter(req);
  if (scope.branch_id && order.branch_id !== scope.branch_id) { res.status(403).render('403', { title: '접근 권한 없음' }); return null; }
  if (scope.group_id && order.requester_group_id !== scope.group_id) { res.status(403).render('403', { title: '접근 권한 없음' }); return null; }
  return order;
}

function formatMoneyForHistory(n) {
  return (Number(n) || 0).toLocaleString('ko-KR') + '원';
}

// 노트 한 줄이 지나치게 길어지지 않도록 메모류만 잘라낸다 — "무엇으로 바뀌었는지"는
// 필요하지만 메모 전문을 이력 한 줄에 다 넣을 필요는 없다.
function truncateForHistory(text, max) {
  const s = String(text || '').trim();
  if (!s) return '(빈 값)';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

router.post('/:id', asyncHandler(async (req, res) => {
  const order = await loadOrderForEdit(req, res);
  if (!order) return;
  const u = req.session.user;
  const isAdmin = u.role === 'admin';
  const isClient = u.role === 'client';
  const wantsJson = req.get('X-Requested-With') === 'fetch';
  const {
    branch_id, requester_group_id, origin_address, origin_detail_address, origin_contact,
    destination_address, destination_detail_address, destination_contact, vehicle_number, reserved_date, reserved_time,
    vehicle_type, payment_method_id, fare_amount, ferry_fare_amount, memo_customer, memo_billing,
    pickup_reserved_date, pickup_reserved_time,
  } = req.body;
  const waypoints = [].concat(req.body.waypoints || []);
  const waypointDetails = [].concat(req.body.waypoint_details || []);
  const waypointContacts = [].concat(req.body.waypoint_contacts || []);
  const waypointVehicleNumbers = [].concat(req.body.waypoint_vehicle_numbers || []);
  // 경유지 좌표는 그동안 폼에서 보내지도, 저장하지도 않아서 §7-2 자동승격 판정이 읽는
  // order_waypoints.lat/lon이 항상 NULL이었다 — 주소 확정 시 화면에 "✓ 좌표" 배지로 보여주는
  // 값과 실제 저장값이 어긋나지 않도록 함께 저장한다(콜마너 viaList 연동은 여전히 범위 밖).
  const waypointLats = [].concat(req.body.waypoint_lats || []);
  const waypointLons = [].concat(req.body.waypoint_lons || []);
  const finalWaypoints = waypoints
    .map((w, i) => ({
      address: combineAddress(w, waypointDetails[i]),
      addressDetail: waypointDetails[i] || null,
      contact: waypointContacts[i] || null,
      vehicleNumber: waypointVehicleNumbers[i] || null,
      lat: toNumOrNullShared(waypointLats[i]),
      lon: toNumOrNullShared(waypointLons[i]),
    }))
    .filter((w) => w.address);

  const splitVehicle = splitTypeAndPlate(vehicle_type || null, vehicle_number || null);
  const effectiveReservedDate = String(pickup_reserved_date || reserved_date || '').trim();
  const effectiveReservedTime = String(pickup_reserved_time || reserved_time || '').trim();
  // OrderForm.js는 branch_id 선택칸을 admin에게만, requester_group_id 선택칸을 client가
  // 아닌 역할에게만 보여준다 — 서버도 그 UI의 진실을 그대로 강제한다. 그렇지 않으면
  // branch_manager/client가 폼 필드 자체엔 없는 값을 요청 바디 조작으로 밀어넣어 오더를
  // 다른 지사/법인으로 옮겨버릴 수 있다(scope 체크는 "지금" 소속만 확인하지, 수정 후
  // 어디로 옮기는지는 막지 않았던 gap).
  const finalBranch = isAdmin ? (toPositiveIntOrNull(branch_id) || order.branch_id) : order.branch_id;
  const finalGroup = isClient ? order.requester_group_id : toPositiveIntOrNull(requester_group_id);
  const finalOriginAddress = combineAddress(origin_address, origin_detail_address);
  const finalDestinationAddress = combineAddress(destination_address, destination_detail_address);

  // 이 라우트는 OrderForm.js(React edit 모드)만 fetch()로 호출하므로 항상 JSON으로 응답한다
  // — 생성 폼과 달리 legacy EJS 폴백 렌더링 대상이 아니다. 운영시간 체크는 일부러 생략한다
  // (이미 접수된 오더의 오타 수정 같은 걸 "지금은 영업시간이 아니라서" 막는 건 신규 접수
  // 차단과 다른 문제라 이번 계획 범위에서 제외).
  let formError = null;
  if (!finalBranch) formError = '지사를 선택해주세요.';
  else if (!String(origin_contact || '').trim()) formError = '출발지 연락처를 입력해주세요.';
  else if (!String(destination_contact || '').trim()) formError = '도착지 연락처를 입력해주세요.';
  if (formError) return res.status(400).json({ error: formError });

  const existingWaypointsFull = await db.all('SELECT * FROM order_waypoints WHERE order_id = ? ORDER BY seq ASC', [req.params.id]);

  // "수정이력" — 필드 이름뿐 아니라 실제로 "무엇에서 무엇으로" 바뀌었는지까지 사람이
  // 읽을 수 있는 문장으로 모아서 order_status_history에 note로 남긴다(상태는 그대로 두고
  // old_status=new_status로 기록 — 별도 테이블/마이그레이션 없이 기존 변경이력
  // 타임라인에 자연스럽게 얹힌다).
  const diffs = [];
  if (finalOriginAddress !== order.origin_address || (origin_detail_address || null) !== order.origin_address_detail) {
    diffs.push(`출발지: ${order.origin_address || '(빈 값)'} → ${finalOriginAddress || '(빈 값)'}`);
  }
  if ((origin_contact || null) !== order.origin_contact) {
    diffs.push(`출발지 연락처: ${order.origin_contact || '(빈 값)'} → ${origin_contact || '(빈 값)'}`);
  }
  if (finalDestinationAddress !== order.destination_address || (destination_detail_address || null) !== order.destination_address_detail) {
    diffs.push(`도착지: ${order.destination_address || '(빈 값)'} → ${finalDestinationAddress || '(빈 값)'}`);
  }
  if ((destination_contact || null) !== order.destination_contact) {
    diffs.push(`도착지 연락처: ${order.destination_contact || '(빈 값)'} → ${destination_contact || '(빈 값)'}`);
  }
  if (splitVehicle.vehicleType !== (order.vehicle_type || null) || splitVehicle.vehicleNumber !== (order.vehicle_number || null)) {
    const oldVehicle = [order.vehicle_type, order.vehicle_number].filter(Boolean).join('/') || '(빈 값)';
    const newVehicle = [splitVehicle.vehicleType, splitVehicle.vehicleNumber].filter(Boolean).join('/') || '(빈 값)';
    diffs.push(`차종/차량번호: ${oldVehicle} → ${newVehicle}`);
  }
  if (effectiveReservedDate !== order.reserved_date || effectiveReservedTime !== order.reserved_time) {
    diffs.push(`예약일시: ${order.reserved_date} ${order.reserved_time} → ${effectiveReservedDate} ${effectiveReservedTime}`);
  }
  if (String(payment_method_id || '') !== String(order.payment_method_id || '')) {
    const [oldPm, newPm] = await Promise.all([
      order.payment_method_id ? db.get('SELECT name FROM payment_methods WHERE id = ?', [order.payment_method_id]) : null,
      payment_method_id ? db.get('SELECT name FROM payment_methods WHERE id = ?', [payment_method_id]) : null,
    ]);
    diffs.push(`결제방식: ${oldPm ? oldPm.name : '(선택 안 함)'} → ${newPm ? newPm.name : '(선택 안 함)'}`);
  }
  if ((Number(fare_amount) || 0) !== (Number(order.fare_amount) || 0)) {
    diffs.push(`요금: ${formatMoneyForHistory(order.fare_amount)} → ${formatMoneyForHistory(fare_amount)}`);
  }
  if ((Number(ferry_fare_amount) || 0) !== (Number(order.ferry_fare_amount) || 0)) {
    diffs.push(`도선료: ${formatMoneyForHistory(order.ferry_fare_amount)} → ${formatMoneyForHistory(ferry_fare_amount)}`);
  }
  if ((memo_customer || null) !== order.memo_customer) {
    diffs.push(`고객사 메모: ${truncateForHistory(order.memo_customer, 20)} → ${truncateForHistory(memo_customer, 20)}`);
  }
  if ((memo_billing || null) !== order.memo_billing) {
    diffs.push(`업체요청사항: ${truncateForHistory(order.memo_billing, 20)} → ${truncateForHistory(memo_billing, 20)}`);
  }
  if (
    existingWaypointsFull.length !== finalWaypoints.length
    || finalWaypoints.some((w, i) => {
      const prev = existingWaypointsFull[i];
      return !prev || w.address !== prev.address || (w.addressDetail || null) !== prev.address_detail
        || (w.contact || null) !== prev.contact_phone || (w.vehicleNumber || null) !== prev.vehicle_number;
    })
  ) {
    if (existingWaypointsFull.length !== finalWaypoints.length) {
      diffs.push(`경유지: ${existingWaypointsFull.length}개 → ${finalWaypoints.length}개`);
    } else {
      diffs.push('경유지 내용 수정');
    }
  }

  await db.run(`
    UPDATE orders SET branch_id = ?, requester_group_id = ?, origin_address = ?, origin_address_detail = ?, origin_contact = ?,
      destination_address = ?, destination_address_detail = ?, destination_contact = ?, vehicle_number = ?,
      vehicle_type = ?, reserved_date = ?, reserved_time = ?, payment_method_id = ?, fare_amount = ?, ferry_fare_amount = ?,
      memo_customer = ?, memo_billing = ?,
      -- 콜마너 오더접수에 필요한 좌표/행정구역도 함께 저장한다. 그동안 이 UPDATE에서 빠져 있어서
      -- 오더 상세에서 주소를 다시 확정해도 좌표가 DB에 반영되지 않았다(폼은 보내고 있었는데
      -- 서버가 버렸음). COALESCE로 감싸 값이 안 온 경우 기존 값을 지우지 않는다.
      origin_lat = COALESCE(?, origin_lat), origin_lon = COALESCE(?, origin_lon),
      origin_sido = COALESCE(?, origin_sido), origin_sigugun = COALESCE(?, origin_sigugun), origin_dong = COALESCE(?, origin_dong),
      destination_lat = COALESCE(?, destination_lat), destination_lon = COALESCE(?, destination_lon),
      destination_sido = COALESCE(?, destination_sido), destination_sigugun = COALESCE(?, destination_sigugun), destination_dong = COALESCE(?, destination_dong),
      updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = ?
  `, [
    finalBranch, finalGroup, finalOriginAddress, origin_detail_address || null, origin_contact || null,
    finalDestinationAddress, destination_detail_address || null, destination_contact || null, splitVehicle.vehicleNumber,
    splitVehicle.vehicleType, effectiveReservedDate, effectiveReservedTime, payment_method_id || null,
    Number(fare_amount) || 0, Number(ferry_fare_amount) || 0, memo_customer || null, memo_billing || null,
    toNumOrNullShared(req.body.origin_lat), toNumOrNullShared(req.body.origin_lon),
    req.body.origin_sido || null, req.body.origin_sigugun || null, req.body.origin_dong || null,
    toNumOrNullShared(req.body.destination_lat), toNumOrNullShared(req.body.destination_lon),
    req.body.destination_sido || null, req.body.destination_sigugun || null, req.body.destination_dong || null,
    req.params.id,
  ]);

  if (diffs.length > 0) {
    await db.run(`
      INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note)
      VALUES (?, ?, ?, ?, ?)
    `, [req.params.id, u.id, order.status, order.status, diffs.join('; ')]);
  }

  const existingWaypoints = existingWaypointsFull;
  const legCountUnchanged = existingWaypoints.length === finalWaypoints.length;

  await db.run('DELETE FROM order_waypoints WHERE order_id = ?', [req.params.id]);
  for (let i = 0; i < finalWaypoints.length; i++) {
    await db.run(
      'INSERT INTO order_waypoints (order_id, seq, address, address_detail, contact_phone, vehicle_number, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.params.id, i + 1, finalWaypoints[i].address, finalWaypoints[i].addressDetail, finalWaypoints[i].contact, finalWaypoints[i].vehicleNumber, finalWaypoints[i].lat, finalWaypoints[i].lon]
    );
  }

  // 경유지 개수가 안 바뀌면 기존 order_legs(구간별 기사 배정)를 그대로 둔다. 개수가
  // 바뀌면 구간 구조 자체가 안 맞으므로 지우고 새 스켈레톤(전부 미배정)으로 재생성한다
  // — 이 경우 기존 구간별 배정은 초기화된다(계획 단계에서 합의된 트레이드오프).
  let legsReset = false;
  if (!legCountUnchanged) {
    try {
      await db.run('DELETE FROM order_legs WHERE order_id = ?', [req.params.id]);
      for (let i = 0; i < finalWaypoints.length + 1; i++) {
        await db.run('INSERT INTO order_legs (order_id, seq, driver_id) VALUES (?, ?, NULL)', [req.params.id, i + 1]);
      }
      legsReset = true;
    } catch (e) {
      console.error('order_legs 재생성 실패(마이그레이션 미적용 가능성, 무시하고 진행):', e.message);
    }
  }

  broadcastOrderListChangedAsync();
  if (wantsJson) return res.json({ orderId: Number(req.params.id), oid: order.oid, legsReset });
  res.redirect('/orders/' + req.params.id + (legsReset ? '?notice=legs_reset' : ''));
}));

router.post('/:id/admin-memo', asyncHandler(async (req, res) => {
  const order = await loadOrderInScope(req, res);
  if (!order) return;
  const { memo_admin } = req.body;
  await db.run(
    `UPDATE orders SET memo_admin = ?, updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [memo_admin || null, req.params.id]
  );
  broadcastOrderListChangedAsync();
  res.redirect('/orders/' + req.params.id);
}));

// "내가 담당하기" — 오더등록 상태에서 누르면 상담원이 확인했다는 뜻으로 대기(확인중)으로
// 전환. 이미 다른 상태로 넘어간 오더에 대해서도(담당자가 아직 없다면) 담당자만 지정할 수
// 있게 해서 "누가 담당인지"는 항상 표시 가능하게 한다.
router.post('/:id/assign-self', asyncHandler(async (req, res) => {
  const order = await loadOrderInScope(req, res);
  if (!order) return;
  const u = req.session.user;

  if (order.status === '오더등록') {
    await db.run(
      `UPDATE orders SET assigned_agent_id = ?, status = '대기(확인중)',
        updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
      [u.id, req.params.id]
    );
    await db.run(
      `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note)
       VALUES (?, ?, ?, ?, ?)`,
      [req.params.id, u.id, order.status, '대기(확인중)', `담당자 지정: ${u.name}`]
    );
  } else if (!order.assigned_agent_id) {
    await db.run('UPDATE orders SET assigned_agent_id = ? WHERE id = ?', [u.id, req.params.id]);
  }

  broadcastOrderListChangedAsync();
  res.redirect('/orders/' + req.params.id);
}));

// VOC(사고/과태료/클레임) 접수 — 체크 해제하고 저장하면 해당 note가 다시 비워지므로
// "체크 여부"를 따로 저장할 필요 없이 note 존재 자체가 체크 상태를 의미한다.
router.post('/:id/voc', asyncHandler(async (req, res) => {
  const order = await loadOrderForVoc(req, res);
  if (!order) return;
  const { voc_accident, voc_accident_note, voc_fine, voc_fine_note, voc_claim, voc_claim_note } = req.body;
  await db.run(
    `UPDATE orders SET voc_accident_note = ?, voc_fine_note = ?, voc_claim_note = ?,
      updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [
      voc_accident ? (voc_accident_note || '') : null,
      voc_fine ? (voc_fine_note || '') : null,
      voc_claim ? (voc_claim_note || '') : null,
      req.params.id,
    ]
  );
  broadcastOrderListChangedAsync();
  res.redirect('/orders/' + req.params.id);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const order = await db.get(`
    SELECT o.*, b.name AS branch_name, g.name AS group_name, pm.name AS payment_method_name, d.name AS driver_name,
      au.name AS assigned_agent_name
    FROM orders o
    JOIN branches b ON b.id = o.branch_id
    LEFT JOIN groups_tbl g ON g.id = o.requester_group_id
    LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
    LEFT JOIN drivers d ON d.id = o.assigned_driver_id
    LEFT JOIN users au ON au.id = o.assigned_agent_id
    WHERE o.id = ?
  `, [req.params.id]);
  if (!order) return res.status(404).send('오더를 찾을 수 없습니다.');

  const scope = scopeFilter(req);
  if (scope.branch_id && order.branch_id !== scope.branch_id) return res.status(403).render('403', { title: '접근 권한 없음' });
  if (scope.group_id && order.requester_group_id !== scope.group_id) return res.status(403).render('403', { title: '접근 권한 없음' });

  // 서로 의존관계 없는 조회들이라 순차로 기다릴 필요가 없다 — 병렬로 실행해서 왕복시간이
  // 곱연산되는 걸 막는다(GET /new에 이미 적용된 것과 같은 패턴).
  const [history, waypoints, statusConfig, drivers, photoSettingsRow] = await Promise.all([
    db.all(`
      SELECT h.*, u.name AS actor_name
      FROM order_status_history h
      LEFT JOIN users u ON u.id = h.actor_user_id
      WHERE h.order_id = ?
      ORDER BY h.id ASC
    `, [req.params.id]),
    db.all('SELECT * FROM order_waypoints WHERE order_id = ? ORDER BY seq ASC', [req.params.id]),
    getEffectiveStatuses(order.branch_id),
    db.all("SELECT * FROM drivers WHERE branch_id = ? AND status = 'active' ORDER BY name", [order.branch_id]),
    db.get('SELECT * FROM branch_photo_settings WHERE branch_id = ?', [order.branch_id]),
  ]);
  const photoSettings = photoSettingsRow || {};

  const u = req.session.user;
  const canViewPhotos = u.role === 'admin'
    || (u.role === 'branch_manager' && !!photoSettings.branch_manager_can_view)
    || (u.role === 'client' && !!photoSettings.client_can_view);
  const photos = canViewPhotos ? await db.all('SELECT * FROM order_photos WHERE order_id = ? ORDER BY id DESC', [req.params.id]) : [];
  const legs = await buildOrderLegs(req.params.id, order, waypoints);

  res.render('orders/detail', {
    title: '오더 상세 - ' + order.oid, order, history, waypoints, drivers, photos, canViewPhotos, legs,
    baseUrl: req.protocol + '://' + req.get('host'),
    ORDER_STATUSES: statusConfig.map((s) => s.status_code),
  });
}));

// 오더 등록 직후 화면(오더 상세/AI 인테이크 챗봇)에서 콜마너 오더접수 결과를 짧게 폴링해
// 실패 시 팝업으로 알려주기 위한 상태 조회 — 등록 자체는 fire-and-forget이라 등록 응답
// 시점에는 아직 콜마너 API 호출이 끝나지 않았을 수 있다(public/js/callmaner-alert.js 참고).
router.get('/:id/callmaner-status.json', asyncHandler(async (req, res) => {
  // o.*로 받는다 — callmaner_last_error_code처럼 나중에 추가되는 컬럼을 열거하면 마이그레이션
  // 미적용 DB에서 이 조회 자체가 깨져 폴링(callmaner-alert.js)이 통째로 실패한다.
  const order = await db.get(`
    SELECT o.*, b.callmaner_enabled
    FROM orders o JOIN branches b ON b.id = o.branch_id
    WHERE o.id = ?
  `, [req.params.id]);
  if (!order) return res.status(404).json({ error: '오더를 찾을 수 없습니다.' });

  const scope = scopeFilter(req);
  if (scope.branch_id && order.branch_id !== scope.branch_id) return res.status(403).json({ error: '접근 권한 없음' });
  if (scope.group_id && order.requester_group_id !== scope.group_id) return res.status(403).json({ error: '접근 권한 없음' });

  res.json({
    enabled: !!order.callmaner_enabled,
    // "결과를 기다리는 중"은 콜마너 전송 대상 상태(접수/대기)일 때만 참이다 — 오더 생성 직후
    // (status='오더등록')에는 전송 자체를 하지 않으므로, 이 조건이 없으면 화면에 "콜마너 등록
    // 확인 중"이 영원히 떠 있게 된다(결과가 올 리 없다).
    pending: !!order.callmaner_enabled
      && CALLMANER_TRIGGER_STATUSES.includes(order.status)
      && !order.callmaner_conf_slip
      && !order.callmaner_last_error,
    error: order.callmaner_last_error || null,
    errorCode: order.callmaner_last_error_code || null,
    confSlip: order.callmaner_conf_slip || null,
  });
}));

// client는 세 작업 모두 금지, branch_manager는 자기 지사 소속 오더만 — 지금까지는 role만
// 확인하고 지사 소속은 확인하지 않아서, branch_manager 계정이 URL의 오더 id만 바꾸면 다른
// 지사 오더의 기사/상태/요금까지 마음대로 바꿀 수 있는 권한 우회(IDOR)가 있었다.
async function loadOrderInScope(req, res) {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!order) { res.status(404).send('오더를 찾을 수 없습니다.'); return null; }
  const u = req.session.user;
  if (u.role === 'client') { res.status(403).render('403', { title: '접근 권한 없음' }); return null; }
  if (u.role === 'branch_manager' && order.branch_id !== u.branch_id) {
    res.status(403).render('403', { title: '접근 권한 없음' });
    return null;
  }
  return order;
}

// VOC(사고/과태료/클레임) 접수는 고객사(client)도 자기 오더에 대해 직접 할 수 있어야 한다
// (사용자 확정 사항 — 실제로 사고를 겪는 쪽이 고객사라 관리자를 거치지 않고 바로 남기는 게
// 자연스럽다). loadOrderInScope는 client를 전부 403으로 막으므로 쓸 수 없고, 대신
// scopeFilter로 "자기 지사/법인 오더인지"만 확인한다 — 다른 법인 오더 id를 URL에 넣어도
// group_id가 달라 403이 된다(IDOR 방지). 관리자/지사장은 기존과 동일하게 전체/자기 지사.
async function loadOrderForVoc(req, res) {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!order) { res.status(404).send('오더를 찾을 수 없습니다.'); return null; }
  const scope = scopeFilter(req);
  if (scope.branch_id && order.branch_id !== scope.branch_id) {
    res.status(403).render('403', { title: '접근 권한 없음' });
    return null;
  }
  if (scope.group_id && order.requester_group_id !== scope.group_id) {
    res.status(403).render('403', { title: '접근 권한 없음' });
    return null;
  }
  return order;
}

router.post('/:id/driver', asyncHandler(async (req, res) => {
  const order = await loadOrderInScope(req, res);
  if (!order) return;
  const u = req.session.user;
  const { driver_id } = req.body;
  await db.run('UPDATE orders SET assigned_driver_id = ? WHERE id = ?', [driver_id || null, req.params.id]);

  if (driver_id) {
    try {
      await notify({
        branchId: order.branch_id, eventType: 'driver_assign', excludeUserId: u.id,
        title: '기사 배정', body: `${order.oid} 오더에 기사가 배정되었습니다.`, url: `/orders/${order.id}`,
      });
    } catch (e) { console.error('알림 발송 실패:', e.message); }
  }

  broadcastOrderListChangedAsync();
  res.redirect('/orders/' + req.params.id);
}));

// 구간 릴레이: 구간(leg)별 기사 배정. order_legs가 없는(마이그레이션 이전) 오더는
// views/orders/detail.ejs가 이 폼 자체를 안 그려주므로 여기 도달하지 않는다 — 그런
// 오더는 계속 위 POST /:id/driver(단일 배정)만 쓴다.
router.post('/:id/legs/drivers', asyncHandler(async (req, res) => {
  const order = await loadOrderInScope(req, res);
  if (!order) return;
  const u = req.session.user;
  const legSeqs = [].concat(req.body.leg_seq || []);
  const legDriverIds = [].concat(req.body.leg_driver_id || []);

  let anyAssigned = false;
  for (let i = 0; i < legSeqs.length; i++) {
    const driverId = legDriverIds[i] || null;
    await db.run('UPDATE order_legs SET driver_id = ? WHERE order_id = ? AND seq = ?', [driverId, req.params.id, legSeqs[i]]);
    if (driverId) anyAssigned = true;
  }

  if (anyAssigned) {
    try {
      await notify({
        branchId: order.branch_id, eventType: 'driver_assign', excludeUserId: u.id,
        title: '기사 배정', body: `${order.oid} 오더의 구간별 기사가 배정되었습니다.`, url: `/orders/${order.id}`,
      });
    } catch (e) { console.error('알림 발송 실패:', e.message); }
  }

  broadcastOrderListChangedAsync();
  res.redirect('/orders/' + req.params.id);
}));

// 관리자 수동 오더 타입 변경 (§7-2 3순위)
router.post('/:id/order-type', requireRole('admin'), asyncHandler(async (req, res) => {
  const order = await db.get('SELECT id FROM orders WHERE id = ?', [req.params.id]);
  if (!order) return res.status(404).json({ error: '오더를 찾을 수 없습니다.' });
  const validTypes = ['dispatch', 'premium', 'daily_driver'];
  const newType = req.body.order_type;
  if (!validTypes.includes(newType)) return res.status(400).json({ error: '유효하지 않은 오더 타입입니다.' });
  await db.run('UPDATE orders SET order_type = ? WHERE id = ?', [newType, order.id]);
  await db.run(
    `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note)
     VALUES (?, ?, NULL, NULL, ?)`,
    [order.id, req.session.user.id, `오더 타입 변경: ${newType}`]
  );
  broadcastOrderListChangedAsync();
  if (req.get('X-Requested-With') === 'fetch') return res.json({ ok: true });
  res.redirect('/orders/' + req.params.id);
}));

// 콜마너 오더접수 — 오더 등록(생성) 시점에 호출하고(위 POST '/'), 상태를 접수/대기로 바꿀
// 때(POST /:id/status, CALLMANER_TRIGGER_STATUSES)도 다시 호출한다. 오더 row를 DB에서 다시
// 읽어서 쓰므로 호출 시점(생성 직후든, 한참 뒤 상태변경이든)과 무관하게 항상 최신 값을 보낸다.
// 이미 conf_slip이 있으면(중복 등록 방지) 조용히 넘어가고 — 그래서 상태변경 때의 재호출은
// 실제로는 "생성 시점에 실패했으면 재시도"로만 동작한다(지사캐시 부족 등). lib/callmaner.js가
// 콜마너 쪽 접수상태를 항상 대기(5)로 고정하므로, 등록 즉시 배차 대상이 되지는 않는다.
async function registerOrderWithCallmaner(orderId, branchId) {
  try {
    const branchRow = await db.get('SELECT * FROM branches WHERE id = ?', [branchId]);
    if (!branchRow || !branchRow.callmaner_enabled) return;
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order || order.callmaner_conf_slip) return;
    const paymentMethodRow = order.payment_method_id
      ? await db.get('SELECT name FROM payment_methods WHERE id = ?', [order.payment_method_id])
      : null;
    // 경유지는 콜마너 viaList로 함께 보낸다(정의서 오더접수 via/viaList/via_count).
    const waypointRows = await db.all(
      'SELECT address, address_detail, lat, lon FROM order_waypoints WHERE order_id = ? ORDER BY seq',
      [orderId]
    ).catch(() => []);
    // 콜마너 userHp(요청단말번호)는 출발지 연락처를 우선 쓰고 없으면 요청자(오더를 등록한
    // 사용자) 연락처를 쓴다 — lib/callmaner.js의 normalizeUserHp가 이 순서로 고른다.
    const requesterRow = order.created_by
      ? await db.get('SELECT phone FROM users WHERE id = ?', [order.created_by]).catch(() => null)
      : null;
    const orderForCallmaner = {
      origin_contact: order.origin_contact,
      requester_phone: requesterRow && requesterRow.phone,
      origin_lat: order.origin_lat, origin_lon: order.origin_lon,
      origin_sido: order.origin_sido, origin_sigugun: order.origin_sigugun, origin_dong: order.origin_dong,
      origin_address: order.origin_address, origin_address_detail: order.origin_address_detail,
      destination_lat: order.destination_lat, destination_lon: order.destination_lon,
      destination_sido: order.destination_sido, destination_sigugun: order.destination_sigugun, destination_dong: order.destination_dong,
      destination_address: order.destination_address, destination_address_detail: order.destination_address_detail,
      fare_amount: order.fare_amount || 0,
      memo_customer: order.memo_customer || '',
      order_type: order.order_type,
      reserved_date: order.reserved_date, reserved_time: order.reserved_time,
    };
    const result = await callmaner.orderReceipt(orderForCallmaner, branchRow, paymentMethodRow && paymentMethodRow.name, waypointRows);
    await tryUpdateWithErrorCodeColumn(
      `UPDATE orders SET callmaner_conf_slip = ?, callmaner_status = '접수', callmaner_status_code = '01',
       callmaner_synced_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
       callmaner_last_error = NULL, callmaner_last_error_code = NULL WHERE id = ?`,
      [result.confSlip || null, orderId],
      `UPDATE orders SET callmaner_conf_slip = ?, callmaner_status = '접수', callmaner_status_code = '01',
       callmaner_synced_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
       callmaner_last_error = NULL WHERE id = ?`,
      [result.confSlip || null, orderId]
    );
  } catch (e) {
    console.error('콜마너 오더접수 실패:', e.message, e.rc ? `(rc=${e.rc})` : '');
    // 콜마너가 응답한 에러코드(rc)는 별도 컬럼에 담아, 화면에서 코드만 따로 보여줄 수 있게 한다.
    // 좌표 누락 같은 우리 쪽 사전검증 실패는 요청이 나가지 않아 rc가 없다(NULL로 남는다).
    const msg = String(e.message || '').slice(0, 500);
    await tryUpdateWithErrorCodeColumn(
      'UPDATE orders SET callmaner_last_error = ?, callmaner_last_error_code = ? WHERE id = ?',
      [msg, e.rc ? String(e.rc).slice(0, 40) : null, orderId],
      'UPDATE orders SET callmaner_last_error = ? WHERE id = ?',
      [msg, orderId]
    );
  }
}

// callmaner_last_error_code 컬럼은 20260805000000 마이그레이션에서 추가된다 — 아직 적용하지
// 않은 DB에서도(구버전 DB 호환, order_legs 처리와 같은 방어) 접수번호/에러 메시지 저장은
// 그대로 되어야 하므로, 코드 컬럼을 쓰는 쿼리가 실패하면 그 컬럼 없는 쿼리로 한 번 더 시도한다.
// 둘 다 실패하면 조용히 넘어간다 — 이 경로는 전부 fire-and-forget이라 오더 처리를 막으면 안 된다.
async function tryUpdateWithErrorCodeColumn(sqlWithCode, paramsWithCode, sqlWithoutCode, paramsWithoutCode) {
  try {
    await db.run(sqlWithCode, paramsWithCode);
  } catch (e) {
    await db.run(sqlWithoutCode, paramsWithoutCode).catch(() => {});
  }
}

router.post('/:id/status', asyncHandler(async (req, res) => {
  const order = await loadOrderInScope(req, res);
  if (!order) return;
  const u = req.session.user;
  const { status, note } = req.body;

  await db.run(
    `UPDATE orders SET status = ?, updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [status, req.params.id]
  );
  await db.run(`
    INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note)
    VALUES (?, ?, ?, ?, ?)
  `, [req.params.id, u.id, order.status, status, note || null]);

  // '대기'도 '접수'와 마찬가지로 콜마너 등록을 트리거한다(사용자 확정 사항) — 로컬 status
  // 컬럼은 그대로 '대기'/'접수'로 남고, registerOrderWithCallmaner는 콜마너 쪽 상태만
  // (callmaner_status='접수', 콜마너 자체 라벨) 기록하므로 서로 안 섞인다.
  //
  // await로 기다린다. 예전에는 fire-and-forget이라 리다이렉트된 상세페이지가 결과보다 먼저
  // 그려져서 실패 배너가 몇 초 뒤에야 떴다. 콜마너 OrderReceipt는 실측 약 1초라(타임아웃
  // 10초는 상한일 뿐) 기다려도 체감 지연이 거의 없고, 무엇보다 Vercel 서버리스는 응답을
  // 보낸 뒤 인스턴스를 얼려서 기다리지 않은 백그라운드 작업이 완료되지 않을 수 있다 —
  // 기다리는 편이 정확성 면에서도 안전하다. 실패는 함수 안에서 잡아 DB에 기록하므로 여기서
  // throw되지 않는다(상태변경 자체는 콜마너와 무관하게 항상 성공한다).
  if (CALLMANER_TRIGGER_STATUSES.includes(status)) {
    await registerOrderWithCallmaner(order.id, order.branch_id);
  }

  try {
    await notify({
      branchId: order.branch_id, eventType: 'order_events', excludeUserId: u.id,
      title: '오더 상태 변경', body: `${order.oid}: ${order.status} → ${status}`, url: `/orders/${order.id}`,
    });
  } catch (e) { console.error('알림 발송 실패:', e.message); }

  broadcastOrderListChangedAsync();
  res.redirect('/orders/' + req.params.id);
}));

router.post('/:id/fare', asyncHandler(async (req, res) => {
  const order = await loadOrderInScope(req, res);
  if (!order) return;
  const { fare_amount, ferry_fare_amount, memo_admin, vehicle_type } = req.body;
  try {
    await db.run(
      `UPDATE orders SET fare_amount = ?, ferry_fare_amount = ?, vehicle_type = COALESCE(?, vehicle_type), memo_admin = ?, updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
      [Number(fare_amount) || 0, Number(ferry_fare_amount) || 0, vehicle_type || null, memo_admin || null, req.params.id]
    );
  } catch (e) {
    const msg = String((e && e.message) || '');
    if (!(e && e.code === '42703')) throw e;

    const missingVehicleType = /vehicle_type/.test(msg);
    const missingFerryFare = /ferry_fare_amount/.test(msg);
    if (!missingVehicleType && !missingFerryFare) throw e;

    if (missingVehicleType && missingFerryFare) {
      await db.run(
        `UPDATE orders SET fare_amount = ?, memo_admin = ?, updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
        [Number(fare_amount) || 0, memo_admin || null, req.params.id]
      );
    } else if (missingVehicleType) {
      await db.run(
        `UPDATE orders SET fare_amount = ?, ferry_fare_amount = ?, memo_admin = ?, updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
        [Number(fare_amount) || 0, Number(ferry_fare_amount) || 0, memo_admin || null, req.params.id]
      );
    } else {
      await db.run(
        `UPDATE orders SET fare_amount = ?, vehicle_type = COALESCE(?, vehicle_type), memo_admin = ?, updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
        [Number(fare_amount) || 0, vehicle_type || null, memo_admin || null, req.params.id]
      );
    }
  }
  broadcastOrderListChangedAsync();
  res.redirect('/orders/' + req.params.id);
}));

module.exports = router;
