const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ORDER_STATUSES } = require('../config');
const { getEffectivePaymentMethods, getEffectiveStatuses } = require('../lib/branchPolicy');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get('/', asyncHandler(async (req, res) => {
  const branches = await db.all('SELECT * FROM branches ORDER BY id');
  res.render('branches/list', { title: '지사 관리', branches });
}));

router.get('/new', asyncHandler(async (req, res) => {
  const branches = await db.all('SELECT id, name FROM branches ORDER BY id');
  res.render('branches/form', { title: '지사 등록', branch: {}, mode: 'create', branches });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, code, main_phone, address, contact_name, contact_phone } = req.body;
  await db.run(
    `INSERT INTO branches (name, code, main_phone, address, contact_name, contact_phone, status) VALUES (?, ?, ?, ?, ?, ?, 'active')`,
    [name, code, main_phone, address, contact_name, contact_phone]
  );
  res.redirect('/branches');
}));

router.get('/:id/edit', asyncHandler(async (req, res) => {
  const branch = await db.get('SELECT * FROM branches WHERE id = ?', [req.params.id]);
  if (!branch) return res.status(404).send('지사를 찾을 수 없습니다.');
  const branches = await db.all('SELECT id, name FROM branches ORDER BY id');
  const accountUsers = await db.all('SELECT * FROM users WHERE branch_id = ? ORDER BY id', [req.params.id]);
  res.render('branches/form', { title: '지사 수정', branch, mode: 'edit', branches, accountUsers });
}));

router.post('/:id', asyncHandler(async (req, res) => {
  const { name, code, main_phone, address, contact_name, contact_phone, status } = req.body;
  await db.run(
    `UPDATE branches SET name=?, code=?, main_phone=?, address=?, contact_name=?, contact_phone=?, status=? WHERE id=?`,
    [name, code, main_phone, address, contact_name, contact_phone, status, req.params.id]
  );
  res.redirect('/branches');
}));

router.post('/:id/toggle', asyncHandler(async (req, res) => {
  const branch = await db.get('SELECT * FROM branches WHERE id = ?', [req.params.id]);
  const next = branch.status === 'active' ? 'inactive' : 'active';
  await db.run('UPDATE branches SET status=? WHERE id=?', [next, req.params.id]);
  res.redirect('/branches');
}));

// ---------------- 결제방식 설정 ----------------
router.get('/:id/payment-methods', asyncHandler(async (req, res) => {
  const [branch, allMethods, enabled, branches] = await Promise.all([
    db.get('SELECT * FROM branches WHERE id = ?', [req.params.id]),
    db.all('SELECT * FROM payment_methods WHERE is_active = 1 ORDER BY id'),
    db.all('SELECT payment_method_id, is_default FROM branch_payment_methods WHERE branch_id = ?', [req.params.id]),
    db.all('SELECT id, name FROM branches ORDER BY id'),
  ]);
  if (!branch) return res.status(404).send('지사를 찾을 수 없습니다.');
  const enabledMap = {};
  enabled.forEach((e) => { enabledMap[e.payment_method_id] = e.is_default; });
  res.render('branches/payment_methods', { title: '결제방식 설정 - ' + branch.name, branch, allMethods, enabledMap, branches });
}));

router.post('/:id/payment-methods', asyncHandler(async (req, res) => {
  const ids = [].concat(req.body.payment_method_ids || []).map(Number);
  const defaultId = Number(req.body.default_payment_method_id) || null;
  await db.run('DELETE FROM branch_payment_methods WHERE branch_id = ?', [req.params.id]);
  for (const id of ids) {
    await db.run(
      'INSERT INTO branch_payment_methods (branch_id, payment_method_id, is_default) VALUES (?, ?, ?)',
      [req.params.id, id, id === defaultId ? 1 : 0]
    );
  }
  res.redirect('/branches/' + req.params.id + '/payment-methods');
}));

