// 기사 챗봇 — 콜마너 앱이 여는 모바일 화면.
//
// 로그인이 없다. 기사는 이미 콜마너 앱에 로그인해 있고, 앱이 서명한 토큰으로 신원을 넘겨준다
// (lib/driverToken.js). 그래서 이 라우터는 requireAuth보다 **먼저** 마운트해야 한다 —
// routes/photoUpload.js·receiptUpload.js와 같은 자리다.
//
// 대화는 오더에 매인다. 기사는 하루에 여러 건을 돌고 상담원은 여러 기사를 동시에 상대하므로,
// 대화가 사람 단위면 "그 차 어디예요"가 어느 건인지 매번 되물어야 하고 영수증은 어느 오더
// 것인지 알 수 없다.
const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const driverToken = require('../lib/driverToken');
const extraCharges = require('../lib/extraCharges');
const memoExtraCosts = require('../lib/memoExtraCosts');
const multer = require('multer');
const receiptOcr = require('../lib/receiptOcr');
const postalReceipt = require('../lib/postalReceipt');
const { ensureBucket, uploadPhoto } = require('../lib/storage');
const { notify } = require('../lib/push');
const { logIntegrationErrorAsync } = require('../lib/integrationLog');

const router = express.Router();

// 기사가 볼 수 있는 오더 — 콜마너가 이 사번으로 배차한, 아직 끝나지 않은 건.
//
// 끝난 건을 빼는 이유는 화면이 아니라 권한이다. 완료·취소된 오더의 고객 연락처와 주소를
// 언제까지고 볼 이유가 없다. 어제 돈 건을 오늘 다시 열어보는 일은 없다.
const DRIVER_ORDER_SQL = `
  SELECT o.id, o.oid, o.status, o.reserved_date, o.reserved_time,
         o.origin_address, o.origin_address_detail, o.origin_contact,
         o.destination_address, o.destination_address_detail, o.destination_contact,
         o.vehicle_number, o.vehicle_type, o.memo_customer,
         __OPTIONAL__
         -- 요청사항에서 채택된 부대비용을 기사 화면에 함께 보여준다(buildDriverTasks).
         o.memo_extra_json,
         o.callmaner_conf_slip, o.callmaner_driver_sabun,
         -- 발주 지사 이름만. 전화는 이 화면에서 걸지 않는다.
         b.name AS branch_name
    FROM orders o
    LEFT JOIN branches b ON b.id = o.branch_id
   WHERE o.callmaner_driver_sabun = ?
     AND o.status NOT IN ('완료', '취소')
   ORDER BY o.reserved_date ASC, o.reserved_time ASC, o.id ASC`;

// 마이그레이션이 아직 안 돌았을 수 있는 칸은 빼고 한 번 더 시도한다.
//
// 없는 칸 하나 때문에 기사 화면이 통째로 죽으면 안 된다 — 기사는 그 화면 말고 다른 길이 없고,
// 무엇이 잘못됐는지도 모른다. lib/orderCreate.js가 같은 방식으로 버틴다(42703 = 없는 칸).
const OPTIONAL_DRIVER_COLUMNS = `
         -- 길이 제한이 없는 쪽. 적요1(100Byte)에 못 담는 안내가 여기로 온다.
         o.memo_driver_chat,
         -- 인수증 등기 발송 요청. 이 링크는 지금까지 적요1로만 나갔는데, 적요1은 100Byte라
         -- 차량번호·요청사항과 자리를 다투다 잘릴 수 있다. 잘리면 기사는 인수증을 어디에
         -- 올려야 하는지 알 방법이 없다 — 길이 제한이 없는 이 화면에도 함께 띄운다.
         o.postal_requested, o.receipt_upload_token,`;

async function loadDriverOrders(sabun) {
  try {
    return await db.all(DRIVER_ORDER_SQL.replace('__OPTIONAL__', OPTIONAL_DRIVER_COLUMNS), [sabun]);
  } catch (e) {
    if (!(e && e.code === '42703')) throw e;
    console.error('기사 오더 조회 — 아직 없는 칸을 빼고 다시 시도한다:', e.message);
    return db.all(DRIVER_ORDER_SQL.replace('__OPTIONAL__', ''), [sabun]);
  }
}

