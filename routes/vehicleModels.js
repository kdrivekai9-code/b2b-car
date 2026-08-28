// 차종 관리 — 수입차/대형·화물/전기차 할증의 판정 근거를 등록·수정한다.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const vehicleModels = require('../lib/vehicleModels');
const {
  classifyToFields, KEYWORD_KINDS,
  IMPORT_BRANDS, IMPORT_MODELS, DOMESTIC_BRANDS, EV_KEYWORDS, LARGE_KEYWORDS,
} = require('../lib/vehicleClass');

const KIND_LABELS = {
  import_brand: '수입 브랜드',
  import_model: '수입 모델명',
  ev: '전기차',
  large: '대형 · 화물',
  domestic: '국산(수입 판정 제외)',
};

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

  const addedKeywords = await db.all(
    'SELECT * FROM vehicle_class_keywords ORDER BY kind, word'
  ).catch(() => []);

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
    // 이미 자동 인식되는 이름을 등록하려 했을 때의 안내. 사전이 무엇을 어떻게 판정하는지
    // 보여주고, 그래도 등록할지(=사전을 바로잡으려는 것인지) 사람이 정하게 한다.
    dup: req.query.dup
      ? { name: req.query.dup, reason: req.query.dupReason || '', summary: req.query.dupSummary || '' }
      : null,
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
    // 운영자가 더한 낱말. 코드 사전과 따로 보여준다 — 지울 수 있는 것은 이것뿐이라
    // 섞어 놓으면 "왜 이건 삭제가 안 되지"가 된다.
    addedKeywords,
    keywordKinds: KEYWORD_KINDS.map((k) => ({ key: k, label: KIND_LABELS[k] })),
  });
}));

// 판정 낱말 추가. 코드 사전을 고치는 것이 아니라 **더하는** 것이다 — 배포 없이 빠진 브랜드를
// 채우기 위한 통로다(빠진 채로 두면 그 차종은 할증이 조용히 빠진다).
router.post('/keywords', asyncHandler(async (req, res) => {
  const kind = String(req.body.kind || '').trim();
  const word = String(req.body.word || '').trim();
  const back = '/vehicle-models';
  if (!KEYWORD_KINDS.includes(kind)) return res.redirect(back + '?error=' + encodeURIComponent('분류를 선택해주세요.'));
  if (!word) return res.redirect(back + '?error=' + encodeURIComponent('낱말을 입력해주세요.'));
  // 한 글자 낱말은 아무 이름에나 걸린다 — 국산차를 수입으로 만드는 사고가 난다.
  if (word.length < 2) return res.redirect(back + '?error=' + encodeURIComponent('낱말은 두 글자 이상이어야 합니다. 한 글자는 엉뚱한 차종에 걸립니다.'));

  try {
    await db.run(
      'INSERT INTO vehicle_class_keywords (kind, word, note, created_by) VALUES (?, ?, ?, ?)',
      [kind, word, String(req.body.note || '').trim() || null, req.session.user.id]
    );
  } catch (e) {
    if (e && e.code === '23505') return res.redirect(back + '?error=' + encodeURIComponent('이미 등록된 낱말입니다.'));
    if (e && e.code === '42P01') return res.redirect(back + '?error=' + encodeURIComponent('낱말 표가 아직 없습니다. 마이그레이션(20260828030000)을 실행해주세요.'));
    throw e;
  }
  vehicleModels.clearKeywordCache();
  res.redirect(back + '?saved=1');
}));

router.post('/keywords/:id/delete', asyncHandler(async (req, res) => {
  // 코드 사전의 낱말은 이 표에 없으므로 여기서 지울 수 없다 — 의도한 것이다(바닥은 배포로만 바뀐다).
  await db.run('DELETE FROM vehicle_class_keywords WHERE id = ?', [req.params.id]).catch(() => {});
  vehicleModels.clearKeywordCache();
  res.redirect('/vehicle-models?saved=1');
}));

router.post('/', asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.redirect('/vehicle-models?error=' + encodeURIComponent('차종명을 입력해주세요.'));

  // 이미 자동 인식되는 이름이면 기본적으로 막고 안내한다.
  //
  // 왜 막나: 사전이 이미 같은 결과를 내는 이름을 등록하면 하는 일이 없다. 목록만 길어지고,
  // 나중에 사전을 고쳐도 이 행이 덮어써서 왜 안 바뀌는지 알기 어려워진다.
  //
  // 왜 완전히 막지는 않나: 이 화면의 본래 목적이 **사전이 틀렸을 때 바로잡는 것**이다.
  // 예를 들어 "쉐보레 볼트EV"는 사전이 국산으로 판정하는데, 수입으로 받고 싶으면 등록해서
  // 고치는 수밖에 없다. 사전에 걸린다는 이유로 무조건 막으면 그 길이 사라진다.
  // 그래서 판정 결과를 보여주고, 그래도 등록하겠다면 진행한다.
  const auto = classifyToFields(name, await vehicleModels.loadExtraKeywords());
  if (!auto.unclassified && req.body.force !== '1') {
    const params = new URLSearchParams({
      dup: name,
      dupReason: auto.reasons.join(', '),
      dupSummary: `${auto.carType}${auto.fuelType === 'ev' ? ' · EV' : ''}`,
    });
    if (req.body.q) params.set('q', req.body.q);
    return res.redirect('/vehicle-models?' + params.toString());
  }

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
