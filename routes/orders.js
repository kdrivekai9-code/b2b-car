const express = require('express');
const db = require('../db');
const { requireAuth, requireRole, scopeFilter, getSessionProblem, keepSessionAlive } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
// Gemini를 부르는 경로는 사용량을 제한한다(middleware/aiRateLimit.js의 주석 참조).
const { aiRateLimit } = require('../middleware/aiRateLimit');
const { ORDER_STATUSES } = require('../config');
const { getEffectivePaymentMethods, getEffectiveStatuses, checkOperatingHours, calculateFareWithFerry, calculatePremiumFare } = require('../lib/branchPolicy');
const { notify } = require('../lib/push');
const { kstNow } = require('../lib/period');
const { parseIntakeText } = require('../lib/aiIntakeParser');
const { classifyAndExtract, classifyPhaseReply } = require('../lib/hybridChat');
const { searchKnowledgeBase } = require('../lib/knowledgeSearch');
// lib/mcpDispatchAgent는 이 파일의 updateOrderWithCallmaner를 require한다 — 여기서 맞require하면
// 순환참조가 되어 그쪽이 로드 시점에 undefined를 잡는다(실제로 경고가 떴다). 쓰는 순간에 부른다.
function dispatchAgentLib() {
  return require('../lib/mcpDispatchAgent');
}
const { buildFareSuggestion } = require('../lib/agentAssist');
// 인사·자기소개 응답은 카카오 상담톡(routes/kakaoConsult.js)과 같은 규칙을 써야 해서 공용 모듈로 뺐다.
const { isGreeting, getSmalltalkMessage } = require('../lib/smallTalk');
const { broadcastMessage, broadcastSessionListChanged, broadcastOrderListChanged, openOrderListStream, closeChannel } = require('../lib/realtimeChat');
const { splitTypeAndPlate } = require('../lib/vehicleInfo');
const callmaner = require('../lib/callmaner');
// 콜마너 오더접수는 카카오 상담톡 자동 접수(lib/kakaoIntakeService.js)도 같은 함수를 타야 해서
// lib/callmanerRegister.js로 옮겼다 — 여기서는 그대로 가져다 쓴다.
const { registerOrderWithCallmaner, tryUpdateWithErrorCodeColumn } = require('../lib/callmanerRegister');
const { maybeUpgradePremiumToDaily } = require('../lib/premiumUpgrade');
// 오더 저장은 세 경로(웹·문의전환·카카오)가 같은 구현을 쓴다.
const { createOrder } = require('../lib/orderCreate');
const { recordActivity: recordGroupActivity, listRecentActivity: listGroupActivity, KIND_LABELS: ACTIVITY_KIND_LABELS } = require('../lib/groupActivityFeed');
// 수행일이 갈리면 구간마다 별도 오더로 나눈다 — 카카오 자동접수와 같은 규칙.
const { splitIntake } = require('../lib/orderSplit');
// 접수 필드 정의는 카카오 상담톡과 공유한다(lib/intakeFields.js).
const { DISPATCH_FIELDS } = require('../lib/intakeFields');
// 접수 요약 문구는 카카오 상담톡과 같은 모듈이 만든다.
const { buildSummaryText } = require('../lib/intakeSummary');
const callmanerPhotos = require('../lib/callmanerPhotos');
// 기타 정산 내역(주유비·주차요금·톨게이트). 항목 정의를 법인 정산내역 화면과 공유한다.
const extraCharges = require('../lib/extraCharges');
const { getRouteFareSettings } = require('../lib/routeFareSearch');

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
    // 접수 대화 판단을 서버로 옮긴 Stage A(탁송만, lib/webIntakeTurn.js) — 기본 OFF.
    // EJS(GET /ai-intake)와 Next(GET /ai-intake/data.json)가 이 함수를 공유하므로 값도 같이 간다.
    aiIntakeServerTurnEnabled: process.env.AI_INTAKE_SERVER_TURN_ENABLED === '1',
    // 법인별 경로탐색/요금검색 on-off(groups_tbl의 route_search_enabled/fare_search_enabled).
    // 꺼둔 법인은 접수 중 그 안내를 아예 만들지 않는다 — 안 보는 결과를 기다릴 이유가 없다.
    routeFareSettings: await getRouteFareSettings(scope.group_id),
  };
}

// 화면에 재진입할 때마다(대시보드 갔다 오는 정도가 아니라 며칠 전 대화까지) 항상 마지막
// 대화를 그대로 이어서 보여주고 있었다 — 사용자 확정: 30분 넘게 아무 메시지도 없었으면
// 자동으로는 이어주지 않고 새 대화로 시작한다(단, requestedSessionId로 특정 세션을 콕
// 집어 여는 경우는 의도적인 이동이라 이 제한을 적용하지 않는다 — 예: 상담 이력에서 클릭).
// chat_sessions.updated_at은 상태전환/숨김 때만 갱신돼 "마지막 활동 시각"으로 못 쓰므로,
// 실제 마지막 메시지(chat_messages.created_at, 없으면 세션 생성시각)를 기준으로 판단한다.
const SESSION_IDLE_TIMEOUT_MINUTES = 30;