// 사번으로 기사를 찾고, 없으면 만든다.
//
// 명부를 통째로 받지 않아도 시작할 수 있게 만든다는 뜻이다. 콜마너가 배차하면
// orders.callmaner_driver_sabun에 사번이 쌓이므로, 기사가 처음 들어오는 순간 그 사번으로
// 명부에 한 줄이 생긴다. 명부 엑셀은 나중에 이름·전화를 채우는 데 쓰면 된다.
async function findOrCreateDriver(claims) {
  const sabun = String(claims.sabun || '').trim();
  if (!sabun) return null;

  const found = await db.get('SELECT * FROM drivers WHERE callmaner_sabun = ?', [sabun]).catch(() => null);
  if (found) return found;

  const name = String(claims.name || '').trim() || `기사 ${sabun}`;
  // 이름으로 이미 있는 기사에 사번만 붙여주는 경우가 흔하다 — 명부를 먼저 만들어 둔 지사.
  // 사번이 비어 있는 동명이인이 여럿이면 붙이지 않는다(엉뚱한 사람에 이어붙이면 남의 오더가
  // 그 사람 화면에 뜬다). 그때는 새로 만들고 사람이 나중에 합친다.
  const sameName = await db.all(
    'SELECT * FROM drivers WHERE name = ? AND (callmaner_sabun IS NULL OR callmaner_sabun = \'\')',
    [name]
  ).catch(() => []);
  if (sameName.length === 1) {
    await db.run('UPDATE drivers SET callmaner_sabun = ? WHERE id = ?', [sabun, sameName[0].id]);
    return { ...sameName[0], callmaner_sabun: sabun };
  }

  // drivers.branch_id는 NOT NULL이다. 콜마너 토큰의 branchCode는 콜마너 쪽 코드라 우리
  // branches.id와 다르므로, **그 사번으로 배차된 오더의 지사**를 쓴다 — 기사가 실제로 일한
  // 곳이라 가장 정확하다. 그마저 없으면(첫 진입이 배차보다 빠른 경우) 지사 하나를 골라 둔다.
  // 지사를 잘못 잡아도 조회 범위는 사번으로 걸리므로 남의 오더가 보이지는 않는다.
  const fromOrder = await db.get(
    `SELECT branch_id FROM orders WHERE callmaner_driver_sabun = ? AND branch_id IS NOT NULL
      ORDER BY id DESC LIMIT 1`,
    [sabun]
  ).catch(() => null);
  const fallback = await db.get('SELECT id FROM branches ORDER BY id ASC LIMIT 1').catch(() => null);
  const branchId = (fromOrder && fromOrder.branch_id) || (fallback && fallback.id) || null;

  const created = await db.run(
    'INSERT INTO drivers (name, phone, status, branch_id, callmaner_sabun) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [name, null, '활성', branchId, sabun]
  );
  return db.get('SELECT * FROM drivers WHERE id = ?', [created.lastInsertRowid]);
}

// 이 오더·이 기사의 대화. 없으면 만든다.
//
// 유니크 인덱스가 (order_id, driver_id) where channel='driver'로 걸려 있어서, 동시에 두 번
// 들어와도 하나만 남는다. 그 충돌은 오류가 아니라 정상이므로 다시 읽어서 돌려준다.
async function findOrCreateSession(orderId, driver) {
  const find = () => db.get(
    "SELECT * FROM chat_sessions WHERE channel = 'driver' AND order_id = ? AND driver_id = ?",
    [orderId, driver.id]
  );
  const found = await find().catch(() => null);
  if (found) return found;

  try {
    const created = await db.run(
      `INSERT INTO chat_sessions (channel, status, order_id, driver_id, external_name)
       VALUES ('driver', 'bot', ?, ?, ?) RETURNING id`,
      [orderId, driver.id, driver.name || null]
    );
    return db.get('SELECT * FROM chat_sessions WHERE id = ?', [created.lastInsertRowid]);
  } catch (e) {
    // 동시 진입 — 인덱스가 막아준 것이라 이미 있는 쪽을 쓴다.
    const again = await find().catch(() => null);
    if (again) return again;
    throw e;
  }
}

