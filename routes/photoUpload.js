const express = require('express');
const multer = require('multer');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { ensureBucket, uploadPhoto } = require('../lib/storage');

const router = express.Router();
// 로그인 없이 누구나 토큰 링크로 접근하는 업로드라, 파일 형식을 이미지로만 제한해야 한다 —
// 원래 제한이 없어서 어떤 파일이든(실행파일, HTML 등) 올려 공개 URL로 호스팅될 수 있었다.
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) return cb(new Error('이미지 파일만 업로드할 수 있습니다.'));
    cb(null, true);
  },
});

// 계기판 주행거리. 기사가 손으로 적는 값이라 "123,456"이나 "123456km"처럼 들어온다.
// 범위를 벗어난 값(오타로 자릿수가 하나 더 붙는 경우)은 저장하지 않는다 — 잘못된 숫자가 남으면
// 고객에게 그대로 안내되고, 그건 값이 없는 것보다 나쁘다.
const MAX_ODOMETER_KM = 2000000;

function parseOdometer(raw) {
  const digits = String(raw == null ? '' : raw).replace(/[^0-9]/g, '');
  if (!digits) return null;
  const km = Number(digits);
  if (!Number.isInteger(km) || km <= 0 || km > MAX_ODOMETER_KM) return null;
  return km;
}

// 원본 파일명(사용자 입력)을 스토리지 경로에 그대로 쓰지 않는다 — 경로 조작 문자를 제거하고
// 확장자만 남긴 안전한 이름으로 바꾼다.
function safeFilename(originalname) {
  const ext = (String(originalname || '').match(/\.[a-zA-Z0-9]+$/) || [''])[0].slice(0, 10);
  return 'photo' + ext;
}

router.get('/:token/data.json', asyncHandler(async (req, res) => {
  const order = await db.get('SELECT id, oid, branch_id, photo_upload_token FROM orders WHERE photo_upload_token = ?', [req.params.token]);
  if (!order) return res.status(404).json({ order: null, guide: null, photos: [] });
  const [guide, photos] = await Promise.all([
    db.get('SELECT guide_text, guide_image_url FROM branch_photo_settings WHERE branch_id = ?', [order.branch_id]),
    db.all('SELECT id, url, odometer_km FROM order_photos WHERE order_id = ? ORDER BY id DESC', [order.id])
      // 마이그레이션(20260809030000) 적용 전이면 컬럼이 없다 — 화면은 주행거리 없이 그대로 뜬다.
      .catch(() => db.all('SELECT id, url FROM order_photos WHERE order_id = ? ORDER BY id DESC', [order.id])),
  ]);
  res.json({ order, guide: guide || null, photos });
}));

router.get('/:token', asyncHandler(async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE photo_upload_token = ?', [req.params.token]);
  if (!order) return res.status(404).render('photo_upload', { title: '잘못된 링크', order: null, guide: null, photos: [] });
  // guide/photos는 서로 독립적이지만 둘 다 order의 값이 있어야 조회할 수 있어 order 다음에 묶어서 병렬 실행한다.
  const [guide, photos] = await Promise.all([
    db.get('SELECT * FROM branch_photo_settings WHERE branch_id = ?', [order.branch_id]),
    db.all('SELECT * FROM order_photos WHERE order_id = ? ORDER BY id DESC', [order.id]),
  ]);
  res.render('photo_upload', { title: '기사 사진 업로드 - ' + order.oid, order, guide, photos });
}));

router.post('/:token', (req, res, next) => {
  upload.single('photo')(req, res, (err) => {
    if (err) return res.status(400).send(err.message || '업로드에 실패했습니다.');
    next();
  });
}, asyncHandler(async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE photo_upload_token = ?', [req.params.token]);
  if (!order) return res.status(404).send('잘못된 링크입니다.');
  if (req.file) {
    await ensureBucket();
    const url = await uploadPhoto(order.id, safeFilename(req.file.originalname), req.file.buffer, req.file.mimetype);
    // 계기판 사진일 때만 적는 값이라 비어 있는 게 정상이다. 숫자가 아니면 조용히 버린다 —
    // 여기서 막아 세우면 사진 자체가 안 올라간다. 사진이 우선이다.
    const odometer = parseOdometer(req.body && req.body.odometer_km);
    await db.run(
      'INSERT INTO order_photos (order_id, url, odometer_km) VALUES (?, ?, ?)',
      [order.id, url, odometer]
    ).catch(async (e) => {
      // 마이그레이션(20260809030000) 적용 전이면 컬럼이 없다 — 주행거리 때문에 사진 업로드가
      // 막히면 안 되므로 컬럼 없는 형태로 한 번 더 시도한다.
      if (!e || e.code !== '42703') throw e;
      await db.run('INSERT INTO order_photos (order_id, url) VALUES (?, ?)', [order.id, url]);
    });
  }
  res.redirect('/upload/' + req.params.token);
}));

module.exports = router;
