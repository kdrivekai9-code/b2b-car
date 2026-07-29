const express = require('express');
const db = require('../db');
const { requireAuth, scopeFilter, getSessionProblem } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ORDER_STATUSES } = require('../config');
const { getEffectivePaymentMethods, getEffectiveStatuses, checkOperatingHours, calculateFareWithFerry } = require('../lib/branchPolicy');
const { notify } = require('../lib/push');
const { kstNow } = require('../lib/period');
const { parseIntakeText } = require('../lib/aiIntakeParser');
const { classifyAndExtract, classifyPhaseReply } = require('../lib/hybridChat');
const { searchKnowledgeBase } = require('../lib/knowledgeSearch');
const { broadcastMessage, broadcastSessionListChanged } = require('../lib/realtimeChat');
const { splitTypeAndPlate } = require('../lib/vehicleInfo');

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

const ORDERS_PAGE_SIZE = 50;

router.get('/', asyncHandler(async (req, res) => {
  const scope = scopeFilter(req);
  const { branch_id, status, from, to, q } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * ORDERS_PAGE_SIZE;

  const where = [];
  const params = [];

  if (scope.branch_id) { where.push('o.branch_id = ?'); params.push(scope.branch_id); }
  if (scope.group_id) { where.push('o.requester_group_id = ?'); params.push(scope.group_id); }
  if (!scope.branch_id && branch_id) { where.push('o.branch_id = ?'); params.push(branch_id); }
  if (status) { where.push('o.status = ?'); params.push(status); }
  if (from) { where.push('o.reserved_date >= ?'); params.push(from); }
  if (to) { where.push('o.reserved_date <= ?'); params.push(to); }
  if (q) { where.push('(o.oid LIKE ? OR o.origin_address LIKE ? OR o.destination_address LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const sql = `
    SELECT o.*, b.name AS branch_name, g.name AS group_name, g.main_phone AS group_phone,
      pm.name AS payment_method_name, d.name AS driver_name, d.phone AS driver_phone,
      (SELECT string_agg(w.address, ', ' ORDER BY w.seq) FROM order_waypoints w WHERE w.order_id = o.id) AS waypoints_text,
      (SELECT COUNT(*) FROM order_photos p WHERE p.order_id = o.id) AS photo_count
    FROM orders o
    JOIN branches b ON b.id = o.branch_id
    LEFT JOIN groups_tbl g ON g.id = o.requester_group_id
    LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
    LEFT JOIN drivers d ON d.id = o.assigned_driver_id
    ${whereSql}
    ORDER BY o.reserved_date DESC, o.reserved_time DESC
    LIMIT ? OFFSET ?
  `;
  const countSql = `SELECT COUNT(*) AS total FROM orders o ${whereSql}`;

  // 서로 의존관계 없는 조회라 병렬로 실행한다 — 순차로 기다리면 왕복시간이 그대로 더해진다.
  const [orders, countRow, branches] = await Promise.all([
    db.all(sql, [...params, ORDERS_PAGE_SIZE, offset]),
    db.get(countSql, params),
    db.all('SELECT * FROM branches ORDER BY name'),
  ]);

  const totalCount = Number(countRow.total);
  const totalPages = Math.max(1, Math.ceil(totalCount / ORDERS_PAGE_SIZE));

  res.render('orders/list', {
    title: '오더 리스트',
    orders, branches, ORDER_STATUSES,
    filters: { branch_id: branch_id || '', status: status || '', from: from || '', to: to || '', q: q || '' },
    pagination: { page, pageSize: ORDERS_PAGE_SIZE, totalCount, totalPages },
  });
}));

router.get('/new', asyncHandler(async (req, res) => {
  const scope = scopeFilter(req);
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
    db.all('SELECT * FROM favorite_addresses WHERE user_id = ? ORDER BY id DESC', [req.session.user.id]),
  ]);
  res.render('orders/form', {
    title: '오더 등록', order: defaultReservedDateTime(), branches, groups, paymentMethods, favorites, mode: 'create', error: null,
    defaultBranch: scope.branch_id || '', defaultGroup: scope.group_id || '',
    kakaoJsKey: process.env.KAKAO_JS_KEY || '',
  });
}));

router.get('/ai-intake', asyncHandler(async (req, res) => {
  const scope = scopeFilter(req);
  // 최근 대화 목록(햄버거 메뉴)에서 과거 세션을 클릭하면 ?session=<id>로 넘어온다 — 이때는
  // "가장 최근의 열린 세션" 대신 사용자가 직접 고른 그 세션을 복원한다(본인 소유일 때만).
  const requestedSessionId = Number(req.query.session) || null;
  // 서로 의존관계 없는 조회들이라 병렬로 실행한다(오더 등록 화면과 동일한 이유) —
  // existingMessages만 existingSession의 id가 있어야 조회할 수 있어 그 결과 이후로 남겨둔다.
  const [branches, groups, paymentMethods, favorites, existingSession] = await Promise.all([
    scope.branch_id
      ? db.all('SELECT * FROM branches WHERE id = ?', [scope.branch_id])
      : db.all("SELECT * FROM branches WHERE status='active' ORDER BY name"),
    db.all('SELECT * FROM groups_tbl ORDER BY name'),
    scope.branch_id
      ? getEffectivePaymentMethods(scope.branch_id)
      : db.all('SELECT * FROM payment_methods WHERE is_active = 1 ORDER BY id'),
    db.all('SELECT * FROM favorite_addresses WHERE user_id = ? ORDER BY id DESC', [req.session.user.id]),
    requestedSessionId
      ? db.get(
          `SELECT id, status, draft_json FROM chat_sessions WHERE id = ? AND user_id = ? AND user_hidden_at IS NULL`,
          [requestedSessionId, req.session.user.id]
        )
      // 다른 메뉴로 이동했다 돌아와도 대화가 이어지도록, 아직 닫히지 않은 최근 세션이 있으면 그대로 재사용한다.
      // 클라이언트 저장소(localStorage 등)에 의존하지 않고 서버가 로그인 세션만으로 판단한다.
      : db.get(
          `SELECT id, status, draft_json FROM chat_sessions WHERE user_id = ? AND status != 'closed' AND user_hidden_at IS NULL ORDER BY created_at DESC LIMIT 1`,
          [req.session.user.id]
        ),
  ]);
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

  req.session.aiLastInputAt = Date.now();

  res.render('orders/ai_intake', {
    title: 'AI 챗봇', order: defaultReservedDateTime(), branches, groups, paymentMethods, favorites, mode: 'create', error: null,
    defaultBranch: scope.branch_id || '', defaultGroup: scope.group_id || '',
    kakaoJsKey: process.env.KAKAO_JS_KEY || '',
    existingSession, existingMessages, existingDraft,
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
    return '저는 탁송 오더 접수와 업무 안내를 도와드리는 AI 챗봇입니다. 오더 접수 내용을 입력하시거나, 탁송 관련 궁금한 점을 질문해주세요.';
  }

  if (!hasBusinessKeyword(normalized) && /(뭘\s*할\s*수\s*있|무엇을\s*도와|어떤\s*업무|사용법|어떻게\s*써|도움\s*줘)/i.test(normalized)) {
    return '오더 접수 내용 자동 입력, 탁송 FAQ 안내, 처리 어려운 요청의 상담원 연결을 도와드릴 수 있습니다. 원하시는 내용을 말씀해주세요.';
  }

  if (/(^|\s)(안녕(?:하세요)?|하이|hello|hi|헬로|반가워)(\s|$)/i.test(normalized)) {
    return '안녕하세요. 오더 접수 내용을 입력하시거나, 탁송 관련 궁금한 점을 질문해주세요.';
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
      message: '안녕하세요. 오더 접수 내용을 입력하시거나, 탁송 관련 궁금한 점을 질문해주세요.',
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
  // 탁송 서류 문구만으로 판별된 경우 예약일시가 비어 있을 수 있다(언제 보낼지 안 적고 지금 바로
  // 보내는 차량인 경우) — 이때는 사용자에게 다시 묻지 않고 현재 시각으로 채운다.
  if (intent === 'dispatch_order' && !fields.reserved_date && !fields.reserved_time) {
    const now = defaultReservedDateTime();
    fields.reserved_date = now.reserved_date;
    fields.reserved_time = now.reserved_time;
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

router.get('/fare-preview', asyncHandler(async (req, res) => {
  const branchId = req.query.branch_id || null;
  const distanceKm = parseFloat(req.query.distance_km);
  if (!Number.isFinite(distanceKm)) return res.json({ enabled: false });
  const result = await calculateFareWithFerry(branchId, distanceKm, {
    vehicleType: req.query.vehicle_type || req.query.vehicleType || '',
    hasFerryLeg: req.query.has_ferry_leg === '1' || req.query.has_ferry_leg === 'true',
    reservedDate: req.query.reserved_date || null,
    dayType: req.query.day_type || req.query.dayType || '',
    routeMeta: (() => {
      if (!req.query.route_meta_json) return null;
      try { return JSON.parse(req.query.route_meta_json); } catch (e) { return null; }
    })(),
  });
  res.json(result);
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
    vehicle_type, payment_method_id, fare_amount, ferry_fare_amount, memo_customer, chat_session_id, chat_session_transition,
    pickup_reserved_date, pickup_reserved_time,
  } = req.body;
  const waypoints = [].concat(req.body.waypoints || []);
  const waypointDetails = [].concat(req.body.waypoint_details || []);
  const waypointContacts = [].concat(req.body.waypoint_contacts || []);
  const waypointVehicleNumbers = [].concat(req.body.waypoint_vehicle_numbers || []);
  const finalWaypoints = waypoints
    .map((w, i) => ({
      address: combineAddress(w, waypointDetails[i]),
      addressDetail: waypointDetails[i] || null,
      contact: waypointContacts[i] || null,
      vehicleNumber: waypointVehicleNumbers[i] || null,
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

  const tempOid = 'PENDING-' + Date.now();
  let inserted;
  try {
    inserted = await db.run(`
      INSERT INTO orders (oid, branch_id, requester_group_id, origin_address, origin_address_detail, origin_contact,
        destination_address, destination_address_detail, destination_contact, vehicle_number,
        vehicle_type, reserved_date, reserved_time, payment_method_id, fare_amount, ferry_fare_amount, status, memo_customer, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '오더등록', ?, ?)
      RETURNING id
    `, [
      tempOid, finalBranch, finalGroup, finalOriginAddress, origin_detail_address || null, origin_contact || null,
      finalDestinationAddress, destination_detail_address || null, destination_contact || null, splitVehicle.vehicleNumber,
      splitVehicle.vehicleType, effectiveReservedDate, effectiveReservedTime, payment_method_id || null, Number(fare_amount) || 0, Number(ferry_fare_amount) || 0, memo_customer || null, u.id,
    ]);
  } catch (e) {
    const msg = String((e && e.message) || '');
    const missingCompatColumns = e && e.code === '42703' && /(vehicle_type|ferry_fare_amount)/.test(msg);
    if (!missingCompatColumns) throw e;

    // 구버전 DB(마이그레이션 미적용)에서는 vehicle_type/ferry_fare_amount 없이 저장해도 기본 흐름을 유지한다.
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
      'INSERT INTO order_waypoints (order_id, seq, address, address_detail, contact_phone, vehicle_number) VALUES (?, ?, ?, ?, ?, ?)',
      [newId, i + 1, finalWaypoints[i].address, finalWaypoints[i].addressDetail, finalWaypoints[i].contact, finalWaypoints[i].vehicleNumber]
    );
  }

  await db.run(`
    INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note)
    VALUES (?, ?, NULL, '오더등록', '최초 등록')
  `, [newId, u.id]);

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

  if (wantsJson) return res.json({ orderId: newId, oid });
  res.redirect('/orders/' + newId);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const order = await db.get(`
    SELECT o.*, b.name AS branch_name, g.name AS group_name, pm.name AS payment_method_name, d.name AS driver_name
    FROM orders o
    JOIN branches b ON b.id = o.branch_id
    LEFT JOIN groups_tbl g ON g.id = o.requester_group_id
    LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
    LEFT JOIN drivers d ON d.id = o.assigned_driver_id
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

  res.render('orders/detail', {
    title: '오더 상세 - ' + order.oid, order, history, waypoints, drivers, photos, canViewPhotos,
    baseUrl: req.protocol + '://' + req.get('host'),
    ORDER_STATUSES: statusConfig.map((s) => s.status_code),
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

  res.redirect('/orders/' + req.params.id);
}));

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

  try {
    await notify({
      branchId: order.branch_id, eventType: 'order_events', excludeUserId: u.id,
      title: '오더 상태 변경', body: `${order.oid}: ${order.status} → ${status}`, url: `/orders/${order.id}`,
    });
  } catch (e) { console.error('알림 발송 실패:', e.message); }

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
  res.redirect('/orders/' + req.params.id);
}));

module.exports = router;