// ── 링크 만들기(관리자) ─────────────────────────────────────────────────────
// 콜마너 앱이 고쳐지기 전에도 파일럿을 돌리기 위한 자리다. 여기서 뽑은 링크를 기사에게 문자나
// 카톡으로 보내면 그대로 동작한다 — 앱 수정이 하는 일은 "이 링크를 기사에게 전달하는 방법"
// 하나뿐이고, 그 앞뒤는 전부 우리 것이다.
//
// 이 라우터는 requireAuth 앞에 마운트돼 있어(로그인 없는 기사 화면 때문에) 여기서 직접
// 관리자인지 본다. 안 그러면 누구나 아무 사번의 링크를 만들어 남의 오더를 열 수 있다.
function requireAdmin(req, res, next) {
  const u = req.session && req.session.user;
  if (u && (u.role === 'admin' || u.role === 'branch_manager')) return next();

  // 로그인 자체를 안 한 경우와 역할이 모자란 경우를 가른다.
  //
  // 예전에는 둘 다 "권한이 없습니다"였다. 이 라우터는 requireAuth 앞에 마운트돼 있어서
  // (로그인 없는 기사 화면 때문에) 로그인 리다이렉트가 자동으로 걸리지 않는데, 그러면
  // 로그아웃 상태로 주소를 연 관리자에게는 **막다른 길**이 된다 — 로그인하라는 말도 없고
  // 로그인 화면으로 가지도 않는다. 실제로 그렇게 막혔다.
  //
  // originalUrl이 아니라 path를 쓴다. Vercel은 모든 요청을 /api/index로 rewrite하면서
  // ?path=... 를 붙이는데, originalUrl에는 그게 그대로 남는다 — 실측으로 복귀 주소가
  // /driver/link?path=driver%2Flink 로 나왔다. 동작은 하지만 내부 라우팅이 사용자 주소에
  // 새어 나오고, 로그인을 두 번 거치면 계속 겹쳐 붙는다.
  if (!u) return res.redirect('/login?next=' + encodeURIComponent(req.baseUrl + req.path));

  return res.status(403).send(
    `이 화면은 관리자·지사장만 열 수 있습니다. 지금 로그인한 계정은 "${u.name || ''}"(${u.role})입니다.\n`
    + '기사 채팅 링크는 청구·배차 정보를 담고 있어 고객 계정에는 열지 않습니다.'
  );
}

router.get('/link', requireAdmin, asyncHandler(async (req, res) => {
  const rows = await db.all(
    `SELECT o.id, o.oid, o.status, o.callmaner_driver_sabun AS sabun, o.callmaner_driver_name AS driver_name,
            o.reserved_date, o.reserved_time, o.origin_address, o.destination_address
       FROM orders o
      WHERE o.callmaner_driver_sabun IS NOT NULL AND o.callmaner_driver_sabun <> ''
        AND o.status NOT IN ('완료', '취소')
      ORDER BY o.id DESC LIMIT 50`
  ).catch(() => []);

  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  // 링크 수명을 길게 준다. 문자로 보내고 기사가 나중에 여는 경로라, 앱이 그때그때 만드는
  // 1~5분짜리와는 쓰임이 다르다. 그래도 무한은 아니다 — 문자는 남는다.
  const ttl = Math.min(Math.max(Number(req.query.ttl) || 86400, 300), 604800);

  const items = driverToken.isConfigured() ? rows.map((r) => ({
    ...r,
    link: driverToken.entryUrl(base, { sabun: r.sabun, name: r.driver_name || '' }, ttl)
      .replace('/driver/chat?t=', '/driver/enter?t='),
  })) : [];

  res.render('driver/link', {
    layout: false,
    configured: driverToken.isConfigured(),
    items,
    ttlHours: Math.round(ttl / 3600),
  });
}));

