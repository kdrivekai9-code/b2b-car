// 고객용 사진 모아보기 — 로그인 없이 토큰으로 연다(/photos/:token).
//
// 카카오톡 본문에 링크 13줄을 나열하는 대신 이 페이지 하나로 모은다. 카카오 평문은 앵커
// 텍스트를 지원하지 않아 "1, 2, 3…" 글자에 링크를 걸 수 없다 — 그래서 페이지로 뺐다.
//
// 열람 권한은 화면·챗봇과 같은 지사 설정을 그대로 쓴다(branch_photo_settings.client_can_view).
// 그 설정이 꺼져 있으면 링크를 알아도 볼 수 없다 — 관리 화면에서 막아둔 것이 링크 하나로
// 뚫리면 그 설정이 의미가 없다.
const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const callmanerPhotos = require('../lib/callmanerPhotos');

const router = express.Router();

// 토큰은 추측할 수 없는 값이어야 한다(gen_random_uuid). 형태가 다르면 조회조차 하지 않는다.
function looksLikeToken(raw) {
  return typeof raw === 'string' && /^[0-9a-f-]{16,64}$/i.test(raw);
}

router.get('/:token', asyncHandler(async (req, res) => {
  const token = req.params.token;
  const notFound = () => res.status(404).render('photo_view', {
    title: '잘못된 링크', order: null, groups: [], odometerIndex: null, reason: 'not_found',
  });

  if (!looksLikeToken(token)) return notFound();

  const order = await db.get('SELECT * FROM orders WHERE photo_view_token = ?', [token])
    .catch((e) => {
      // 마이그레이션 전이면 컬럼이 없다 — 링크를 준 적도 없으므로 없는 링크로 취급한다.
      if (e && e.code === '42703') return null;
      throw e;
    });
  if (!order) return notFound();

  const [settings, branch, photos] = await Promise.all([
    db.get('SELECT client_can_view FROM branch_photo_settings WHERE branch_id = ?', [order.branch_id]).catch(() => null),
    db.get('SELECT * FROM branches WHERE id = ?', [order.branch_id]).catch(() => null),
    callmanerPhotos.loadPhotos(order.id),
  ]);

  if (!settings || !settings.client_can_view) {
    return res.status(403).render('photo_view', {
      title: '사진을 볼 수 없습니다', order, groups: [], odometerIndex: null, reason: 'not_allowed',
    });
  }

  // 계기판이 몇 번째인지는 지사 설정을 따른다 — 그 번호에만 표시를 붙인다.
  const odometerIndex = callmanerPhotos.odometerPhotoIndex(branch);
  const groups = [
    { phase: callmanerPhotos.PHASE_START, label: '운행 전', items: photos.filter((p) => p.phase === callmanerPhotos.PHASE_START) },
    { phase: callmanerPhotos.PHASE_END, label: '운행 후', items: photos.filter((p) => p.phase === callmanerPhotos.PHASE_END) },
  ].filter((g) => g.items.length);

  res.render('photo_view', {
    title: `탁송 사진 - ${order.oid}`,
    order,
    groups,
    odometerIndex,
    reason: groups.length ? null : 'no_photos',
  });
}));

module.exports = router;
