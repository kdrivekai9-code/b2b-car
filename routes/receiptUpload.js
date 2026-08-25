// 우편발송(등기) 인수증 업로드 — 기사가 기사메모의 링크로 들어와 등기번호와 인수증을 올린다.
//
// 콜마너로 배차된 기사는 우리 기사 앱을 쓰지 않는다. 그래서 접수 시 만든 토큰 링크를 콜마너
// 적요1(기사메모)에 실어 보내고(lib/callmaner.js memoWithVehicle), 기사는 로그인 없이 그
// 링크로 들어온다. 기사 사진 업로드(routes/photoUpload.js)와 같은 구조다.
//
// 경로가 `/r/:token`으로 짧은 이유: 이 주소가 100Byte짜리 적요1에 통째로 들어가야 한다
// (lib/postalReceipt.js 주석 참고).
const express = require('express');
const multer = require('multer');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { ensureBucket, uploadPhoto } = require('../lib/storage');
const { notifyReceiptUploaded } = require('../lib/kakaoOrderNotify');

const router = express.Router();

// 로그인 없이 누구나 토큰 링크로 접근하는 업로드라 이미지로만 제한한다 — 제한이 없으면 어떤
// 파일이든(실행파일, HTML 등) 올려 공개 URL로 호스팅될 수 있다(routes/photoUpload.js와 동일).
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) return cb(new Error('이미지 파일만 업로드할 수 있습니다.'));
    cb(null, true);
  },
});

function safeFilename(originalname) {
  const ext = (String(originalname || '').match(/\.[a-zA-Z0-9]+$/) || [''])[0].slice(0, 10);
  return 'receipt' + ext;
}

// 등기번호는 기사가 손으로 옮겨 적는 값이라 공백·하이픈이 섞여 온다. 숫자만 남기되 원문 길이가
// 터무니없으면(오타로 문장을 붙여넣은 경우) 받지 않는다.
function normalizeTrackingNo(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const digits = s.replace(/[^0-9]/g, '');
  if (digits.length < 9 || digits.length > 20) return null;
  return digits;
}

async function resolveOrder(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  try {
    return await db.get('SELECT * FROM orders WHERE receipt_upload_token = ?', [t]);
  } catch (e) {
    // 마이그레이션(20260825010000) 전이면 컬럼이 없다 — 링크만 동작하지 않을 뿐, 500을 내지 않는다.
    if (e && e.code === '42703') return null;
    throw e;
  }
}

async function loadReceipts(orderId) {
  return db.all('SELECT id, tracking_no, url, created_at FROM order_receipts WHERE order_id = ? ORDER BY id', [orderId])
    .catch(() => []);
}

function renderPage(res, order, receipts, message, error) {
  res.render('receipt_upload', {
    title: order ? `영수증 업로드 - ${order.oid}` : '잘못된 링크',
    order: order || null,
    receipts: receipts || [],
    message: message || null,
    error: error || null,
  });
}

router.get('/:token', asyncHandler(async (req, res) => {
  const order = await resolveOrder(req.params.token);
  if (!order) return res.status(404).render('receipt_upload', { title: '잘못된 링크', order: null, receipts: [], message: null, error: null });
  renderPage(res, order, await loadReceipts(order.id), req.query.saved ? '등록되었습니다.' : null, req.query.error || null);
}));

router.post('/:token', (req, res, next) => {
  upload.single('receipt')(req, res, (err) => {
    if (err) return res.redirect('/r/' + encodeURIComponent(req.params.token) + '?error=' + encodeURIComponent(err.message));
    next();
  });
}, asyncHandler(async (req, res) => {
  const order = await resolveOrder(req.params.token);
  const back = '/r/' + encodeURIComponent(req.params.token);
  if (!order) return res.status(404).send('잘못된 링크입니다.');

  const trackingNo = normalizeTrackingNo(req.body.tracking_no);
  // 등기번호도 사진도 없으면 저장할 것이 없다 — 빈 행을 만들면 고객 통보만 헛나간다.
  if (!trackingNo && !req.file) {
    return res.redirect(back + '?error=' + encodeURIComponent('등기번호나 인수증 사진 중 하나는 입력해주세요.'));
  }
  if (req.body.tracking_no && !trackingNo) {
    return res.redirect(back + '?error=' + encodeURIComponent('등기번호를 다시 확인해주세요(숫자 9~20자리).'));
  }

  let url = null;
  if (req.file) {
    await ensureBucket();
    url = await uploadPhoto(`receipts/${order.id}/${Date.now()}-${safeFilename(req.file.originalname)}`, req.file.buffer, req.file.mimetype);
  }

  await db.run('INSERT INTO order_receipts (order_id, tracking_no, url) VALUES (?, ?, ?)', [order.id, trackingNo, url]);

  // 고객 통보는 응답 뒤로 넘긴다 — 기사 화면이 카카오 발신을 기다릴 이유가 없다.
  res.redirect(back + '?saved=1');
  notifyReceiptUploaded(order.id).catch((e) => console.error('영수증 업로드 통보 실패:', e.message));
}));

module.exports = router;