// ── 진입 ────────────────────────────────────────────────────────────────────
// 토큰을 세션 쿠키로 바꾸고 주소에서 토큰을 지운다. 외부 브라우저로 열리므로 주소가 히스토리에
// 남는데, 거기 서명토큰이 붙어 있으면 지난 링크로 다시 들어올 수 있다.
router.get('/enter', asyncHandler(async (req, res) => {
  const result = driverToken.verify(req.query.t);
  if (!result.ok) {
    // 이유를 갈라 보여준다 — 만료는 "앱에서 다시 눌러주세요"이고 서명 불일치는 "잘못된 링크"다.
    // 같은 오류로 뭉치면 기사가 무엇을 할지 모른다.
    const message = result.reason === 'expired'
      ? '링크가 만료되었습니다. 콜마너 앱에서 다시 열어주세요.'
      : result.reason === 'not_configured'
        ? '기사 채팅이 아직 설정되지 않았습니다. 관리자에게 알려주세요.'
        : '잘못된 링크입니다. 콜마너 앱에서 다시 열어주세요.';
    return res.status(result.reason === 'expired' ? 410 : 401).send(message);
  }

  // 마이그레이션 전이면 drivers.callmaner_sabun이 없어 여기서 터진다. 기사에게 SQL 오류를
  // 보여줄 수는 없다 — 무엇을 해야 할지 알 수 없는 화면이 가장 나쁘다.
  const driver = await findOrCreateDriver(result.claims).catch((e) => {
    console.error('기사 확인 실패:', e.message);
    return null;
  });
  if (!driver) return res.status(503).send('기사 채팅을 준비 중입니다. 잠시 후 다시 열어주세요.');

  // 관리자 세션과 섞이지 않게 다른 칸에 둔다. requireAuth는 req.session.user만 보므로,
  // 기사가 이 쿠키로 관리자 화면에 들어가는 일은 생기지 않는다.
  req.session.driver = { id: driver.id, sabun: driver.callmaner_sabun, name: driver.name };

  // FCM 등록토큰이 함께 왔으면 저장한다 — 들어올 때마다 최신값이라 별도 동기화가 필요 없다.
  if (result.claims.fcmToken) {
    require('../lib/driverPush').rememberToken(driver.id, result.claims.fcmToken)
      .catch((e) => console.error('기사 푸시토큰 저장 실패(무시):', e.message));
  }

  // 딥링크로 특정 오더를 지목해 들어올 수 있다.
  const orderId = /^\d+$/.test(String(req.query.order || '')) ? Number(req.query.order) : null;
  res.redirect(orderId ? `/driver/chat?order=${orderId}` : '/driver/chat');
}));

// ── FCM 등록토큰 받기 ───────────────────────────────────────────────────────
// 앱이 **시작될 때** 부른다. 채팅 화면에 들어올 때만 받으면 순환에 빠진다 — 푸시를 보내려면
// 토큰이 있어야 하는데, 토큰은 들어와야 오고, 들어오는 계기가 푸시다.
//
// 세션 쿠키가 아니라 서명토큰으로 인증한다. 앱이 시작될 때는 우리 화면을 연 적이 없어
// 쿠키가 없다. 진입과 같은 토큰을 쓰면 앱이 만들 것이 하나뿐이다.
router.post('/push-token', asyncHandler(async (req, res) => {
  const result = driverToken.verify(req.body && req.body.t);
  if (!result.ok) return res.status(401).json({ ok: false, reason: result.reason });

  const token = String((req.body && req.body.fcmToken) || '').trim();
  // 길이만 본다. 형식은 FCM이 바꿀 수 있고, 우리가 형식을 판정하면 그쪽이 바뀔 때 조용히 막힌다.
  if (token.length < 20 || token.length > 4096) return res.status(400).json({ ok: false, reason: 'bad_token' });

  const driver = await findOrCreateDriver(result.claims).catch((e) => {
    console.error('기사 확인 실패(푸시토큰):', e.message);
    return null;
  });
  if (!driver) return res.status(503).json({ ok: false, reason: 'not_ready' });

  await require('../lib/driverPush').rememberToken(driver.id, token);
  res.json({ ok: true });
}));

