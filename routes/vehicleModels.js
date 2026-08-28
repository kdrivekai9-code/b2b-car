// 차종 관리 — 수입차/대형·화물/전기차 할증의 판정 근거를 등록·수정한다.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const vehicleModels = require('../lib/vehicleModels');
const {
  classifyToFields,
  IMPORT_BRANDS, IMPORT_MODELS, DOMESTIC_BRANDS, EV_KEYWORDS, LARGE_KEYWORDS,
} = require('../lib/vehicleClass');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'branch_manager'));

const PAGE_SIZE = 200;

router.get('/', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const rows = await db.all(
    q
      ? `SELECT * FROM vehicle_models WHERE name ILIKE ? ORDER BY name LIMIT ${PAGE_SIZE}`
      : `SELECT * FROM vehicle_models ORDER BY name LIMIT ${PAGE_SIZE}`,
    q ? [`%${q}%`] : []
  ).catch(() => null);

  res.render('vehicle_models/index', {
    title: '차종 관리',
    rows: rows || [],
    // 테이블이 없으면(마이그레이션 전) 화면이 빈 목록으로 뜨는 대신 이유를 밝힌다.
    migrationMissing: rows === null,
    q,
    saved: req.query.saved === '1',
    error: req.query.error || null,
    // 입력 중인 이름이 어떻게 판정될지 미리 보여준다 — 등록 전에 틀린 걸 알 수 있다.
    preview: req.query.preview ? classifyToFields(req.query.preview) : null,
    previewName: req.query.preview || '',
    // 코드에 박아둔 자동 판정 사전. 이걸 화면에 안 보여주면 관리자는 등록한 몇 건만 보고
    // "이것만 할증이 붙는다"고 읽는다(실사용 지적 2026-08-28) — 실제로는 등록이 없어도
    // 이 사전으로 판정해서 붙는다. 무엇이 이미 인식되는지 보여야 예외만 등록할 수 있다.
    dictionaries: [
      { key: 'import_brand', label: '수입 브랜드', words: IMPORT_BRANDS },
      { key: 'import_model', label: '수입 모델명(브랜드 없이 쓰는 이름)', words: IMPORT_MODELS },
      { key: 'ev', label: '전기차', words: EV_KEYWORDS },
      { key: 'large', label: '대형 · 화물', words: LARGE_KEYWORDS },
      // 국산 사전은 할증을 붙이는 목록이 아니라 수입 판정을 **막는** 목록이다(르노삼성 등).
      { key: 'domestic', label: '국산(수입 판정에서 제외)', words: DOMESTIC_BRANDS },
    ],
  });
}));

router.post('/', asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.redirect('/vehicle-models?error=' + encodeURIComponent('차종명을 입력해주세요.'));
  try {
    await vehicleModels.createModel(name);
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) {
      return res.redirect('/vehicle-models?error='
        + encodeURIComponent('마이그레이션(20260828010000)을 먼저 실행해주세요.'));
    }
    throw e;
  }
  res.redirect('/vehicle-models?saved=1' + (req.body.q ? '&q=' + encodeURIComponent(req.body.q) : ''));
}));

// 목록 전체를 한 번에 저장한다 — 자동 판정을 훑어보며 틀린 줄만 고치는 흐름이라
// 줄마다 저장 버튼을 누르게 하면 손이 너무 많이 간다.
router.post('/bulk', asyncHandler(async (req, res) => {
  const ids = [].concat(req.body.model_id || []);
  const imported = new Set([].concat(req.body.is_imported || []).map(String));
  const large = new Set([].concat(req.body.is_large || []).map(String));
  const ev = new Set([].concat(req.body.is_ev || []).map(String));
  for (const id of ids) {
    await vehicleModels.updateFlags(id, {
      isImported: imported.has(String(id)),
      isLarge: large.has(String(id)),
      isEv: ev.has(String(id)),
    });
  }
  res.redirect('/vehicle-models?saved=1' + (req.body.q ? '&q=' + encodeURIComponent(req.body.q) : ''));
}));

router.post('/:id/delete', asyncHandler(async (req, res) => {
  await db.run('DELETE FROM vehicle_models WHERE id = ?', [req.params.id]);
  res.redirect('/vehicle-models?saved=1');
}));

module.exports = router;