async function loadAiIntakeRestoreData(userId, requestedSessionId) {
  const existingSession = await (requestedSessionId
    ? db.get(
        `SELECT id, status, draft_json FROM chat_sessions WHERE id = ? AND user_id = ? AND user_hidden_at IS NULL`,
        [requestedSessionId, userId]
      )
    : db.get(
        `SELECT id, status, draft_json FROM chat_sessions cs
         WHERE cs.user_id = ? AND cs.status != 'closed' AND cs.user_hidden_at IS NULL
           AND to_timestamp(
             COALESCE((SELECT MAX(cm.created_at) FROM chat_messages cm WHERE cm.session_id = cs.id), cs.created_at),
             'YYYY-MM-DD HH24:MI:SS'
           ) > (now() at time zone 'Asia/Seoul') - interval '${SESSION_IDLE_TIMEOUT_MINUTES} minutes'
         ORDER BY cs.created_at DESC LIMIT 1`,
        [userId]
      ));

  // 30분 넘게 방치된 세션들은 새로 안 이어줄 뿐 아니라 닫아둔다 — 안 그러면 상담원 모니터링
  // 화면에 끝난 지 오래된 대화가 'bot' 상태로 계속 활성 세션처럼 남는다. 위 조회와 시간 조건이
  // 반대(초과 vs 이하)라 서로 겹치지 않으므로, 방금 찾은 existingSession을 따로 제외할 필요는
  // 없다. requestedSessionId로 특정해서 들어온 경우는 사용자가 그 대화를 보려는 것이므로
  // 건드리지 않는다.
  if (!requestedSessionId) {
    await db.run(
      `UPDATE chat_sessions cs SET status = 'closed'
       WHERE cs.user_id = ? AND cs.status != 'closed' AND cs.user_hidden_at IS NULL
         AND to_timestamp(
           COALESCE((SELECT MAX(cm.created_at) FROM chat_messages cm WHERE cm.session_id = cs.id), cs.created_at),
           'YYYY-MM-DD HH24:MI:SS'
         ) <= (now() at time zone 'Asia/Seoul') - interval '${SESSION_IDLE_TIMEOUT_MINUTES} minutes'`,
      [userId]
    ).catch((e) => console.error('유휴 챗봇 세션 정리 실패:', e.message));
  }

  let existingMessages = [];
  let existingDraft = null;
  if (existingSession) {
    existingMessages = await db.all(
      // *로 받는다 — 컬럼을 나열하면 나중에 추가되는 것이 조용히 빠진다. 실제로
      // attachments_json(통보에 딸린 사진)이 여기서 빠져 있어서, 고객이 대화를 다시 열면
      // 사진이 사라졌다(실시간 수신 경로에는 있었는데 복원 경로에만 없었다).
      `SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC`,
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

// 접수에 필요한 필드와 질문 문구 — 서버가 단 하나의 정의를 갖고(lib/intakeFields.js) 브라우저가
// 그걸 받아 쓴다. 예전에는 같은 목록이 public/js/ai-intake.js(REQUIRED_FIELDS)에도 있어서,
// 문구를 고칠 때 카카오 쪽 정의와 갈라지기 쉬웠다.
//
// 브라우저는 이 응답이 없으면 자기 기본값으로 계속 동작한다(네트워크 실패 시 접수가 멈추면 안 된다).
router.get('/ai-intake/fields.json', asyncHandler(async (req, res) => {
  res.json({ fields: DISPATCH_FIELDS });
}));

// 접수 확인 요약 — 카카오 상담톡(등록 후 통보·상담원 초안)과 같은 모듈로 만든다
// (lib/intakeSummary.js). 예전에는 세 곳이 각자 만들어서, 옵션(주유·서류)이 카카오 요약에만
// 들어가는 식으로 항목이 갈라졌다.
//
// 웹 접수 화면(public/js/ai-intake.js)이 등록 확인 직전에 이걸 부른다. 응답이 늦거나 실패하면
// 화면 안의 폴백(buildSummaryTextLocal)으로 넘어간다 — 고객이 확인하는 문구라 네트워크 때문에
// 접수가 멈추면 안 된다. 그 폴백이 여기와 같은 문구를 내는지는 scripts/check-intake-summary.js가
// 대조한다.
router.post('/ai-intake/summary.json', aiRateLimit, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const text = buildSummaryText({
    reservedDate: b.reserved_date,
    reservedTime: b.reserved_time,
    immediate: !!b.reservation_immediate,
    origin: { address: b.origin_address, detail: b.origin_detail_address, contact: b.origin_contact },
    destination: { address: b.destination_address, detail: b.destination_detail_address, contact: b.destination_contact },
    waypoints: Array.isArray(b.waypoints) ? b.waypoints : [],
    vehicles: [{ type: b.vehicle_type, number: b.vehicle_number }],
    memoCustomer: b.memo_customer,
    memoBilling: b.memo_billing,
  }, { bullet: '▪' });
  res.json({ text });
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
    ...initData, // aiIntakeServerTurnEnabled 포함 — Next(GET /ai-intake/data.json)와 같은 값
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

// 클라이언트(public/js/ai-intake.js)가 도우미를 부르기 전에 거르는 조건과 같은 규칙을 서버에도
// 둔다 — 명시적인 "상담원 연결"은 도우미를 거치지 않고, 되묻는 질문에 답하는 중(pendingField)에도
// 도우미로 새지 않는다. 여기서는 미리 돌릴지 말지를 정할 뿐이라, 이 판단이 어긋나도 클라이언트가
// 예전처럼 /dispatch-agent를 직접 부르는 경로가 그대로 남아 있어 기능이 빠지지는 않는다.
const AGENT_REQUEST_RE = /상담원|상담사/;
// 오더접수 본문처럼 보이면 미리 돌리지 않는다 — 어차피 접수 의도로 분류돼 결과를 버리게 되고,
// 트래픽 대부분이 접수라 그만큼이 고스란히 낭비되는 Gemini 호출이 된다(클라이언트의 같은 이름
// 함수와 같은 규칙).
const ORDER_INTAKE_HINT_RE = /\d{2,3}[-\s]?\d{3,4}[-\s]?\d{4}|(^|[\n\s])(출발|출:|출\s|도착|도:|도\s|경유|경:|경\d)/;

// 도우미가 실제로 다루는 일(주문 조회/변경/취소, 기사 연락처, 어디쯤인지, 요금 인상)의 신호가
// 있을 때만 미리 돌린다.
//
// 왜 좁히는가: 투기 실행은 Gemini 한 번이 아니라 에이전트 한 판이다(실측 ≈3.3초, 모델 2라운드 +
// 도구 호출). FAQ 질문마다 이걸 돌려놓고 버리면 낭비가 크다. 신호를 놓쳐도 손해는 "느려지는 것"
// 뿐이다 — 그 경우 클라이언트가 예전처럼 /dispatch-agent를 직접 부른다.
const DISPATCH_HINT_RE = /주문|오더|접수번호|배차|기사|취소|변경|수정|어디|언제\s*(와|도착)|도착\s*(시간|예정)|출발했|픽업|요금\s*(올려|인상|추가)|얼마나\s*(걸|남)/;

function shouldProbeDispatch(text, pendingField, chatSessionId) {
  if (!chatSessionId || pendingField) return false;
  if (AGENT_REQUEST_RE.test(text) || ORDER_INTAKE_HINT_RE.test(text)) return false;
  return DISPATCH_HINT_RE.test(text);
}

function startDispatchProbe(req, { text, pendingField, chatSessionId }) {
  if (!shouldProbeDispatch(text, pendingField, chatSessionId)) return null;

  return (async () => {
    // 이 라우트는 원래 세션 소유를 확인하지 않는다(FAQ 검색 힌트로만 써서 민감한 값을 돌려주지
    // 않기 때문). 도우미 결과는 남의 주문 내역일 수 있으므로 여기서는 반드시 확인한다.
    // admin 우회도 두지 않는다 — 이건 고객이 자기 대화창에서 쓰는 경로다.
    const session = await db.get('SELECT user_id, status FROM chat_sessions WHERE id = ?', [chatSessionId]);
    if (!session || session.user_id !== req.session.user.id) return null;
    if (session.status !== 'bot') return null; // 상담원이 붙은 세션에는 봇이 끼어들지 않는다

    const history = await db.all(
      `SELECT sender, message FROM chat_messages
       WHERE session_id = ? AND sender IN ('user', 'bot') AND message IS NOT NULL
       ORDER BY id DESC LIMIT 12`,
      [chatSessionId]
    );
    history.reverse();
    // 방금 저장된 이번 메시지는 text로 따로 넘기므로 히스토리 끝에서 뺀다(/dispatch-agent와 동일).
    if (history.length && history[history.length - 1].sender === 'user' && history[history.length - 1].message === text) {
      history.pop();
    }
    return dispatchAgentLib().runDispatchAgent({ user: req.session.user, sessionId: chatSessionId, text, history, speculative: true });
  })().catch((e) => {
    console.error('배차 도우미 사전 실행 실패:', e.message);
    return null;
  });
}

// 결과를 쓰지 않고 버릴 때 — 투기 실행이 남긴 대기 상태(목록 이어보기 위치 등)를 지운다.
// 투기 실행은 대기 상태가 이미 있으면 아예 물러나므로(speculative_pending), 여기서 지우는 건
// 반드시 그 실행이 만든 것이다. 남겨두면 다음 메시지가 "다음"으로 오해될 수 있다.
function discardDispatchProbe(probe, chatSessionId) {
  if (!probe) return;
  probe.then((result) => {
    if (!result || !result.handled) return;
    return dispatchAgentLib().clearPending(chatSessionId);
  }).catch((e) => console.error('배차 도우미 사전 실행 정리 실패:', e.message));
}

// 인사말은 의미 검색에 필요한 정보가 없어 어떤 지식 항목과도 우연히 유사해질 수 있다.
// 이 경우 RAG와 의도 분류를 건너뛰고 대화 시작 안내를 반환한다.
// 하이브리드 챗봇 1단계: 지식검색(FAQ) + 오더접수. Gemini로 의도를 분류해 두 갈래로 라우팅하고,
// Gemini 호출이 실패하면(쿼터/네트워크 등) 예전 규칙 기반 파서로 대체해 오더접수만이라도 동작하게 한다.
router.post('/ai-intake/parse', aiRateLimit, asyncHandler(async (req, res) => {
  const text = (req.body.text || '').trim();
  const pendingField = req.body.pendingField || null;
  // FAQ 검색 문맥 보강에만 쓴다(lib/knowledgeSearch.js) — 이 세션의 chat_messages를 조회할
  // 뿐이라, 남의 세션 id를 보내도 그 세션 소유 여부는 확인하지 않는다(읽는 값이 "지식베이스
  // 검색 정확도 힌트"뿐이라 권한 문제가 아니다 — 접수/조회처럼 개인정보를 반환하지 않는다).
  const chatSessionId = Number(req.body.sessionId) || null;
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

  // 예약시간을 되물었는데(pendingField) "없다"는 취지의 짧은 답만 오면 Gemini보다 먼저 처리한다.
  // 실사용 사고: "몰라요"처럼 문맥 없는 한 마디를 그대로 Gemini에 태우면 order 관련 신호가 전혀
  // 없어 faq/unsupported로 오분류돼 아래 "즉시" 채우기 코드(intent==='faq'면 그 앞에서 return
  // 해버림)에 도달하지도 못하고 끝났다. pendingField 자체가 이미 "무엇에 대한 답인지"를 말해주고
  // 있으므로 Gemini를 거칠 필요가 없다.
  {
    const RESERVED_DATE_PENDING_FIELDS_EARLY = new Set(['reserved_date', 'premium_reserved_datetime']);
    const RESERVATION_TIME_DECLINE_RE_EARLY = /^(없음|없어요?|없습니다|모르겠어요?|모름|몰라요?|미정)[.!~\s]*$/i;
    if (RESERVED_DATE_PENDING_FIELDS_EARLY.has(pendingField) && RESERVATION_TIME_DECLINE_RE_EARLY.test(text)) {
      const now = kstNow();
      const pad = (n) => String(n).padStart(2, '0');
      return res.json({
        intent: 'dispatch_order',
        reserved_date: `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`,
        reserved_time: `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`,
        reservation_immediate: true,
        seemsFrustrated: false,
      });
    }
  }

  // 지식검색(임베딩 API 호출)은 사용자 원문 텍스트만 있으면 바로 시작할 수 있어, 의도분류(Gemini) 결과를
  // 기다리지 않고 미리 같이 시작해둔다 — FAQ로 판정될 때만 그 결과를 기다리면 두 외부 API 호출이
  // 순차가 아니라 병렬로 진행되어 FAQ 응답 지연이 절반 가까이 줄어든다. FAQ가 아니면 결과는 버려진다
  // (임베딩 호출 자체는 가벼워서, 다른 의도일 때 낭비되는 비용보다 FAQ 응답 지연 감소가 더 크다).
  const knowledgeSearchPromise = searchKnowledgeBase(text, { limit: 1, threshold: 0.7, sessionId: chatSessionId })
    .catch((e) => { console.error('지식베이스 사전 검색 실패:', e.message); return []; });

  // 배차 주문 도우미(콜마너 MCP)도 지금 같이 출발시킨다 — 지식검색과 같은 이유다.
  //
  // 지금까지는 "의도분류 → unsupported 판정 → 클라이언트가 /dispatch-agent 재요청"으로
  // 직렬이라, 고객은 분류(≈1.7초)를 기다린 뒤에야 도우미가 돌기 시작했다(실측 ai_call_logs:
  // embed 0.6s ∥ intent_light 1.7s → HTTP 왕복 → mcp_dispatch 0.7~1.4s = 3~5초).
  // 미리 같이 돌려두고 unsupported일 때만 그 결과를 쓰면 분류 시간이 통째로 겹쳐 사라지고,
  // 왕복도 한 번 줄어든다. 접수 의도였으면 결과는 버린다(runDispatchAgent의 speculative 주석).
  const dispatchProbe = startDispatchProbe(req, { text, pendingField, chatSessionId });

  // 접수 턴 엔진(/chat/:id/intake-turn)이 방금 같은 문장을 분류하고 fallthrough하면서 그 결과를
  // 함께 넘겨주면, 여기서 Gemini를 다시 태우지 않고 재사용한다 — 같은 발화에 분류 LLM이 두 번
  // 도는 것을 없애 응답 지연을 절반으로 줄인다(서버 접수턴이 켜진 경우에만 해당). 형태가 어긋난
  // 값이 오면 무시하고 정상 경로로 분류한다.
  const reuseClassified = (req.body && req.body.classified && typeof req.body.classified === 'object' && req.body.classified.intent)
    ? req.body.classified
    : null;
  let geminiResult = reuseClassified;
  if (!geminiResult) {
    try {
      geminiResult = await classifyAndExtract(text, pendingField);
    } catch (e) {
      console.error('Gemini 의도분류/추출 실패, 규칙 기반 파서로 대체:', e.message);
    }
  }

  // 화남/답답함 신호는 의도(intent)와 무관하게 감지될 수 있어 응답 분기와 상관없이 항상 함께 내려준다.
  const seemsFrustrated = !!(geminiResult && geminiResult.seemsFrustrated);

  // unsupported가 아니면 도우미 결과는 쓰지 않는다.
  if (!(geminiResult && geminiResult.intent === 'unsupported')) {
    discardDispatchProbe(dispatchProbe, chatSessionId);
  }

  if (geminiResult && geminiResult.intent === 'faq') {
    // 구간이 붙은 요금 문의("사당역에서 반포역까지 얼마?")는 지식검색으로 풀 수 없다 —
    // 거리마다 답이 달라 등록해 둘 수 있는 항목이 아니다. 실제 요금표로 계산해 답한다.
    // 화면은 matches[].category/answer를 그대로 그리므로 같은 모양으로 실어 보낸다.
    const fare = await buildFareSuggestion(text, {
      branchId: req.session.user.branch_id,
      groupId: req.session.user.group_id || null,
      extracted: geminiResult,
    })
      .catch((e) => { console.error('요금 안내 계산 실패:', e.message); return null; });
    if (fare) {
      return res.json({ intent: 'faq', matches: [{ category: '요금안내', answer: fare.text }], seemsFrustrated });
    }
    const matches = await knowledgeSearchPromise;
    return res.json({ intent: 'faq', matches, seemsFrustrated });
  }

  if (geminiResult && geminiResult.intent === 'unsupported') {
    // 미리 돌려둔 도우미가 답을 만들었으면 그대로 실어 보낸다 — 클라이언트가 /dispatch-agent를
    // 다시 부르는 왕복이 사라진다. 못 만들었으면(조건 미충족·투기 중단·처리 불가) 이 필드 없이
    // 나가고, 클라이언트는 예전 그대로 도우미를 직접 부른다(기능 회귀 없음).
    const agent = dispatchProbe ? await dispatchProbe : null;
    return res.json({
      intent: 'unsupported',
      requestedFeature: geminiResult.requestedFeature || null,
      seemsFrustrated,
      ...(agent && agent.handled ? { dispatchAgent: agent } : {}),
    });
  }

  const fields = geminiResult ? normalizeGeminiOrderFields(geminiResult) : parseIntakeText(text);
  const fallbackIntent = (geminiResult && ORDER_INTENTS.has(geminiResult.intent)) ? geminiResult.intent : 'dispatch_order';
  // intent 판정은 원래 fields(예약일시 유무)를 그대로 봐야 한다 — 아래 "즉시" 채우기보다
  // 반드시 먼저 실행해서, 예약없는 즉시 대리 요청(proxy_order)이 예약 있는 건으로 오분류되지
  // 않게 한다.
  const intent = classifyOrderIntentByRule(text, fields) || fallbackIntent;

  // 예약일시가 아예 없으면 현재 시각으로 조용히 채우지 않고 챗봇이 직접 물어보게 한다(정책
  // 유지 — 예전에는 "지금 바로 보내는 차량"으로 임의 가정했는데, 사용자가 실제로 정한 적
  // 없는 값을 마치 확인한 것처럼 안내해버리는 문제가 있었다).
  //
  // 다만 "즉시"라고 명시적으로 답한 경우는 다르다 — 이건 고객이 실제로 밝힌 의도인데도
  // reservationDate/Time은 애초에 날짜·시간이 아니라서 비어 있으니(당연한 결과), 클라이언트
  // (public/js/ai-intake.js)가 "아직 확정 안 됨"으로 보고 예약시간을 계속 되물었다(실사용
  // 사고: 다른 필드를 전부 확인해준 뒤에도 "예약시간을 말씀해주세요?"가 반복됨). 그래서
  // 명시적 "즉시" 계열 표현일 때는 예외로 지금 시각을 채워 내려보낸다. 사용자 확정 규칙
  // (2026-08-13): "즉시" 외에 "최대한빨리"/"현재"/"지금바로"도 같은 뜻으로 본다. 예약시간을
  // 되물었는데 "없다"는 취지로만 답한 경우는 위에서(Gemini를 태우기도 전에) 이미 처리했다 —
  // 여기 도달했다는 건 그 짧은 거부 응답이 아니라는 뜻이라 다시 보지 않는다.
  //
  // reserved_date만 있고 reserved_time이 빈 경우도 즉시로 채운다 — 실사용 사고: 이 문장을
  // Gemini에 그대로 태우면 "즉시"는 시각이 아니라서 reservationTime은 비어 있지만
  // reservationDate에는 (근거 없이) 오늘 날짜를 채워 내려줄 때가 있었다. 예전 조건
  // (reserved_date·reserved_time 둘 다 비어야만 채움)은 이 경우를 못 잡아 시간만 영원히
  // 빈 채로 남았다 — date가 이미 있어도 time이 없으면 즉시 표현 시 둘 다 지금 시각으로
  // 덮어써서 날짜·시각이 항상 짝을 맞추게 한다.
  const IMMEDIATE_WORDING_RE = /즉시|최대한\s*빨리|지금\s*바로|현재/;
  const isImmediateWording = IMMEDIATE_WORDING_RE.test(text);
  if (!fields.reserved_time && isImmediateWording) {
    const now = kstNow();
    const pad = (n) => String(n).padStart(2, '0');
    fields.reserved_date = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
    fields.reserved_time = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
    // 클라이언트가 확인 문구를 "8월 12일 오후 5시"가 아니라 "즉시"로 보여주고, 오더 등록
    // 화면의 "즉시" 라디오를 자동 체크하도록 알려준다.
    fields.reservation_immediate = true;
  }

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
router.post('/ai-intake/classify-reply', aiRateLimit, asyncHandler(async (req, res) => {
  const text = (req.body.text || '').trim();
  const phase = req.body.phase || '';
  const candidates = Array.isArray(req.body.candidates) ? req.body.candidates : [];
  // choose_field 단계에서 클라이언트가 지금 실제로 쓰는 필드 목록(탁송 6항목 vs 일일기사
  // 전용 목록)을 넘겨주면, Gemini의 field enum/설명을 그 목록으로 만든다(lib/hybridChat.js) —
  // 안 그러면 일일기사에 없는 필드를 요구하거나, 일일기사 전용 필드(전달사항 등)를 아예
  // 고를 수 없다. 클라이언트가 안 만든 값이 섞여 들어올 수 있으니 형태/개수를 방어적으로 검증한다.
  const fieldChoices = Array.isArray(req.body.fieldChoices)
    ? req.body.fieldChoices
      .filter((f) => f && typeof f.id === 'string' && typeof f.label === 'string')
      .slice(0, 20)
      .map((f) => ({ id: f.id.slice(0, 64), label: f.label.slice(0, 64) }))
    : [];
  if (!text || !phase) return res.status(400).json({ action: 'unclear' });

  try {
    const result = await classifyPhaseReply(text, phase, { candidates, fieldChoices });
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
    // 오지요금 판정용 — 오더 등록 화면은 주소만 알고 행정지명은 모른다. 주소에서 "…리"를 찾는다
    // (lib/branchPolicy.js isRemoteArea). 행정지명을 아는 경로(요금문의)는 그쪽을 넘긴다.
    destinationAddress: req.query.destination_address || req.query.destinationAddress || '',
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
router.get('/vehicle-type-suggest', aiRateLimit, asyncHandler(async (req, res) => {
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
  // 경유지에서 "다른 날" 다시 출발하는 경우에만 채워 보낸다 — 그때 오더가 구간별로 나뉜다
  // (lib/orderSplit.js). 같은 날 이어서 도는 평범한 경유는 비어 있다.
  const waypointReservedDates = [].concat(req.body.waypoint_reserved_dates || []);
  const waypointReservedTimes = [].concat(req.body.waypoint_reserved_times || []);
  const finalWaypoints = waypoints
    .map((w, i) => ({
      address: combineAddress(w, waypointDetails[i]),
      addressDetail: waypointDetails[i] || null,
      contact: waypointContacts[i] || null,
      vehicleNumber: waypointVehicleNumbers[i] || null,
      lat: toNumOrNullShared(waypointLats[i]),
      lon: toNumOrNullShared(waypointLons[i]),
      reservedDate: String(waypointReservedDates[i] || '').trim() || null,
      reservedTime: String(waypointReservedTimes[i] || '').trim() || null,
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

  // 오더 저장은 lib/orderCreate.js 한 곳에서만 한다 — 웹·문의전환·카카오 자동접수가 같은 함수를
  // 쓴다(예전에는 같은 INSERT가 네 벌로 흩어져 있어 컬럼 추가 때 누락이 생기기 쉬웠다).
  // 검증·요금·콜마너 접수·자동 승격은 경로마다 규칙이 달라 여기 남는다.
  // 실제 운영 규칙대로 나눈다 — 수행일이 갈리면 구간마다 별도 오더다(lib/orderSplit.js).
  // 갈리지 않으면 parts가 하나뿐이라 예전과 똑같이 한 건만 만들어진다(대부분의 등록).
  // 카카오 자동접수(lib/kakaoIntakeService.js)와 같은 규칙을 쓴다.
  const splitPlan = splitIntake({
    originAddress: finalOriginAddress,
    originAddressDetail: origin_detail_address || null,
    originContact: origin_contact || null,
    destinationAddress: finalDestinationAddress,
    destinationAddressDetail: destination_detail_address || null,
    destinationContact: destination_contact || null,
    waypoints: finalWaypoints,
    reservedDate: effectiveReservedDate,
    reservedTime: effectiveReservedTime,
    roundTrip: trip_type === 'round_trip',
    returnReservedDate: String(req.body.return_reserved_date || '').trim() || null,
    returnReservedTime: String(req.body.return_reserved_time || '').trim() || null,
  });
  const splitGroupId = splitPlan.parts.length > 1
    ? `sg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    : null;

  const createdRows = [];
  for (const part of splitPlan.parts) {
  const created = await createOrder({
    branchId: finalBranch,
    requesterGroupId: finalGroup,
    originAddress: part.originAddress,
    originAddressDetail: part.originAddressDetail || null,
    originContact: part.originContact || null,
    destinationAddress: part.destinationAddress,
    destinationAddressDetail: part.destinationAddressDetail || null,
    destinationContact: part.destinationContact || null,
    vehicleNumber: vehicle_number || null,
    vehicleType: vehicle_type || null,
    // 나뉜 건은 그 구간의 출발 일시를 쓴다. 나뉘지 않았으면 원래 값 그대로다.
    reservedDate: part.reservedDate || effectiveReservedDate,
    reservedTime: part.reservedTime || effectiveReservedTime,
    paymentMethodId: payment_method_id || null,
    fareAmount: fare_amount,
    ferryFareAmount: ferry_fare_amount,
    orderType: finalOrderType,
    tripType: trip_type || null,
    finalDestinationAddress: final_destination_address || null,
    finalDestinationAddressDetail: final_destination_address_detail || null,
    destinationWaitMinutes: destination_wait_minutes,
    reservationHoursBracket: reservation_hours_bracket,
    originLat: origin_lat,
    originLon: origin_lon,
    originSido: origin_sido || null,
    originSigugun: origin_sigugun || null,
    originDong: origin_dong || null,
    destinationLat: destination_lat,
    destinationLon: destination_lon,
    destinationSido: destination_sido || null,
    destinationSigugun: destination_sigugun || null,
    destinationDong: destination_dong || null,
    memoCustomer: memo_customer || null,
    memoBilling: memo_billing || null,
    createdBy: u.id,
    // 나뉜 건에는 그 구간에 남은 경유지만 실린다(같은 날 이어 도는 곳). 나뉘지 않았으면 전부.
    waypoints: part.waypoints || [],
    sourceChannel: 'web',
    splitGroupId,
    splitSeq: splitGroupId ? part.splitSeq : null,
    splitTotal: splitGroupId ? part.splitTotal : null,
  });
    createdRows.push(created);
  }

  // 이후 처리(콜마너 접수·자동승격·응답)는 첫 건을 기준으로 이어간다. 나뉜 나머지 건은
  // 아래에서 따로 콜마너에 올린다.
  const created = createdRows[0];
  const newId = created.orderId;
  const oid = created.oid;

  // 콜마너 오더접수 — 오더 등록(생성) 시점에 바로 나간다(사용자 확정 사항). registerOrderWithCallmaner가
  // 항상 대기(status='5')로 등록하므로(lib/callmaner.js), 담당자가 검토하기 전에 곧바로 배차
  // 대상이 되지는 않는다. await로 기다리는 이유는 POST /:id/status와 동일하다 — 실측 약 1초라
  // 체감 지연이 적고, Vercel 서버리스는 응답 후 인스턴스를 얼려 기다리지 않은 백그라운드 작업이
  // 완료되지 않을 수 있다. 실패는 함수 안에서 잡아 DB에 기록하므로 오더 등록 자체는 항상
  // 성공한다. 이후 상태를 접수/대기로 바꾸면(POST /:id/status) 실패했던 등록이 재시도된다
  // (registerOrderWithCallmaner는 conf_slip이 이미 있으면 조용히 건너뛰어 중복 등록하지 않음).
  await registerOrderWithCallmaner(newId, finalBranch);
  // 나뉜 나머지 건도 같은 규칙으로 올린다 — 하나만 올리면 나머지가 배차되지 않는다.
  for (const extra of createdRows.slice(1)) {
    await registerOrderWithCallmaner(extra.orderId, finalBranch);
  }

  // §7-2 자동 승격 판정 — premium 오더 접수 후 실제 소요시간이 8시간 이상이면 daily_driver로
  // 전환한다. fire-and-forget: 경로탐색 실패/지연은 오더 등록 자체를 막지 않는다. 웹 AI 접수
  // (lib/webPremiumIntakeService.js)도 같은 판정을 거쳐야 해서 lib/premiumUpgrade.js로 뺐다 —
  // 동작은 그대로다.
  if (finalOrderType === 'premium') {
    maybeUpgradePremiumToDaily({
      orderId: newId,
      actorUserId: u.id,
      reservationHoursBracket: reservation_hours_bracket,
      destinationWaitMinutes: destination_wait_minutes,
    });
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
  // 나뉘어 여러 건이 만들어졌으면 호출부(웹 챗봇)가 그 사실을 알아야 한다 — 접수번호가 하나만
  // 안내되면 고객은 나머지 건을 모른 채 넘어간다.
  if (wantsJson) {
    return res.json({
      orderId: newId,
      oid,
      ...(createdRows.length > 1
        ? { split: { reason: splitPlan.reason, total: createdRows.length, orders: createdRows.map((c) => ({ orderId: c.orderId, oid: c.oid })) } }
        : {}),
    });
  }
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
      SELECT ol.seq, ol.driver_id, ol.photo_upload_token, d.name AS driver_name, d.phone AS driver_phone
      FROM order_legs ol
      LEFT JOIN drivers d ON d.id = ol.driver_id
      WHERE ol.order_id = ?
      ORDER BY ol.seq ASC
    `, [orderId]).catch(async (e) => {
      // photo_upload_token은 20260809040000에서 추가된다 — 적용 전 DB에서도 구간 배정 화면은
      // 그대로 떠야 하므로 그 컬럼 없이 한 번 더 조회한다.
      if (!e || e.code !== '42703') throw e;
      return db.all(`
        SELECT ol.seq, ol.driver_id, NULL AS photo_upload_token, d.name AS driver_name, d.phone AS driver_phone
        FROM order_legs ol
        LEFT JOIN drivers d ON d.id = ol.driver_id
        WHERE ol.order_id = ?
        ORDER BY ol.seq ASC
      `, [orderId]);
    });
  } catch (e) {
    return []; // order_legs 테이블이 아직 없는 DB(마이그레이션 미적용) — 조용히 폴백
  }
  if (!legRows.length) return [];

  // 전체 주소 대신 상세주소만 보여준다(사용자 요청) — 구간 목록에서는 "몇 번째 구간인지"만
  // 구분하면 되고, 전체 주소는 위쪽 이동 경로 섹션에 이미 나와 있어 중복이었다. 상세주소가
  // 없으면(선택 항목이라 비어있을 수 있음) 아래 `|| '-'`가 그대로 처리한다.
  const stopLabels = [order.origin_address_detail, ...waypoints.map((w) => w.address_detail), order.destination_address_detail];
  return legRows.map((row) => ({
    seq: row.seq,
    fromLabel: stopLabels[row.seq - 1] || '-',
    toLabel: stopLabels[row.seq] || '-',
    driverId: row.driver_id,
    driverName: row.driver_name,
    driverPhone: row.driver_phone,
    // 구간마다 다른 기사에게 줄 업로드 링크. 오더 토큰 하나를 여럿에게 주면 올라온 사진이
    // 어느 구간 것인지 알 수 없다.
    photoUploadToken: row.photo_upload_token || null,
  }));
}

// 기사배정 여부 — 단일배정(레거시, assigned_driver_id)과 구간 릴레이(order_legs, 마이그레이션
// 이후 오더) 두 방식이 공존해서 어느 한쪽만 보면 놓친다. 오더 수정 권한(고객/상담원은 배차 후
// 수정 차단, 관리자는 경고 팝업 후 허용)의 판단 기준이라 GET data.json과 POST 수정 양쪽에서
// 반드시 같은 기준을 써야 한다.
function hasAssignedDriver(order, legs) {
  return !!order.assigned_driver_id || (Array.isArray(legs) && legs.some((l) => l.driverId));
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
  // 콜마너 탁송사진(운행전/운행후)은 기사 업로드 사진과 별도 테이블이다 — 링크만 보관하므로
  // 콜마너가 만료시키면 썸네일이 깨질 수 있다(화면에서 onerror로 링크만 남긴다).
  const callmanerPhotoRows = canViewPhotos ? await callmanerPhotos.loadPhotos(req.params.id) : [];
  const legs = await buildOrderLegs(req.params.id, order, waypoints);
  // 기타 정산 내역은 청구 금액이라 고객에게는 내려주지 않는다(입력도 막혀 있다).
  const extraChargeRows = u.role === 'client' ? [] : await extraCharges.loadForOrder(req.params.id);

  res.json({
    ...formInit,
    order: {
      ...order,
      // 오더 수정 화면(OrderForm.js)이 역할별로 다른 수정 제한 문구/팝업을 보여주는 기준.
      hasAssignedDriver: hasAssignedDriver(order, legs),
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
    history, drivers, photos, callmanerPhotos: callmanerPhotoRows, canViewPhotos, legs,
    extraCharges: extraChargeRows,
    // 요금설정에서 "제외(실비 정산)"로 둔 항목만 고를 수 있다 — "포함" 항목을 청구하면 이중 청구다.
    extraChargeTypes: await extraCharges.billableTypesForOrder(order),
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
  // 경유지에서 "다른 날" 다시 출발하는 경우에만 채워 보낸다 — 그때 오더가 구간별로 나뉜다
  // (lib/orderSplit.js). 같은 날 이어서 도는 평범한 경유는 비어 있다.
  const waypointReservedDates = [].concat(req.body.waypoint_reserved_dates || []);
  const waypointReservedTimes = [].concat(req.body.waypoint_reserved_times || []);
  const finalWaypoints = waypoints
    .map((w, i) => ({
      address: combineAddress(w, waypointDetails[i]),
      addressDetail: waypointDetails[i] || null,
      contact: waypointContacts[i] || null,
      vehicleNumber: waypointVehicleNumbers[i] || null,
      lat: toNumOrNullShared(waypointLats[i]),
      lon: toNumOrNullShared(waypointLons[i]),
      reservedDate: String(waypointReservedDates[i] || '').trim() || null,
      reservedTime: String(waypointReservedTimes[i] || '').trim() || null,
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

  // 기사배정 후에는 고객(client)의 실시간 수정만 막는다(사용자 확정 사항) — 이미 기사에게
  // 전달된 정보를 당사자 모르게 바꿔버리면 안 되기 때문이다. 관리자와 상담원(branch_manager)
  // 은 여전히 수정할 수 있되, 클라이언트(OrderForm.js)가 저장 전에 "기사님께 꼭 전달해주세요"
  // 확인 팝업을 띄운다 — 서버는 그 팝업을 강제하지 않는다(둘 다 신뢰된 역할이라 순수 UX
  // 안내). 클라이언트 쪽 확인을 우회해서 요청을 보내도(devtools 등) 여기서 다시 막히므로
  // 실제 권한 경계는 여기다.
  if (isClient) {
    const currentLegs = await buildOrderLegs(req.params.id, order, await db.all('SELECT * FROM order_waypoints WHERE order_id = ? ORDER BY seq ASC', [req.params.id]));
    if (hasAssignedDriver(order, currentLegs)) {
      return res.status(403).json({
        error: '해당 오더가 기사님께 배정된 상태입니다. 수정사항은 상담원 대화 요청이나, 고객센터로 직접 요청해 주세요.',
      });
    }
  }

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

  // 기사 전달사항을 사람이 고쳤으면 접수 때 만들어둔 요약은 그 내용이 아니다. 비워서 콜마너가
  // 새 원문을 잘라 쓰게 한다(lib/callmaner.js memoWithVehicle) — 옛 요약을 그대로 두면 기사
  // 앱에는 고치기 전 내용이 계속 보인다. 여기서 다시 요약하지 않는 이유는 오더 수정이 모델
  // 호출을 기다릴 자리가 아니어서다.
  if ((memo_customer || null) !== order.memo_customer) {
    await db.run('UPDATE orders SET memo_driver_brief = NULL WHERE id = ?', [req.params.id])
      .catch((e) => {
        if (e && e.code === '42703') return; // 마이그레이션 20260819010000 전
        console.error('기사메모 요약 비우기 실패(무시):', e.message);
      });
  }

  if (diffs.length > 0) {
    await db.run(`
      INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note)
      VALUES (?, ?, ?, ?, ?)
    `, [req.params.id, u.id, order.status, order.status, diffs.join('; ')]);
    // 법인 공유 피드 — 이 diffs 문장을 그대로 재사용한다(경로·일시·차량·요금·고객사 메모
    // 변경이 이미 다 들어 있다 — "요청사항 추가·변경"도 memo_customer diff로 여기 포함된다).
    // 법인 자체를 옮기는 경우는 드물지만, 옮긴 뒤 기준(finalGroup)으로 기록해야 그 법인
    // 동료가 보게 된다.
    recordGroupActivity({
      groupId: finalGroup, orderId: order.id, oid: order.oid, kind: 'updated',
      summary: diffs.join('; '), actorUserId: u.id, actorLabel: u.name,
    });
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

  // 이미 콜마너에 접수된 오더(callmaner_conf_slip 있음)라면 방금 저장한 내용을 OrderModify로
  // 실시간 반영한다(registerOrderWithCallmaner와 같은 이유로 await한다 — 응답/리다이렉트가
  // 실패 상태보다 먼저 그려지면 실패 배너가 뒤늦게 뜬다). 아직 접수 전이면 함수 안에서 바로
  // 리턴하므로 여기서 분기할 필요 없다.
  await updateOrderWithCallmaner(req.params.id, finalBranch);

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

// 기타 정산 내역(주유비 · 주차요금 · 톨게이트) 저장.
//
// VOC와 달리 고객은 손댈 수 없다 — 거래처에 청구할 금액이라 우리 쪽에서만 넣는다. 고객이
// 자기 오더의 청구액을 바꿀 수 있으면 정산이 성립하지 않는다.
//
// 화면이 보낸 줄들로 통째로 갈아끼운다(lib/extraCharges.js replaceForOrder) — 줄마다
// 수정/삭제 버튼을 따로 두지 않아도 되고, VOC 저장과 같은 방식이라 새로 배울 것이 없다.
router.post('/:id/extra-charges', asyncHandler(async (req, res) => {
  if (req.session.user.role === 'client') return res.status(403).render('403', { title: '접근 권한 없음' });
  const order = await loadOrderForVoc(req, res);
  if (!order) return;

  const rows = extraCharges.parseRows(req.body, order.reserved_date);
  await extraCharges.replaceForOrder(order.id, rows, req.session.user.id);
  res.redirect('/orders/' + req.params.id);
}));

// AI 챗봇에서 오더를 방금 등록한 직후, 같은 대화창에 추가로 남긴 요청사항/질문을 그 오더에
// 붙여준다(public/js/ai-intake.js의 appendAdditionalRequestToLastOrder) — 예전에는 이런
// 후속 메시지가 "새 오더접수"로 다시 분류돼 똑같은 오더가 중복 등록되는 문제가 있었다.
// 고객도 자기 오더에 직접 남길 수 있어야 하므로 VOC와 같은 scopeFilter 기반 접근을 쓴다.
router.post('/:id/additional-request', asyncHandler(async (req, res) => {
  const order = await loadOrderForVoc(req, res);
  if (!order) return;
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: '추가할 내용이 없습니다.' });

  const now = kstNow();
  const stamp = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} `
    + `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const entry = `[추가요청 ${stamp}] ${text}`;
  const newMemo = order.memo_customer ? `${order.memo_customer}\n${entry}` : entry;

  await db.run(
    `UPDATE orders SET memo_customer = ?, updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [newMemo, req.params.id]
  );
  await db.run(
    `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note) VALUES (?, ?, ?, ?, ?)`,
    [req.params.id, req.session.user.id, order.status, order.status, `AI 챗봇 추가요청: ${text}`]
  );

  // 이미 콜마너에 접수된 오더면 바뀐 메모(기사 전달사항)까지 OrderModify로 반영한다.
  await updateOrderWithCallmaner(order.id, order.branch_id);

  broadcastOrderListChangedAsync();
  res.json({ ok: true });
}));

// 법인 공유 피드 — 같은 법인 소속 사용자들이 서로의 접수·취소·변경 요청을 보는 화면(사용자
// 확정 요청). /:id보다 먼저 등록해야 한다 — 안 그러면 "team-feed"가 오더 id로 읽혀버린다.
router.get('/team-feed', asyncHandler(async (req, res) => {
  const u = req.session.user;
  const groupId = u.group_id || null;
  const group = groupId ? await db.get('SELECT id, name, share_activity_feed FROM groups_tbl WHERE id = ?', [groupId]).catch(() => null) : null;
  const enabled = !!(group && group.share_activity_feed);
  const activities = enabled ? await listGroupActivity(groupId, 50) : [];
  res.render('orders/team_feed', {
    title: '팀 접수 현황 안내', groupName: group ? group.name : null, enabled, activities,
    kindLabels: ACTIVITY_KIND_LABELS,
  });
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
  // 콜마너 탁송사진(운행전/운행후)은 기사 업로드 사진과 별도 테이블이다 — 링크만 보관하므로
  // 콜마너가 만료시키면 썸네일이 깨질 수 있다(화면에서 onerror로 링크만 남긴다).
  const callmanerPhotoRows = canViewPhotos ? await callmanerPhotos.loadPhotos(req.params.id) : [];
  const legs = await buildOrderLegs(req.params.id, order, waypoints);
  // "상태 변경" 카드가 고객에게 대기/취소만 허용하도록 제한하려면(POST /:id/status와 같은
  // 기준) 배차 여부를 뷰에도 넘겨줘야 한다 — data.json(Next.js)은 이미 이 값을 내려주고 있었다.
  order.hasAssignedDriver = hasAssignedDriver(order, legs);

  // 기타 정산 내역은 청구 금액이라 고객에게는 내려주지 않는다(입력도 막혀 있다).
  const extraChargeRows = req.session.user.role === 'client' ? [] : await extraCharges.loadForOrder(req.params.id);

  res.render('orders/detail', {
    title: '오더 상세 - ' + order.oid, order, history, waypoints, drivers, photos,
    callmanerPhotos: callmanerPhotoRows, canViewPhotos, legs,
    extraCharges: extraChargeRows,
    // 요금설정에서 "제외(실비 정산)"로 둔 항목만 고를 수 있다 — "포함" 항목을 청구하면 이중 청구다.
    extraChargeTypes: await extraCharges.billableTypesForOrder(order),
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


// 오더수정(POST /:id)이 이미 콜마너에 접수된(callmaner_conf_slip 있는) 오더의 내용을
// 바꾸면 OrderModify로 실시간 반영한다 — registerOrderWithCallmaner(최초 접수)와 짝을 이루는
// 함수다. 아직 접수 전(conf_slip 없음)이면 여기서 할 일이 없다(최초 접수는 registerOrder
// WithCallmaner가 생성/상태변경 시점에 담당).
async function updateOrderWithCallmaner(orderId, branchId) {
  try {
    const branchRow = await db.get('SELECT * FROM branches WHERE id = ?', [branchId]);
    if (!branchRow || !branchRow.callmaner_enabled) return;
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order || !order.callmaner_conf_slip) return;
    const paymentMethodRow = order.payment_method_id
      ? await db.get('SELECT name FROM payment_methods WHERE id = ?', [order.payment_method_id])
      : null;
    const waypointRows = await db.all(
      'SELECT address, address_detail, lat, lon FROM order_waypoints WHERE order_id = ? ORDER BY seq',
      [orderId]
    ).catch(() => []);
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
      // 적요1에 실을 요약본(100Byte). 없으면 memo_customer를 잘라 쓴다.
      memo_driver_brief: order.memo_driver_brief || null,
      // 업체 전달사항 → 적요2. 기사에게는 보이지 않는 칸이다.
      memo_billing: order.memo_billing || '',
      // 콜마너에는 차량번호 칸이 없어 적요1 맨 앞에 실어 보낸다(lib/callmaner.js memoWithVehicle).
      // 이 값이 빠지면 차량번호를 고쳐도 콜마너 쪽 적요는 옛 번호로 남는다.
      vehicle_number: order.vehicle_number,
      // 우편발송 요청 건이면 인수증 업로드 링크를 적요1에 함께 싣는다(lib/callmaner.js memoWithVehicle).
      postal_requested: order.postal_requested,
      receipt_upload_token: order.receipt_upload_token,
      order_type: order.order_type,
      reserved_date: order.reserved_date, reserved_time: order.reserved_time,
    };
    await callmaner.orderModify(orderForCallmaner, branchRow, paymentMethodRow && paymentMethodRow.name, waypointRows, order.callmaner_conf_slip);
    await tryUpdateWithErrorCodeColumn(
      `UPDATE orders SET callmaner_synced_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
       callmaner_last_error = NULL, callmaner_last_error_code = NULL WHERE id = ?`,
      [orderId],
      `UPDATE orders SET callmaner_synced_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
       callmaner_last_error = NULL WHERE id = ?`,
      [orderId]
    );
  } catch (e) {
    console.error('콜마너 오더수정 실패:', e.message, e.rc ? `(rc=${e.rc})` : '');
    const msg = String(e.message || '').slice(0, 500);
    await tryUpdateWithErrorCodeColumn(
      'UPDATE orders SET callmaner_last_error = ?, callmaner_last_error_code = ? WHERE id = ?',
      [msg, e.rc ? String(e.rc).slice(0, 40) : null, orderId],
      'UPDATE orders SET callmaner_last_error = ? WHERE id = ?',
      [msg, orderId]
    );
  }
}

// 정의서에는 "아무 상태로나" 바꾸는 API가 없다 — 대기/접수 전환(OrderStanby/
// OrderStanbyRelease)과 취소(OrderCancel)만 지원한다. 그래서 우리 로컬 상태 중 이 세 가지에
// 대응되는 것만 실시간으로 콜마너에 반영하고(대기(확인중)/접수(배차중)도 같은 전환으로
// 취급), 나머지(기사배정/완료/문의/사고/과태료/취소요청/예약/오더등록)는 대응 API가 없어
// 그대로 둔다 — 그 상태들은 여전히 콜마너→우리 방향 폴링(OrderAllStatus)으로만 반영된다.
async function pushStatusChangeToCallmaner(order, status, note) {
  if (!order.callmaner_conf_slip) return; // 아직 콜마너에 접수 전이면 반영할 대상이 없다.
  try {
    const branchRow = await db.get('SELECT * FROM branches WHERE id = ?', [order.branch_id]);
    if (!branchRow || !branchRow.callmaner_enabled) return;

    const confSlip = order.callmaner_conf_slip;
    if (status === '취소') {
      await callmaner.orderCancel(branchRow, confSlip, note || null);
    } else if (status === '대기' || status === '대기(확인중)') {
      await callmaner.orderStanby(branchRow, confSlip, order.callmaner_status_code || '0');
    } else if (status === '접수' || status === '접수(배차중)') {
      await callmaner.orderStanbyRelease(branchRow, confSlip);
    } else {
      return; // 대응하는 콜마너 API가 없는 상태 — 로컬 상태만 바뀌고 콜마너 쪽은 그대로 둔다.
    }

    await tryUpdateWithErrorCodeColumn(
      `UPDATE orders SET callmaner_synced_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
       callmaner_last_error = NULL, callmaner_last_error_code = NULL WHERE id = ?`,
      [order.id],
      `UPDATE orders SET callmaner_synced_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
       callmaner_last_error = NULL WHERE id = ?`,
      [order.id]
    );
  } catch (e) {
    console.error('콜마너 상태변경 반영 실패:', e.message, e.rc ? `(rc=${e.rc})` : '');
    const msg = String(e.message || '').slice(0, 500);
    await tryUpdateWithErrorCodeColumn(
      'UPDATE orders SET callmaner_last_error = ?, callmaner_last_error_code = ? WHERE id = ?',
      [msg, e.rc ? String(e.rc).slice(0, 40) : null, order.id],
      'UPDATE orders SET callmaner_last_error = ? WHERE id = ?',
      [msg, order.id]
    );
  }
}


// 고객(client)은 상태를 볼 수만 있고 원래 바꿀 수 없었는데, "기사배정 전 취소/보류"만은
// 직접 할 수 있어야 한다는 사용자 요청으로 제한적으로 열었다 — 대상 상태는 '대기'/'취소'
// 뿐이고, 이미 기사가 배정된 뒤에는(hasAssignedDriver) 아예 막고 상담원/고객센터로
// 안내한다(같은 이유로 오더 내용 자체도 배차 후엔 client가 못 고치게 막혀 있다, isClient
// 분기 참고). loadOrderInScope는 client를 통째로 403 시키므로 loadOrderForVoc(scopeFilter
// 기반)를 쓴다. 프런트(OrderSidePanel.js)에서도 같은 규칙으로 폼 자체를 안 보여주거나
// 선택지를 좁히지만, 여긴 우회 방지용 최종 검증이다.
const CLIENT_ALLOWED_STATUS_TARGETS = ['대기', '취소'];

router.post('/:id/status', asyncHandler(async (req, res) => {
  const u = req.session.user;
  const isClient = u.role === 'client';
  const order = isClient ? await loadOrderForVoc(req, res) : await loadOrderInScope(req, res);
  if (!order) return;
  const { status, note } = req.body;

  if (isClient) {
    const waypoints = await db.all('SELECT * FROM order_waypoints WHERE order_id = ? ORDER BY seq ASC', [req.params.id]);
    const legs = await buildOrderLegs(req.params.id, order, waypoints);
    if (hasAssignedDriver(order, legs)) {
      return res.status(403).send('기사님이 이미 배정된 상태입니다. 상태 변경은 상담원 챗봇이나 고객센터를 통해 요청해주세요.');
    }
    if (!CLIENT_ALLOWED_STATUS_TARGETS.includes(status)) {
      return res.status(403).send('고객 계정은 대기 또는 취소로만 상태를 변경할 수 있습니다.');
    }
  }

  await db.run(
    `UPDATE orders SET status = ?, updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [status, req.params.id]
  );
  await db.run(`
    INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note)
    VALUES (?, ?, ?, ?, ?)
  `, [req.params.id, u.id, order.status, status, note || null]);

  // 법인 공유 피드 — 취소만 담는다(그 외 상태 전이는 콜마너 폴링으로도 일어나는 운영
  // 정보라 "동료의 요청"이 아니다). client든 admin/branch_manager가 대신 처리했든
  // "우리 회사 오더가 취소됐다"는 사실 자체는 법인 전체가 알아야 할 정보라 실행 주체를
  // 가리지 않는다.
  if (status === '취소') {
    recordGroupActivity({
      groupId: order.requester_group_id, orderId: order.id, oid: order.oid, kind: 'cancelled',
      summary: note ? `취소 — ${note}` : '취소', actorUserId: u.id, actorLabel: u.name,
    });
  }

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

  // 이미 콜마너에 접수된 오더라면, 이번 상태변경도 실시간으로 반영한다(사용자 요청 —
  // 상담원/관리자뿐 아니라 지금 이 라우트를 통과한 모든 변경, 즉 client의 대기/취소 포함).
  await pushStatusChangeToCallmaner(order, status, note);

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
// MCP 배차 도우미(lib/mcpDispatchAgent.js)가 콜마너 MCP 도구로 주문을 변경한 뒤, 그 결과가
// 우리 orders 테이블에도 반영되도록(그리고 OrderModify로 콜마너에 다시 한번 확실히 반영되도록)
// 재사용한다 — Express 라우터 함수 자체에 속성을 붙이는 것이라 app.use(orderRoutes) 쪽에는
// 영향이 없다.
module.exports.updateOrderWithCallmaner = updateOrderWithCallmaner;
// 도우미 사전 실행 여부 판단 — 순수함수라 검사에서 직접 부른다(scripts/check-mcp-speculative.js).
module.exports.shouldProbeDispatch = shouldProbeDispatch;