function requireDriver(req, res, next) {
  if (req.session && req.session.driver && req.session.driver.id) return next();
  const wantsJson = (req.get('accept') || '').includes('application/json')
    || req.get('X-Requested-With') === 'fetch';
  if (wantsJson) return res.status(401).json({ error: '세션이 만료되었습니다. 콜마너 앱에서 다시 열어주세요.' });
  return res.status(401).send('세션이 만료되었습니다. 콜마너 앱에서 다시 열어주세요.');
}

// ── 화면 ────────────────────────────────────────────────────────────────────
// 껍데기만 내려주고 내용은 아래 data.json으로 채운다. EJS로 통째로 그리지 않는 이유는
// 대화가 계속 붙고 상담원 답장을 다시 읽어와야 해서다 — 매번 페이지를 다시 받으면
// 입력 중이던 글이 날아간다.
router.get('/chat', requireDriver, (req, res) => {
  res.render('driver/chat', { layout: false });
});

// ── 화면이 쓰는 데이터 ───────────────────────────────────────────────────────
// 오더 목록 + 선택한 오더의 대화. 한 번에 주는 이유는 기사 화면이 목록과 대화를 같이 그리기
// 때문이다 — 왕복이 늘면 지하주차장에서 그만큼 더 기다린다.
router.get('/chat/data.json', requireDriver, asyncHandler(async (req, res) => {
  const driver = req.session.driver;
  const orders = await loadDriverOrders(driver.sabun);

  const wanted = /^\d+$/.test(String(req.query.order || '')) ? Number(req.query.order) : null;
  // 지목한 오더가 이 기사 것이 아니면 무시한다 — 주소창으로 남의 오더를 여는 길을 막는다.
  const current = orders.find((o) => o.id === wanted) || orders[0] || null;

  let messages = [];
  let session = null;
  let extras = [];
  if (current) {
    session = await findOrCreateSession(current.id, driver);
    messages = await db.all(
      `SELECT id, sender, message, attachments_json, created_at
         FROM chat_messages WHERE session_id = ? ORDER BY id ASC LIMIT 200`,
      [session.id]
    ).catch(() => []);
    // 이 오더에서 기사가 해야 할 일 — 접수 때 정해진 부대비용과, 요청사항에서 채택된 것.
    extras = await buildDriverTasks(current);
  }

  res.json({
    driver: { name: driver.name, sabun: driver.sabun },
    orders: orders.map((o) => ({
      id: o.id, oid: o.oid, status: o.status,
      // 콜마너 접수번호를 함께 준다 — 기사가 콜마너 화면에서 찾는 번호는 이쪽이다.
      // 우리 번호만 주면 "그런 건 없다"가 된다.
      confSlip: o.callmaner_conf_slip || '',
      reservedAt: [o.reserved_date, o.reserved_time].filter(Boolean).join(' '),
      origin: [o.origin_address, o.origin_address_detail].filter(Boolean).join(' '),
      destination: [o.destination_address, o.destination_address_detail].filter(Boolean).join(' '),
      vehicle: [o.vehicle_type, o.vehicle_number].filter(Boolean).join(' '),
      current: !!current && o.id === current.id,
    })),
    current: current ? {
      id: current.id, oid: current.oid, status: current.status,
      confSlip: current.callmaner_conf_slip || '',
      // 발주 지사. 전화번호는 내려보내지 않는다(사용자 확정 2026-09-04) — 화면에서 전화
      // 버튼을 뺐고, 안 쓰는 연락처를 계속 실어 보낼 이유가 없다.
      branchName: current.branch_name || '',
      memo: current.memo_customer || '',
      // 상담원이 기사에게 직접 쓴 안내. 길이 제한이 없다.
      driverMemo: current.memo_driver_chat || '',
      originContact: current.origin_contact || '',
      destinationContact: current.destination_contact || '',
      tasks: extras,
    } : null,
    sessionId: session ? session.id : null,
    messages: messages.map((m) => ({
      id: m.id,
      // 기사 화면에서 'user'는 기사 자신이다. 상담원·봇은 상대편이다.
      mine: m.sender === 'user',
      sender: m.sender,
      text: m.message || '',
      attachments: safeJson(m.attachments_json),
      at: m.created_at,
    })),
  });
}));