// ---------------- 운영시간 설정 ----------------
router.get('/:id/operating-hours', asyncHandler(async (req, res) => {
  const [branch, rows, exceptions, branches] = await Promise.all([
    db.get('SELECT * FROM branches WHERE id = ?', [req.params.id]),
    db.all('SELECT * FROM operating_hours WHERE branch_id = ?', [req.params.id]),
    db.all('SELECT * FROM operating_hour_exceptions WHERE branch_id = ? ORDER BY date', [req.params.id]),
    db.all('SELECT id, name FROM branches ORDER BY id'),
  ]);
  if (!branch) return res.status(404).send('지사를 찾을 수 없습니다.');
  const hours = { weekday: rows.find((r) => r.day_type === 'weekday') || {}, weekend: rows.find((r) => r.day_type === 'weekend') || {} };
  res.render('branches/operating_hours', { title: '운영시간 설정 - ' + branch.name, branch, hours, exceptions, branches });
}));

router.post('/:id/operating-hours', asyncHandler(async (req, res) => {
  const { weekday_open, weekday_close, weekday_closed, weekend_open, weekend_close, weekend_closed } = req.body;
  await db.run(`
    INSERT INTO operating_hours (branch_id, day_type, open_time, close_time, is_closed)
    VALUES (?, 'weekday', ?, ?, ?)
    ON CONFLICT (branch_id, day_type) DO UPDATE SET open_time = excluded.open_time, close_time = excluded.close_time, is_closed = excluded.is_closed
  `, [req.params.id, weekday_open || null, weekday_close || null, weekday_closed ? 1 : 0]);
  await db.run(`
    INSERT INTO operating_hours (branch_id, day_type, open_time, close_time, is_closed)
    VALUES (?, 'weekend', ?, ?, ?)
    ON CONFLICT (branch_id, day_type) DO UPDATE SET open_time = excluded.open_time, close_time = excluded.close_time, is_closed = excluded.is_closed
  `, [req.params.id, weekend_open || null, weekend_close || null, weekend_closed ? 1 : 0]);
  res.redirect('/branches/' + req.params.id + '/operating-hours');
}));

router.post('/:id/operating-hours/exceptions', asyncHandler(async (req, res) => {
  const { date, is_closed, open_time, close_time, note } = req.body;
  if (date) {
    await db.run(`
      INSERT INTO operating_hour_exceptions (branch_id, date, is_closed, open_time, close_time, note)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (branch_id, date) DO UPDATE SET is_closed = excluded.is_closed, open_time = excluded.open_time, close_time = excluded.close_time, note = excluded.note
    `, [req.params.id, date, is_closed ? 1 : 0, is_closed ? null : (open_time || null), is_closed ? null : (close_time || null), note || null]);
  }
  res.redirect('/branches/' + req.params.id + '/operating-hours');
}));

router.post('/:id/operating-hours/exceptions/:exceptionId/delete', asyncHandler(async (req, res) => {
  await db.run('DELETE FROM operating_hour_exceptions WHERE id = ? AND branch_id = ?', [req.params.exceptionId, req.params.id]);
  res.redirect('/branches/' + req.params.id + '/operating-hours');
}));

// ---------------- 요금표 설정 ----------------
router.get('/:id/fare-rules', asyncHandler(async (req, res) => {
  const [branch, tiers, extraRow, branches] = await Promise.all([
    db.get('SELECT * FROM branches WHERE id = ?', [req.params.id]),
    db.all('SELECT * FROM fare_rules WHERE branch_id = ? ORDER BY tier_seq', [req.params.id]),
    db.get('SELECT * FROM fare_extra_settings WHERE branch_id = ?', [req.params.id]),
    db.all('SELECT id, name FROM branches ORDER BY id'),
  ]);
  if (!branch) return res.status(404).send('지사를 찾을 수 없습니다.');
  const extra = extraRow || {};
  res.render('branches/fare_rules', {
    title: '요금표 설정 - ' + branch.name,
    branch,
    tiers,
    extra,
    branches,
    saved: req.query.saved === '1',
    copied: req.query.copied === '1',
    copiedFrom: req.query.from || '',
  });
}));

