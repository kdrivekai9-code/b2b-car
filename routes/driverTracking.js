// 기사 위치 추적 — 로그인 없이 토큰으로 연다(/track/:token).
//
// 고객이 카카오 상담톡에서 받는 링크다. 카카오 평문에 좌표를 적어줄 수는 없고, 로그인을
// 요구하면 대부분 열지 않는다 — 사진 모아보기(/photos/:token)와 같은 이유·같은 방식이다.
//
// 사진 링크와 토큰을 따로 쓰는 이유는 수명이 정반대이기 때문이다: 사진은 운행이 끝난 뒤 오래
// 살아야 하고, 이 페이지는 **운행 중에만** 의미가 있다(완료되면 위치를 더는 수집하지 않는다).
const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const driverLocation = require('../lib/driverLocation');

const router = express.Router();

// 토큰은 추측할 수 없는 값이어야 한다(gen_random_uuid). 형태가 다르면 조회조차 하지 않는다.
function looksLikeToken(raw) {
  return typeof raw === 'string' && /^[0-9a-f-]{16,64}$/i.test(raw);
}

async function findOrder(token) {
  if (!looksLikeToken(token)) return null;
  return db.get('SELECT * FROM orders WHERE tracking_token = ?', [token]).catch((e) => {
    // 마이그레이션 전이면 컬럼이 없다 — 링크를 준 적도 없으므로 없는 링크로 취급한다.
    if (e && e.code === '42703') return null;
    throw e;
  });
}

// 지도를 그린 뒤 화면이 30초마다 이 주소로 위치만 다시 받아간다. 페이지를 통째로 새로고침하면
// 지도가 매번 처음 위치로 돌아가 따라가기가 안 된다.
router.get('/:token/location.json', asyncHandler(async (req, res) => {
  const order = await findOrder(req.params.token);
  if (!order) return res.status(404).json({ available: false, reason: 'not_found' });
  const loc = await driverLocation.loadForOrder(order);
  res.json({
    ...loc,
    origin: { lat: order.origin_lat, lon: order.origin_lon, address: order.origin_address },
    destination: { lat: order.destination_lat, lon: order.destination_lon, address: order.destination_address },
  });
}));

router.get('/:token', asyncHandler(async (req, res) => {
  const order = await findOrder(req.params.token);
  if (!order) {
    return res.status(404).render('driver_track', {
      title: '잘못된 링크', order: null, location: null, kakaoJsKey: '', token: req.params.token,
    });
  }
  const location = await driverLocation.loadForOrder(order);
  res.render('driver_track', {
    title: '기사 위치 - ' + order.oid,
    order,
    location,
    kakaoJsKey: process.env.KAKAO_JS_KEY || '',
    token: req.params.token,
  });
}));

module.exports = router;