function safeJson(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

// 기사가 해야 할 일. 청구 여부와 무관하게 **전달은 한다** — 지시가 안 닿으면 차가 빈 채로 간다.
// 청구 대상인 것에만 "영수증 필요"를 붙인다.
async function buildDriverTasks(order) {
  const rows = await extraCharges.loadIntakeRows(order.id).catch(() => []);
  // loadIntakeRows는 camelCase로 돌려준다(chargeType/optionCode/settleMode) — snake_case로
  // 읽으면 전부 undefined가 되어 이름 없는 빈 줄이 기사 화면에 뜬다.
  const tasks = rows.map((r) => {
    const item = extraCharges.intakeItem(r.chargeType);
    const option = item && (item.options || []).find((o) => o.value === r.optionCode);
    return {
      // 영수증을 어느 줄에 붙일지 — 화면이 이 id로 올린다. orders 컬럼 항목(도선료·대기요금)은
      // 테이블 줄이 아니라 id가 없다. 그런 줄에는 업로드 버튼을 그리지 않는다.
      chargeId: r.id || null,
      chargeType: r.chargeType,
      label: item ? item.label : r.chargeType,
      option: option ? option.label : null,
      amount: Number(r.amount) || 0,
      // 'included'는 요금에 포함이라 청구하지 않는다. 그래도 기사는 해야 한다.
      needsReceipt: r.settleMode !== 'included',
      hasReceipt: !!r.hasReceipt,
    };
  });
  // 요청사항에서 찾았지만 아직 관리자가 판단하지 않은 것은 보내지 않는다 — 확정되지 않은
  // 지시를 기사에게 흘리면, 채택되지 않았을 때 기사가 헛돈을 쓴다.
  const included = memoExtraCosts.loadFromOrder(order)
    .filter((c) => c.decision === 'accepted' && !c.billable);
  included.forEach((c) => {
    if (tasks.some((t) => t.chargeType === c.chargeType)) return;
    tasks.push({ chargeType: c.chargeType, label: c.label, option: null, amount: 0, needsReceipt: false });
  });

  // 인수증 등기 발송. 부대비용이 아니라 별도 흐름이라(order_receipts) 위 줄들과 섞이지 않는다.
  //
  // 여기 넣는 이유는 적요1이 잘리기 때문이다. 지금까지 이 안내가 닿는 길은 콜마너 적요1에 실린
  // /r/<token> 링크 하나뿐이었는데, 적요1은 100Byte라 차량번호·요청사항과 자리를 다툰다.
  // 잘리면 기사는 인수증을 어디에 올려야 하는지 알 방법이 없고, 고객은 등기를 못 받는다.
  //
  // 업로드는 기존 화면(/r/:token)을 그대로 쓴다 — 등기번호까지 함께 받아야 해서 이 화면의
  // 사진 한 장 올리기와 모양이 다르다. 두 벌로 만들면 한쪽만 고쳐진다.
  if (order.postal_requested && order.receipt_upload_token) {
    const done = await db.get(
      'SELECT COUNT(*)::int AS n FROM order_receipts WHERE order_id = ?', [order.id]
    ).catch(() => null);
    tasks.push({
      chargeType: 'postal_receipt',
      label: '인수증 등기 발송',
      option: '고객 서명 받아 출발지 주소로',
      amount: 0,
      needsReceipt: true,
      hasReceipt: !!(done && Number(done.n) > 0),
      // 이 링크가 있으면 화면이 업로드 버튼 대신 링크 버튼을 그린다.
      uploadUrl: postalReceipt.receiptUploadUrl(order.receipt_upload_token),
    });
  }
  return tasks;
}

// ── 메시지 보내기 ────────────────────────────────────────────────────────────
router.post('/chat/message', requireDriver, asyncHandler(async (req, res) => {
  const driver = req.session.driver;
  const orderId = Number(req.body.orderId);
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: '내용을 입력해주세요.' });
  if (text.length > 2000) return res.status(400).json({ error: '내용이 너무 깁니다.' });

  // 이 기사 오더가 맞는지 다시 본다 — 화면이 보낸 값을 그대로 믿으면 남의 오더에 글을 남길 수 있다.
  const order = await db.get(
    "SELECT id, oid FROM orders WHERE id = ? AND callmaner_driver_sabun = ? AND status NOT IN ('완료','취소')",
    [orderId, driver.sabun]
  ).catch(() => null);
  if (!order) return res.status(403).json({ error: '이 오더에는 메시지를 보낼 수 없습니다.' });

  const session = await findOrCreateSession(order.id, driver);
  const inserted = await db.run(
    "INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'user', ?) RETURNING id",
    [session.id, text]
  );
  await db.run(
    `UPDATE chat_sessions SET updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
     WHERE id = ?`,
    [session.id]
  ).catch(() => {});

  res.json({ ok: true, id: inserted.lastInsertRowid });
}));

