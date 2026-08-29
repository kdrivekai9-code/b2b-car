const express = require('express');
const db = require('../db');
const { pool } = require('../db');
const { requireAuth, requireRole, scopeFilter } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { kstNow } = require('../lib/period');
const { createOrder } = require('../lib/orderCreate');

const router = express.Router();
router.use(requireAuth);

function defaultReservedDateTime() {
  const now = kstNow();
  const pad = (n) => String(n).padStart(2, '0');
  let hour = now.getUTCHours();
  let minute = Math.ceil(now.getUTCMinutes() / 10) * 10;
  if (minute >= 60) { minute = 0; hour = (hour + 1) % 24; }
  return {
    reserved_date: `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`,
    reserved_time: `${pad(hour)}:${pad(minute)}`,
  };
}

function combineAddress(main, detail) {
  const m = String(main || '').trim();
  const d = String(detail || '').trim();
  return d ? `${m} ${d}` : m;
}

function parseFerryLegsJson(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

async function loadInquiryWithScope(id, req) {
  const inquiry = await db.get('SELECT * FROM inquiries WHERE id = ?', [id]);
  if (!inquiry) return null;

  const scope = scopeFilter(req);
  if (scope.branch_id && Number(inquiry.branch_id) !== Number(scope.branch_id)) return null;
  if (scope.group_id && Number(inquiry.requester_group_id) !== Number(scope.group_id)) return null;
  return inquiry;
}

router.post('/', asyncHandler(async (req, res) => {
  const user = req.session.user;
  const scope = scopeFilter(req);

  const category = String(req.body.category || 'general');
  const inquiryText = String(req.body.inquiry_text || '').trim();
  if (!inquiryText) return res.status(400).json({ error: '문의 내용이 필요합니다.' });

  const allowedCategory = ['fare', 'general'];
  const finalCategory = allowedCategory.includes(category) ? category : 'general';
  const finalBranchId = scope.branch_id || req.body.branch_id || user.branch_id || null;
  const finalGroupId = scope.group_id || req.body.requester_group_id || user.group_id || null;

  const inserted = await db.run(
    `INSERT INTO inquiries (
      chat_session_id, user_id, branch_id, requester_group_id,
      category, status, inquiry_text,
      origin_text, destination_text, vehicle_type,
      resolved_origin, resolved_destination,
      estimated_distance_km, estimated_fare, fare_source,
      estimated_ferry_fare,
      has_ferry_leg, ferry_legs_json
    ) VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id`,
    [
      req.body.chat_session_id || null,
      user.id,
      finalBranchId,
      finalGroupId,
      finalCategory,
      inquiryText,
      req.body.origin_text || null,
      req.body.destination_text || null,
      req.body.vehicle_type || null,
      req.body.resolved_origin || null,
      req.body.resolved_destination || null,
      req.body.estimated_distance_km ? Number(req.body.estimated_distance_km) : null,
      req.body.estimated_fare ? Number(req.body.estimated_fare) : null,
      req.body.fare_source || null,
      req.body.estimated_ferry_fare ? Number(req.body.estimated_ferry_fare) : null,
      req.body.has_ferry_leg ? true : false,
      req.body.ferry_legs_json || null,
    ]
  );

  res.json({ id: Number(inserted.lastInsertRowid) });
}));

router.post('/:id/estimate', asyncHandler(async (req, res) => {
  const inquiry = await loadInquiryWithScope(req.params.id, req);
  if (!inquiry) return res.status(404).json({ error: '문의를 찾을 수 없습니다.' });

  const user = req.session.user;
  if (user.role === 'client' && Number(inquiry.user_id) !== Number(user.id)) {
    return res.status(403).json({ error: '접근 권한이 없습니다.' });
  }

  await db.run(
    `UPDATE inquiries
     SET resolved_origin = COALESCE(?, resolved_origin),
         resolved_destination = COALESCE(?, resolved_destination),
         estimated_distance_km = COALESCE(?, estimated_distance_km),
         estimated_fare = COALESCE(?, estimated_fare),
         fare_source = COALESCE(?, fare_source),
       estimated_ferry_fare = COALESCE(?, estimated_ferry_fare),
         has_ferry_leg = COALESCE(?, has_ferry_leg),
         ferry_legs_json = COALESCE(?, ferry_legs_json),
         updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
     WHERE id = ?`,
    [
      req.body.resolved_origin || null,
      req.body.resolved_destination || null,
      req.body.estimated_distance_km ? Number(req.body.estimated_distance_km) : null,
      req.body.estimated_fare ? Number(req.body.estimated_fare) : null,
      req.body.fare_source || null,
      req.body.estimated_ferry_fare ? Number(req.body.estimated_ferry_fare) : null,
      typeof req.body.has_ferry_leg === 'boolean' ? req.body.has_ferry_leg : null,
      req.body.ferry_legs_json || null,
      req.params.id,
    ]
  );

  res.json({ ok: true });
}));

// EJS 렌더 라우트와 Next.js 프리뷰(GET /inquiries/data.json)가 완전히 동일한 쿼리/스코핑
// 로직을 공유하도록 분리했다 — dashboard.js/orders.js와 동일한 패턴. LIMIT 300으로
// 페이지네이션 없이 캡핑하는 기존 동작도 그대로 유지한다(계약 변경 없음).
async function buildInquiriesListData(scope, query) {
  const where = [];
  const params = [];

  if (scope.branch_id) { where.push('i.branch_id = ?'); params.push(scope.branch_id); }
  if (scope.group_id) { where.push('i.requester_group_id = ?'); params.push(scope.group_id); }
  if (scope.created_by) { where.push('i.created_by = ?'); params.push(scope.created_by); }
  if (query.status) { where.push('i.status = ?'); params.push(query.status); }
  if (query.category) { where.push('i.category = ?'); params.push(query.category); }
  if (query.q) {
    where.push('(i.inquiry_text LIKE ? OR i.origin_text LIKE ? OR i.destination_text LIKE ?)');
    params.push(`%${query.q}%`, `%${query.q}%`, `%${query.q}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const inquiries = await db.all(
    `SELECT i.*, u.name AS user_name, b.name AS branch_name, g.name AS corporation_name
     FROM inquiries i
     LEFT JOIN users u ON u.id = i.user_id
     LEFT JOIN branches b ON b.id = i.branch_id
     LEFT JOIN groups_tbl g ON g.id = i.requester_group_id
     ${whereSql}
     ORDER BY i.id DESC
     LIMIT 300`,
    params
  );

  return {
    inquiries,
    filters: {
      status: query.status || '',
      category: query.category || '',
      q: query.q || '',
    },
  };
}

router.get('/', requireRole('admin', 'branch_manager'), asyncHandler(async (req, res) => {
  const data = await buildInquiriesListData(scopeFilter(req), req.query);
  res.render('inquiries/list', { title: '문의 관리', ...data });
}));

// Next.js Stage 1 프리뷰(src/app/inquiries/page.js)가 fetch()로 호출하는 JSON 버전 — 같은
// requireRole('admin','branch_manager')와 같은 scopeFilter/쿼리를 그대로 재사용한다.
// client 역할은 EJS와 동일하게 403(HTML)을 그대로 받는다 — 별도 JSON 403 처리를 추가하지
// 않는다(계약 변경 없음); React 페이지 쪽에서 그 HTML 403을 감지해 동일한 안내를 보여준다.
router.get('/data.json', requireRole('admin', 'branch_manager'), asyncHandler(async (req, res) => {
  const data = await buildInquiriesListData(scopeFilter(req), req.query);
  res.json({ ...data, currentUser: req.session.user });
}));

router.get('/:id', requireRole('admin', 'branch_manager'), asyncHandler(async (req, res) => {
  const inquiry = await loadInquiryWithScope(req.params.id, req);
  if (!inquiry) return res.status(404).send('문의를 찾을 수 없습니다.');

  const detail = await db.get(
    `SELECT i.*, u.name AS user_name, b.name AS branch_name, g.name AS corporation_name, o.oid AS converted_oid
     FROM inquiries i
     LEFT JOIN users u ON u.id = i.user_id
     LEFT JOIN branches b ON b.id = i.branch_id
     LEFT JOIN groups_tbl g ON g.id = i.requester_group_id
     LEFT JOIN orders o ON o.id = i.converted_order_id
     WHERE i.id = ?`,
    [req.params.id]
  );

  res.render('inquiries/detail', {
    title: '문의 상세',
    inquiry: detail,
    ferryLegs: parseFerryLegsJson(detail && detail.ferry_legs_json),
  });
}));

router.post('/:id/status', requireRole('admin', 'branch_manager'), asyncHandler(async (req, res) => {
  const inquiry = await loadInquiryWithScope(req.params.id, req);
  if (!inquiry) return res.status(404).send('문의를 찾을 수 없습니다.');

  const allowed = ['new', 'in_progress', 'waiting_customer', 'answered', 'converted_to_order', 'closed'];
  const status = String(req.body.status || '').trim();
  if (!allowed.includes(status)) return res.status(400).send('유효하지 않은 상태값입니다.');

  await db.run(
    `UPDATE inquiries
     SET status = ?,
         handled_at = CASE WHEN ? IN ('in_progress','answered','converted_to_order') THEN to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') ELSE handled_at END,
         closed_at = CASE WHEN ? = 'closed' THEN to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') ELSE closed_at END,
         updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
     WHERE id = ?`,
    [status, status, status, req.params.id]
  );

  res.redirect(`/inquiries/${req.params.id}`);
}));

router.post('/:id/convert-order', requireRole('admin', 'branch_manager'), asyncHandler(async (req, res) => {
  const inquiry = await loadInquiryWithScope(req.params.id, req);
  if (!inquiry) return res.status(404).send('문의를 찾을 수 없습니다.');
  if (inquiry.converted_order_id) return res.redirect(`/orders/${inquiry.converted_order_id}`);

  const user = req.session.user;
  const defaultDateTime = defaultReservedDateTime();

  const finalBranch = inquiry.branch_id || user.branch_id;
  if (!finalBranch) return res.status(400).send('오더 전환을 위한 지사 정보가 없습니다.');

  const finalOrigin = combineAddress(inquiry.resolved_origin || inquiry.origin_text, null);
  const finalDestination = combineAddress(inquiry.resolved_destination || inquiry.destination_text, null);
  if (!finalOrigin || !finalDestination) return res.status(400).send('출발지/도착지 정보가 부족하여 오더로 전환할 수 없습니다.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 오더 저장은 웹 오더등록·카카오 자동접수와 같은 함수를 쓴다(lib/orderCreate.js).
    // 이 경로는 문의 상태 변경과 한 트랜잭션이어야 해서 client를 넘긴다 — 오더만 만들어지고
    // 문의가 그대로 남거나 그 반대가 되면 같은 문의가 두 번 전환될 수 있다.
    const created = await createOrder({
      branchId: finalBranch,
      requesterGroupId: inquiry.requester_group_id || null,
      originAddress: finalOrigin,
      originContact: '미정',
      destinationAddress: finalDestination,
      destinationContact: '미정',
      vehicleNumber: null,
      vehicleType: inquiry.vehicle_type || null,
      reservedDate: defaultDateTime.reserved_date,
      reservedTime: defaultDateTime.reserved_time,
      paymentMethodId: null,
      fareAmount: inquiry.estimated_fare,
      ferryFareAmount: inquiry.estimated_ferry_fare,
      memoCustomer: `[문의 전환] ${inquiry.inquiry_text}`,
      createdBy: user.id,
      sourceChannel: 'inquiry',
      historyNote: '문의에서 오더로 전환',
    }, { client });

    const orderId = created.orderId;
    const oid = created.oid;

    await client.query(
      `UPDATE inquiries
       SET status = 'converted_to_order',
           converted_order_id = $1,
           handled_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
           updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
       WHERE id = $2`,
      [orderId, req.params.id]
    );

    await client.query('COMMIT');
    res.redirect(`/orders/${orderId}`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

module.exports = router;
