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
    db.all('SELECT id, url FROM order_photos WHERE order_id = ? ORDER BY id DESC', [order.id]),
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
    await db.run('INSERT INTO order_photos (order_id, url) VALUES (?, ?)', [order.id, url]);
  }
  res.redirect('/upload/' + req.params.token);
}));

module.exports = router;