// ── 영수증 업로드 ───────────────────────────────────────────────────────────
// 로그인 없이 토큰으로 들어온 화면이 올리는 파일이라 이미지로만 제한한다 — 제한이 없으면
// 어떤 파일이든 올려 공개 URL로 호스팅될 수 있다(routes/photoUpload.js와 같은 이유).
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const receiptUpload = multer({
  storage: multer.memoryStorage(),
  // 폰 사진은 3~8MB다. Vercel 본문 상한이 4.5MB라 그보다 크면 함수에 닿기 전에 막힌다 —
  // 화면에서 미리 줄여 보낸다(canvas 리사이즈). 여기 상한은 그걸 통과한 것만 받는 안전선이다.
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) return cb(new Error('이미지 파일만 올릴 수 있습니다.'));
    cb(null, true);
  },
});

// 금액이 어긋나면 상담원에게 알린다. 기사도 고객도 이 어긋남을 해결할 수 없다 —
// 고객이 정한 금액과 실제 쓴 돈이 다른 건 사람이 판단해 정리할 일이다.
async function notifyAmountMismatch(order, charge, decision, ocr) {
  const won = (n) => Number(n || 0).toLocaleString('ko-KR') + '원';
  const body = [
    `${order.oid} · ${order.vehicle_number || '차량번호 없음'}`,
    `${charge.charge_type} — 고객 요청 ${won(decision.expected)} / 영수증 ${won(decision.amount)}`,
    ocr && ocr.merchant ? `(${ocr.merchant})` : null,
  ].filter(Boolean).join('\n');

  await notify({
    branchId: order.branch_id,
    eventType: 'agent_call',
    title: '⚠️ 영수증 금액이 요청과 다릅니다',
    body,
    url: `/orders/${order.id}`,
  }).catch((e) => console.error('영수증 불일치 알림 실패(무시):', e.message));

  // 푸시를 못 받는 상담원도 있고, 나중에 되짚어야 할 때도 있다 — 기록을 함께 남긴다.
  logIntegrationErrorAsync({
    source: 'receipt', operation: 'amount_mismatch',
    refType: 'order', refId: Number(order.id),
    message: `${charge.charge_type} 요청 ${decision.expected} / 영수증 ${decision.amount}`,
    context: {
      oid: order.oid, vehicle: order.vehicle_number || null,
      chargeType: charge.charge_type, expected: decision.expected,
      receipt: decision.amount, gap: decision.gap,
      merchant: (ocr && ocr.merchant) || null,
    },
  });
}

// multer가 거부한 것(형식·크기)을 JSON으로 돌려준다.
//
// 그냥 두면 전역 오류 처리기로 흘러가 HTML 500이 나가고, 기사 화면은 그걸 JSON으로 읽으려다
// "올리지 못했습니다"조차 못 띄운다 — 기사는 무엇이 잘못됐는지 알 수 없다.
function receiptFile(req, res, next) {
  receiptUpload.single('photo')(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(400).json({
      error: tooBig ? '사진이 너무 큽니다. 다시 찍어 올려주세요.' : (err.message || '사진을 올릴 수 없습니다.'),
    });
  });
}

