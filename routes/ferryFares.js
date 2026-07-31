// 도선료(페리 차량 선적비용) 관리자 CRUD — 지사 요금표(branches/fare-rules)와 같은 방식으로
// 전체 행을 한 번에 교체 저장한다. 지사에 속하지 않는 전역 데이터라 별도 라우트로 둔다.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get('/', asyncHandler(async (req, res) => {
  const rules = await db.all('SELECT * FROM ferry_fare_rules ORDER BY route_code, ship_name, sort_order, id');
  res.render('ferry_fares/list', {
    title: '도선료 관리',
    rules,
    saved: req.query.saved === '1',
  });
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = (v) => [].concat(v || []);
  const routeCode = b(req.body.route_code);
  const shipName = b(req.body.ship_name);
  const vehicleLabel = b(req.body.vehicle_label);
  const weekdayFare = b(req.body.weekday_fare);
  const holidayFare = b(req.body.holiday_fare);
  const sortOrder = b(req.body.sort_order);
  const sourceTitle = b(req.body.source_title);
  const sourceUrl = b(req.body.source_url);
  const isActive = b(req.body.is_active); // 체크된 행의 인덱스만 전송됨

  const activeByRow = Array.from({ length: routeCode.length }, () => 0);
  isActive.forEach((v) => {
    const idx = Number(v);
    if (Number.isInteger(idx) && idx >= 0 && idx < activeByRow.length) activeByRow[idx] = 1;
  });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM ferry_fare_rules');
    for (let i = 0; i < routeCode.length; i++) {
      if (!String(routeCode[i] || '').trim() || !String(vehicleLabel[i] || '').trim()) continue;
      await client.query(
        `INSERT INTO ferry_fare_rules
          (route_code, ship_name, vehicle_label, weekday_fare, holiday_fare, source_title, source_url, sort_order, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          String(routeCode[i]).trim(),
          String(shipName[i] || '').trim(),
          String(vehicleLabel[i]).trim(),
          Number(weekdayFare[i]) || 0,
          Number(holidayFare[i]) || 0,
          sourceTitle[i] || null,
          sourceUrl[i] || null,
          Number(sortOrder[i]) || i + 1,
          activeByRow[i],
        ]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  res.redirect('/ferry-fares?saved=1');
}));

module.exports = router;