router.post('/:id/fare-rules/copy', asyncHandler(async (req, res) => {
  const targetBranchId = Number(req.params.id);
  const sourceBranchId = Number(req.body.source_branch_id);

  if (!Number.isFinite(sourceBranchId) || sourceBranchId <= 0) {
    return res.status(400).send('복사할 원본 지사를 선택해주세요.');
  }
  if (sourceBranchId === targetBranchId) {
    return res.status(400).send('동일한 지사로는 복사할 수 없습니다.');
  }

  // 넷 다 서로 의존관계 없는 조회라 병렬로 실행한다.
  const [sourceBranch, targetBranch, sourceTiers, sourceExtra] = await Promise.all([
    db.get('SELECT id, name FROM branches WHERE id = ?', [sourceBranchId]),
    db.get('SELECT id, name FROM branches WHERE id = ?', [targetBranchId]),
    db.all('SELECT * FROM fare_rules WHERE branch_id = ? ORDER BY tier_seq', [sourceBranchId]),
    db.get('SELECT * FROM fare_extra_settings WHERE branch_id = ?', [sourceBranchId]),
  ]);
  if (!sourceBranch || !targetBranch) {
    return res.status(404).send('지사를 찾을 수 없습니다.');
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    await client.query('DELETE FROM fare_rules WHERE branch_id = $1', [targetBranchId]);
    for (const t of sourceTiers) {
      await client.query(
        `INSERT INTO fare_rules
          (branch_id, tier_seq, base_distance_km, base_fare, surcharge_unit_km, surcharge_fare, max_distance_km, max_fare, round_unit, round_method, is_representative)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          targetBranchId,
          t.tier_seq,
          t.base_distance_km,
          t.base_fare,
          t.surcharge_unit_km,
          t.surcharge_fare,
          t.max_distance_km,
          t.max_fare,
          t.round_unit,
          t.round_method,
          t.is_representative ? 1 : 0,
        ]
      );
    }

    if (sourceExtra) {
      if (sourceExtra.is_representative) {
        await client.query('UPDATE fare_extra_settings SET is_representative = 0');
      }
      await client.query(
        `INSERT INTO fare_extra_settings
          (branch_id, round_trip_ratio, wait_threshold_min, wait_fee, cancel_before_fee, cancel_after_fee, fare_table_enabled, fare_visible_to_client, fare_editable_by_client, is_representative)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (branch_id) DO UPDATE
         SET round_trip_ratio = excluded.round_trip_ratio,
             wait_threshold_min = excluded.wait_threshold_min,
             wait_fee = excluded.wait_fee,
             cancel_before_fee = excluded.cancel_before_fee,
             cancel_after_fee = excluded.cancel_after_fee,
             fare_table_enabled = excluded.fare_table_enabled,
             fare_visible_to_client = excluded.fare_visible_to_client,
             fare_editable_by_client = excluded.fare_editable_by_client,
             is_representative = excluded.is_representative`,
        [
          targetBranchId,
          sourceExtra.round_trip_ratio,
          sourceExtra.wait_threshold_min,
          sourceExtra.wait_fee,
          sourceExtra.cancel_before_fee,
          sourceExtra.cancel_after_fee,
          sourceExtra.fare_table_enabled,
          sourceExtra.fare_visible_to_client,
          sourceExtra.fare_editable_by_client,
          sourceExtra.is_representative ? 1 : 0,
        ]
      );
    } else {
      await client.query('DELETE FROM fare_extra_settings WHERE branch_id = $1', [targetBranchId]);
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  res.redirect('/branches/' + targetBranchId + '/fare-rules?copied=1&from=' + encodeURIComponent(sourceBranch.name));
}));

router.post('/:id/fare-rules/:tierId/representative', asyncHandler(async (req, res) => {
  const branchId = Number(req.params.id);
  const tierId = Number(req.params.tierId);
  const checked = !!req.body.checked;
  if (!Number.isFinite(branchId) || !Number.isFinite(tierId)) {
    return res.status(400).json({ error: '유효하지 않은 요청입니다.' });
  }

  const tier = await db.get('SELECT id FROM fare_rules WHERE id = ? AND branch_id = ?', [tierId, branchId]);
  if (!tier) return res.status(404).json({ error: '요금 구간을 찾을 수 없습니다.' });

  await db.run('UPDATE fare_rules SET is_representative = ? WHERE id = ? AND branch_id = ?', [checked ? 1 : 0, tierId, branchId]);
  return res.json({ ok: true, checked: !!checked });
}));

router.post('/:id/fare-rules', asyncHandler(async (req, res) => {
  const b = (v) => [].concat(v || []);
  const baseDist = b(req.body.base_distance_km);
  const baseFare = b(req.body.base_fare);
  const surUnit = b(req.body.surcharge_unit_km);
  const surFare = b(req.body.surcharge_fare);
  const maxDist = b(req.body.max_distance_km);
  const maxFare = b(req.body.max_fare);
  const roundUnit = b(req.body.round_unit);
  const roundMethod = b(req.body.round_method);
  const tierRepresentative = b(req.body.tier_representative);

  // 체크박스 value는 행 인덱스(0-based)로 전송된다.
  const representativeByRow = Array.from({ length: baseDist.length }, () => 0);
  tierRepresentative.forEach((v) => {
    const idx = Number(v);
    if (Number.isInteger(idx) && idx >= 0 && idx < representativeByRow.length) representativeByRow[idx] = 1;
  });

  await db.run('DELETE FROM fare_rules WHERE branch_id = ?', [req.params.id]);
  for (let i = 0; i < baseDist.length; i++) {
    if (baseDist[i] === '' && baseFare[i] === '') continue;
    await db.run(`
      INSERT INTO fare_rules (branch_id, tier_seq, base_distance_km, base_fare, surcharge_unit_km, surcharge_fare, max_distance_km, max_fare, round_unit, round_method, is_representative)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      req.params.id, i + 1,
      Number(baseDist[i]) || 0, Number(baseFare[i]) || 0,
      Number(surUnit[i]) || 1, Number(surFare[i]) || 0,
      maxDist[i] ? Number(maxDist[i]) : null, maxFare[i] ? Number(maxFare[i]) : null,
      Number(roundUnit[i]) || 1000, roundMethod[i] || 'round', representativeByRow[i] ? 1 : 0,
    ]);
  }

  const {
    round_trip_ratio, wait_threshold_min, wait_fee, cancel_before_fee, cancel_after_fee,
    fare_table_enabled, fare_visible_to_client, fare_editable_by_client,
  } = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO fare_extra_settings (
         branch_id, round_trip_ratio, wait_threshold_min, wait_fee, cancel_before_fee, cancel_after_fee,
         fare_table_enabled, fare_visible_to_client, fare_editable_by_client, is_representative
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE((SELECT CASE WHEN EXISTS(SELECT 1 FROM fare_rules WHERE branch_id = $1 AND is_representative = 1) THEN 1 ELSE 0 END), 0))
       ON CONFLICT (branch_id) DO UPDATE
       SET round_trip_ratio = excluded.round_trip_ratio,
           wait_threshold_min = excluded.wait_threshold_min,
           wait_fee = excluded.wait_fee,
           cancel_before_fee = excluded.cancel_before_fee,
           cancel_after_fee = excluded.cancel_after_fee,
           fare_table_enabled = excluded.fare_table_enabled,
           fare_visible_to_client = excluded.fare_visible_to_client,
           fare_editable_by_client = excluded.fare_editable_by_client,
           is_representative = excluded.is_representative`,
      [
        req.params.id,
        Number(round_trip_ratio) || 180,
        Number(wait_threshold_min) || 15,
        Number(wait_fee) || 0,
        Number(cancel_before_fee) || 0,
        Number(cancel_after_fee) || 0,
        fare_table_enabled ? 1 : 0,
        fare_visible_to_client ? 1 : 0,
        fare_editable_by_client ? 1 : 0,
      ]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  res.redirect('/branches/' + req.params.id + '/fare-rules?saved=1');
}));

// ---------------- 오더 상태 설정 ----------------
router.get('/:id/order-status', asyncHandler(async (req, res) => {
  const [branch, statuses, branches] = await Promise.all([
    db.get('SELECT * FROM branches WHERE id = ?', [req.params.id]),
    getEffectiveStatuses(req.params.id),
    db.all('SELECT id, name FROM branches ORDER BY id'),
  ]);
  if (!branch) return res.status(404).send('지사를 찾을 수 없습니다.');
  res.render('branches/order_status', { title: '오더 상태 설정 - ' + branch.name, branch, statuses, branches });
}));

router.post('/:id/order-status', asyncHandler(async (req, res) => {
  const visible = new Set([].concat(req.body.customer_visible || []));
  const backoffice = new Set([].concat(req.body.backoffice_only || []));
  await db.run('DELETE FROM order_status_config WHERE branch_id = ?', [req.params.id]);
  for (let i = 0; i < ORDER_STATUSES.length; i++) {
    const s = ORDER_STATUSES[i];
    await db.run(
      'INSERT INTO order_status_config (branch_id, status_code, is_customer_visible, is_backoffice_only, sort_order) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, s, visible.has(s) ? 1 : 0, backoffice.has(s) ? 1 : 0, i]
    );
  }
  res.redirect('/branches/' + req.params.id + '/order-status');
}));

// 오더 등록 화면에서 지사 선택 시 결제수단 목록을 동적으로 갱신하기 위한 JSON 엔드포인트
router.get('/:id/payment-methods.json', asyncHandler(async (req, res) => {
  const methods = await getEffectivePaymentMethods(req.params.id);
  res.json(methods);
}));

// ---------------- 사진 업로드 안내 ----------------
router.get('/:id/photo-settings', asyncHandler(async (req, res) => {
  const [branch, settingsRow, branches] = await Promise.all([
    db.get('SELECT * FROM branches WHERE id = ?', [req.params.id]),
    db.get('SELECT * FROM branch_photo_settings WHERE branch_id = ?', [req.params.id]),
    db.all('SELECT id, name FROM branches ORDER BY id'),
  ]);
  if (!branch) return res.status(404).send('지사를 찾을 수 없습니다.');
  const settings = settingsRow || {};
  res.render('branches/photo_settings', { title: '사진 업로드 안내 - ' + branch.name, branch, settings, branches });
}));

router.post('/:id/photo-settings', asyncHandler(async (req, res) => {
  const { guide_text, guide_image_url } = req.body;
  await db.run(`
    INSERT INTO branch_photo_settings (branch_id, guide_text, guide_image_url)
    VALUES (?, ?, ?)
    ON CONFLICT (branch_id) DO UPDATE SET guide_text=excluded.guide_text, guide_image_url=excluded.guide_image_url
  `, [req.params.id, guide_text || null, guide_image_url || null]);
  res.redirect('/branches/' + req.params.id + '/photo-settings');
}));

// ---------------- 추가기능 (사진 보기 권한) ----------------
router.get('/:id/extra-settings', asyncHandler(async (req, res) => {
  const [branch, settingsRow, branches] = await Promise.all([
    db.get('SELECT * FROM branches WHERE id = ?', [req.params.id]),
    db.get('SELECT * FROM branch_photo_settings WHERE branch_id = ?', [req.params.id]),
    db.all('SELECT id, name FROM branches ORDER BY id'),
  ]);
  if (!branch) return res.status(404).send('지사를 찾을 수 없습니다.');
  const settings = settingsRow || {};
  res.render('branches/extra_settings', { title: '추가기능 - ' + branch.name, branch, settings, branches });
}));

router.post('/:id/extra-settings', asyncHandler(async (req, res) => {
  const { client_can_view, branch_manager_can_view } = req.body;
  await db.run(`
    INSERT INTO branch_photo_settings (branch_id, client_can_view, branch_manager_can_view)
    VALUES (?, ?, ?)
    ON CONFLICT (branch_id) DO UPDATE SET client_can_view=excluded.client_can_view, branch_manager_can_view=excluded.branch_manager_can_view
  `, [req.params.id, client_can_view ? 1 : 0, branch_manager_can_view ? 1 : 0]);
  res.redirect('/branches/' + req.params.id + '/extra-settings');
}));

module.exports = router;