router.post('/chat/receipt', requireDriver, receiptFile, asyncHandler(async (req, res) => {
  const driver = req.session.driver;
  const chargeId = Number(req.body.chargeId);
  if (!req.file) return res.status(400).json({ error: '사진을 선택해주세요.' });

  // 이 기사 오더의 실비 줄이 맞는지 확인한다 — 화면이 보낸 id를 그대로 믿으면 남의 오더에
  // 영수증을 붙이고 남의 청구액을 바꿀 수 있다.
  const charge = await db.get(
    `SELECT e.*, o.id AS order_id, o.oid, o.branch_id, o.vehicle_number
       FROM order_extra_charges e
       JOIN orders o ON o.id = e.order_id
      WHERE e.id = ? AND o.callmaner_driver_sabun = ? AND o.status NOT IN ('완료','취소')`,
    [chargeId, driver.sabun]
  ).catch(() => null);
  if (!charge) return res.status(403).json({ error: '이 항목에는 영수증을 올릴 수 없습니다.' });

  await ensureBucket().catch(() => {});
  const ext = (String(req.file.originalname || '').match(/\.[a-zA-Z0-9]+$/) || ['.jpg'])[0].slice(0, 10);
  const url = await uploadPhoto(charge.order_id, `receipt-${chargeId}-${Date.now()}${ext}`, req.file.buffer, req.file.mimetype);

  // 대화에 남긴다 — 상담원이 같은 자리에서 보고, 나중에 "이 금액의 근거"를 되짚을 수 있다.
  const session = await findOrCreateSession(charge.order_id, driver);
  const msg = await db.run(
    `INSERT INTO chat_messages (session_id, sender, message, attachments_json)
     VALUES (?, 'user', ?, ?) RETURNING id`,
    [session.id, `${charge.charge_type} 영수증을 올렸습니다.`, JSON.stringify([{ url }])]
  );
  await db.run('UPDATE order_extra_charges SET chat_message_id = ? WHERE id = ?', [msg.lastInsertRowid, chargeId])
    .catch((e) => console.error('영수증 연결 실패(사진은 저장됨):', e.message));

  // 판독은 응답 뒤로 미룬다 — 기사는 사진을 올리고 바로 다음 일을 해야 한다.
  // 실패해도 사진은 이미 붙어 있어 상담원이 눈으로 보고 넣을 수 있다.
  const ocr = await receiptOcr.readReceipt(url).catch(() => null);
  const decision = receiptOcr.decide(charge, ocr);

  if (decision.action === 'apply' || decision.action === 'match') {
    await db.run('UPDATE order_extra_charges SET amount = ? WHERE id = ?', [decision.amount, chargeId])
      .catch((e) => console.error('영수증 금액 저장 실패:', e.message));
  } else if (decision.action === 'mismatch') {
    // 넣지 않는다. 고객이 동의한 적 없는 금액을 자동으로 청구할 수는 없다.
    await notifyAmountMismatch(charge, charge, decision, ocr);
  }

  res.json({
    ok: true, url,
    action: decision.action,
    amount: decision.amount,
    // 기사에게는 결과를 짧게만 알린다. 금액 다툼은 상담원과 고객 사이의 일이다.
    message: decision.action === 'mismatch'
      ? '영수증을 받았습니다. 금액을 담당자가 확인합니다.'
      : decision.action === 'manual'
        ? '영수증을 받았습니다. 금액은 담당자가 확인합니다.'
        : `영수증을 받았습니다. ${Number(decision.amount).toLocaleString('ko-KR')}원으로 등록했습니다.`,
  });
}));

module.exports = { router, requireDriver, notifyAmountMismatch, findOrCreateDriver, findOrCreateSession, buildDriverTasks, DRIVER_ORDER_SQL };
