const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
// 고객 통보·배차지연 화면의 표시 규칙은 법인 화면과 한 벌만 둔다.
const {
  NOTIFY_PHOTO_EVENTS, DISPATCH_CALL_TYPES, parseCallTypes, buildEventRows,
} = require('../lib/customerNotifySettings');
const { ORDER_STATUSES } = require('../config');
const { getEffectivePaymentMethods, getEffectiveStatuses } = require('../lib/branchPolicy');
// 고객 통보 설정 화면이 "어떤 사건이 있고 기본값이 무엇인지"를 통보 모듈에서 그대로 가져온다 —
// 화면에만 따로 목록을 적어두면 사건이 하나 늘 때 설정에서 빠진 채로 남는다.
const kakaoOrderNotify = require('../lib/kakaoOrderNotify');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get('/data.json', asyncHandler(async (req, res) => {
  const branches = await db.all('SELECT id, name, code, main_phone, address, contact_name, contact_phone, status FROM branches ORDER BY id');
  res.json({ currentUser: req.session.user, branches });
}));

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

// 운영시간 입력은 24시간제 시/분 select 두 개로 나뉘어 온다(views/branches/operating_hours.ejs
// 의 timeSelects — <input type="time">이 로케일에 따라 오전/오후로 표시돼 "오후 12:00"을
// 자정으로 오해하는 문제가 있어 바꿨다). 시가 비어 있으면(--) 해당 시간 미설정 = 제한 없음이라
// null로 저장한다. 시만 고르고 분을 안 건드린 경우는 select 기본값이 '00'이라 정시로 저장된다.
function combineHourMinute(hour, minute) {
  const hh = String(hour || '').trim();
  if (!/^\d{1,2}$/.test(hh)) return null;
  const mm = String(minute || '').trim();
  return `${hh.padStart(2, '0')}:${(/^\d{1,2}$/.test(mm) ? mm : '0').padStart(2, '0')}`;
}

router.post('/:id/operating-hours', asyncHandler(async (req, res) => {
  const { weekday_closed, weekend_closed } = req.body;
  const weekday_open = combineHourMinute(req.body.weekday_open_hour, req.body.weekday_open_minute);
  const weekday_close = combineHourMinute(req.body.weekday_close_hour, req.body.weekday_close_minute);
  const weekend_open = combineHourMinute(req.body.weekend_open_hour, req.body.weekend_open_minute);
  const weekend_close = combineHourMinute(req.body.weekend_close_hour, req.body.weekend_close_minute);
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
  const { date, is_closed, note } = req.body;
  const open_time = combineHourMinute(req.body.open_time_hour, req.body.open_time_minute);
  const close_time = combineHourMinute(req.body.close_time_hour, req.body.close_time_minute);
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

// ---------------- 탁송 요금 (지사) ----------------
// 법인 요금표가 없을 때 쓰는 기본값이다(routes/groups.js의 법인 탁송 요금표 참조).
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
    title: '탁송 요금 - ' + branch.name,
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

router.get('/:id/callmaner', asyncHandler(async (req, res) => {
  const [branch, branches] = await Promise.all([
    db.get('SELECT * FROM branches WHERE id = ?', [req.params.id]),
    db.all('SELECT id, name FROM branches ORDER BY id'),
  ]);
  if (!branch) return res.status(404).send('지사를 찾을 수 없습니다.');
  res.render('branches/callmaner', { title: '콜마너 연동 - ' + branch.name, branch, branches });
}));

router.post('/:id/callmaner', asyncHandler(async (req, res) => {
  const { callmaner_provider_id } = req.body;
  const callmanerEnabled = req.body.callmaner_enabled === '1';
  await db.run(
    'UPDATE branches SET callmaner_enabled = ?, callmaner_provider_id = ? WHERE id = ?',
    [callmanerEnabled, callmaner_provider_id || null, req.params.id]
  );
  res.redirect('/branches/' + req.params.id + '/callmaner');
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

// ---------------- 배차지연 알림 설정 ----------------
// 챗봇이 "배차가 지연되고 있으니 요금을 올릴까요?"라고 먼저 제안할 대상을 고객사(법인) 단위로
// 등록한다. 등록되지 않은 고객사에는 선제 안내가 나가지 않는다(옵트인).
// 콜 유형 목록·파싱은 법인 화면(routes/groups.js)과 공유한다(lib/customerNotifySettings.js).

async function loadDispatchDelayPage(branchId) {
  const [branch, branches, groups, settings] = await Promise.all([
    db.get('SELECT * FROM branches WHERE id = ?', [branchId]),
    db.all('SELECT id, name FROM branches ORDER BY id'),
    db.all('SELECT id, name, main_phone FROM groups_tbl WHERE branch_id = ? ORDER BY name', [branchId]),
    // 마이그레이션(20260806020000) 적용 전에도 화면이 뜨도록 — 테이블이 없으면 빈 목록으로 본다.
    db.all(`
      SELECT s.*, g.name AS group_name, g.main_phone AS group_phone
      FROM dispatch_delay_settings s
      JOIN groups_tbl g ON g.id = s.group_id
      WHERE s.branch_id = ?
      ORDER BY g.name
    `, [branchId]).catch((e) => {
      console.error('배차지연 알림 설정 조회 실패(빈 목록으로 표시):', e.message);
      return [];
    }),
  ]);
  return { branch, branches, groups, settings };
}

router.get('/:id/dispatch-delay', asyncHandler(async (req, res) => {
  const { branch, branches, groups, settings } = await loadDispatchDelayPage(req.params.id);
  if (!branch) return res.status(404).send('지사를 찾을 수 없습니다.');
  res.render('branches/dispatch_delay', {
    title: '배차지연 알림 - ' + branch.name,
    branch,
    branches,
    groups,
    settings,
    callTypes: DISPATCH_CALL_TYPES,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
}));

router.post('/:id/dispatch-delay', asyncHandler(async (req, res) => {
  const base = '/branches/' + req.params.id + '/dispatch-delay';
  const groupId = Number(req.body.group_id);
  const callTypes = parseCallTypes(req.body.call_types);
  const delayMinutes = Number(req.body.delay_minutes);
  const raiseAmount = Number(req.body.raise_amount);

  if (!Number.isInteger(groupId) || groupId <= 0) {
    return res.redirect(base + '?error=' + encodeURIComponent('고객사를 선택해주세요.'));
  }
  if (!callTypes.length) {
    return res.redirect(base + '?error=' + encodeURIComponent('적용할 콜 유형을 하나 이상 선택해주세요.'));
  }
  if (!Number.isInteger(delayMinutes) || delayMinutes < 1 || delayMinutes > 120) {
    return res.redirect(base + '?error=' + encodeURIComponent('배차지연 판단 시간은 1~120분 사이로 입력해주세요.'));
  }
  if (!Number.isInteger(raiseAmount) || raiseAmount < 1000 || raiseAmount > 10000 || raiseAmount % 1000 !== 0) {
    return res.redirect(base + '?error=' + encodeURIComponent('요금 상향금액은 1,000원 단위로 10,000원까지 선택해주세요.'));
  }

  // 이 지사에 속한 고객사만 등록할 수 있다(다른 지사 고객사가 폼 조작으로 들어오는 것 방지).
  const group = await db.get('SELECT id FROM groups_tbl WHERE id = ? AND branch_id = ?', [groupId, req.params.id]);
  if (!group) {
    return res.redirect(base + '?error=' + encodeURIComponent('이 지사에 속한 고객사가 아닙니다.'));
  }

  await db.run(`
    INSERT INTO dispatch_delay_settings (branch_id, group_id, call_types, delay_minutes, raise_amount)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (branch_id, group_id) DO UPDATE SET
      call_types = excluded.call_types,
      delay_minutes = excluded.delay_minutes,
      raise_amount = excluded.raise_amount,
      updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
  `, [req.params.id, groupId, callTypes.join(','), delayMinutes, raiseAmount]);

  res.redirect(base + '?notice=' + encodeURIComponent('배차지연 알림 설정이 저장되었습니다.'));
}));

router.post('/:id/dispatch-delay/:settingId/delete', asyncHandler(async (req, res) => {
  await db.run('DELETE FROM dispatch_delay_settings WHERE id = ? AND branch_id = ?', [req.params.settingId, req.params.id]);
  res.redirect('/branches/' + req.params.id + '/dispatch-delay?notice=' + encodeURIComponent('설정이 삭제되었습니다.'));
}));

// ---------------- 고객 통보 (카카오 상담톡 능동 통보) ----------------
//
// 어떤 상태 변화를 언제 어떤 문구로 알릴지 지사가 정한다. 설정을 저장하지 않은 지사는 코드
// 기본값(lib/kakaoOrderNotify.js의 DEFAULT_EVENT_SETTINGS)으로 동작한다 — 지사를 새로 만들 때마다
// 설정을 넣어주지 않아도 통보가 나가야 해서 옵트아웃으로 뒀다.



async function loadCustomerNotificationPage(branchId) {
  const [branch, branches] = await Promise.all([
    db.get('SELECT * FROM branches WHERE id = ?', [branchId]),
    db.all('SELECT id, name FROM branches ORDER BY id'),
  ]);
  if (!branch) return { branch: null };

  // 마이그레이션(20260809020000) 적용 전에도 화면이 뜨게 한다 — 저장된 값이 없으면 기본값을 보여준다.
  // 컬럼을 나열하면 attach_photos가 없는 DB에서 42703이 나므로 *로 받아 코드에서 판단한다.
  const saved = await db.all(
    'SELECT * FROM branch_customer_notifications WHERE branch_id = ?',
    [branchId]
  ).catch((e) => {
    console.error('고객 통보 설정 조회 실패(기본값으로 표시):', e.message);
    return [];
  });
  const savedByEvent = new Map(saved.map((row) => [row.event_type, row]));

  const events = buildEventRows(saved);

  return { branch, branches, events, variables: kakaoOrderNotify.TEMPLATE_VARIABLES };
}

// 상담원 상태로 붙잡힌 세션을 봇으로 되돌리기까지의 유휴 시간. 비워두면 기본값(30분)을 쓰고,
// 0이면 그 지사는 자동 복귀를 하지 않는다(상담원이 직접 종료할 때까지 붙잡아 두는 운영).
const DEFAULT_AGENT_IDLE_RELEASE_MINUTES = 30;

router.get('/:id/customer-notifications', asyncHandler(async (req, res) => {
  const { branch, branches, events, variables } = await loadCustomerNotificationPage(req.params.id);
  if (!branch) return res.status(404).send('지사를 찾을 수 없습니다.');
  res.render('branches/customer_notifications', {
    title: '고객 통보 - ' + branch.name,
    branch,
    branches,
    events,
    variables,
    // 마이그레이션(20260810010000) 적용 전이면 컬럼이 없다 — 그때는 기본값을 보여준다.
    agentIdleReleaseMinutes: branch.agent_idle_release_minutes == null
      ? DEFAULT_AGENT_IDLE_RELEASE_MINUTES
      : Number(branch.agent_idle_release_minutes),
    defaultAgentIdleReleaseMinutes: DEFAULT_AGENT_IDLE_RELEASE_MINUTES,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
}));

router.post('/:id/customer-notifications', asyncHandler(async (req, res) => {
  const base = '/branches/' + req.params.id + '/customer-notifications';
  const branch = await db.get('SELECT id FROM branches WHERE id = ?', [req.params.id]);
  if (!branch) return res.status(404).send('지사를 찾을 수 없습니다.');

  // 저장은 모든 사건을 한 번에 받는다 — 하나라도 잘못되면 아무것도 저장하지 않는다. 절반만
  // 반영되면 화면에 보이는 것과 실제로 나가는 문구가 어긋난다.
  const rows = [];
  for (const key of kakaoOrderNotify.EVENT_TYPES) {
    const fallback = kakaoOrderNotify.DEFAULT_EVENT_SETTINGS[key];
    const delayMinutes = Number(req.body['delay_' + key]);
    // textarea는 개행을 \r\n으로 보낸다. 그대로 저장하면 고객에게 나가는 문구에 캐리지 리턴이
    // 섞이고, 기본값과 글자가 같은데도 "다른 문구"로 저장된 것처럼 보인다(실제로 그렇게 됐다).
    const template = String(req.body['message_' + key] || '').replace(/\r\n?/g, '\n').trim();

    if (!Number.isInteger(delayMinutes) || delayMinutes < 0 || delayMinutes > 120) {
      return res.redirect(base + '?error=' + encodeURIComponent(`${fallback.label}의 보내는 시점은 0~120분 사이로 입력해주세요.`));
    }
    if (!template) {
      return res.redirect(base + '?error=' + encodeURIComponent(`${fallback.label}의 문구를 입력해주세요.`));
    }
    rows.push({
      key,
      enabled: !!req.body['enabled_' + key],
      delayMinutes,
      template,
      // 사진을 붙일 수 없는 사건(배차)에서 스위치가 켜져 오면 무시한다 — 그 시점에는 사진이 없다.
      attachPhotos: NOTIFY_PHOTO_EVENTS.has(key) && !!req.body['attach_photos_' + key],
    });
  }

  // 유휴 복귀 시간도 이 화면에서 함께 저장한다 — 같은 상담 흐름 설정이라 화면을 나눌 이유가 없다.
  const idleMinutes = Number(req.body.agent_idle_release_minutes);
  if (!Number.isInteger(idleMinutes) || idleMinutes < 0 || idleMinutes > 1440) {
    return res.redirect(base + '?error=' + encodeURIComponent('봇 응대 복귀 시간은 0~1440분 사이로 입력해주세요.'));
  }
  await db.run('UPDATE branches SET agent_idle_release_minutes = ? WHERE id = ?', [idleMinutes, req.params.id])
    .catch((e) => {
      // 컬럼이 없는 DB(마이그레이션 전)에서는 통보 설정 저장까지 막지 않는다.
      if (!e || e.code !== '42703') throw e;
      console.error('봇 응대 복귀 시간 저장 실패(마이그레이션 미적용):', e.message);
    });

  for (const row of rows) {
    try {
      await db.run(`
        INSERT INTO branch_customer_notifications (branch_id, event_type, enabled, delay_minutes, message_template, attach_photos)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (branch_id, event_type) DO UPDATE SET
          enabled = excluded.enabled,
          delay_minutes = excluded.delay_minutes,
          message_template = excluded.message_template,
          attach_photos = excluded.attach_photos,
          updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
      `, [req.params.id, row.key, row.enabled, row.delayMinutes, row.template, row.attachPhotos]);
    } catch (e) {
      // attach_photos 컬럼이 없는 DB(마이그레이션 전)에서는 그 칸만 빼고 저장한다 — 문구/지연
      // 설정이 사진 스위치 하나 때문에 통째로 막히면 안 된다.
      if (!e || e.code !== '42703') throw e;
      await db.run(`
        INSERT INTO branch_customer_notifications (branch_id, event_type, enabled, delay_minutes, message_template)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (branch_id, event_type) DO UPDATE SET
          enabled = excluded.enabled,
          delay_minutes = excluded.delay_minutes,
          message_template = excluded.message_template,
          updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
      `, [req.params.id, row.key, row.enabled, row.delayMinutes, row.template]);
    }
  }

  res.redirect(base + '?notice=' + encodeURIComponent('고객 통보 설정이 저장되었습니다.'));
}));

// ---------------- 일일기사 요금 (지사) ----------------
// 이름만 바뀌었고 테이블(premium_fare_rules)은 그대로다 — 이 표를 실제로 쓰는 상품이
// 일일기사라 이름을 맞췄다. 프리미엄(대리)은 요금 체계가 나오면 별도 표를 만든다.
router.get('/:id/premium-fare-rules', asyncHandler(async (req, res) => {
  const [branch, tiers, branches] = await Promise.all([
    db.get('SELECT * FROM branches WHERE id = ?', [req.params.id]),
    db.all('SELECT * FROM premium_fare_rules WHERE branch_id = ? ORDER BY tier_seq', [req.params.id]),
    db.all('SELECT id, name FROM branches ORDER BY id'),
  ]);
  if (!branch) return res.status(404).send('지사를 찾을 수 없습니다.');
  res.render('branches/premium_fare_rules', {
    title: '일일기사 요금 - ' + branch.name,
    branch, tiers, branches,
    saved: req.query.saved === '1',
  });
}));

router.post('/:id/premium-fare-rules', asyncHandler(async (req, res) => {
  const branchId = Number(req.params.id);
  const b = (v) => [].concat(v || []);
  const baseHours = b(req.body.base_hours);
  const fareAmount = b(req.body.fare_amount);
  const extraPerHour = b(req.body.extra_per_hour);
  const note = b(req.body.note);

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM premium_fare_rules WHERE branch_id = $1', [branchId]);
    for (let i = 0; i < baseHours.length; i++) {
      const bh = Number(baseHours[i]);
      if (!Number.isFinite(bh) || bh < 0) continue;
      await client.query(
        `INSERT INTO premium_fare_rules (branch_id, tier_seq, base_hours, fare_amount, extra_per_hour, note)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [branchId, i + 1, bh, Number(fareAmount[i]) || 0, Number(extraPerHour[i]) || 0, note[i] || null]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.redirect('/branches/' + branchId + '/premium-fare-rules?saved=1');
}));

router.get('/:id/premium-fare-rules/data.json', asyncHandler(async (req, res) => {
  const [branch, tiers] = await Promise.all([
    db.get('SELECT * FROM branches WHERE id = ?', [req.params.id]),
    db.all('SELECT * FROM premium_fare_rules WHERE branch_id = ? ORDER BY tier_seq', [req.params.id]),
  ]);
  if (!branch) return res.status(404).json({ error: '지사를 찾을 수 없습니다.' });
  res.json({ currentUser: req.session.user, branch, tiers });
}));

module.exports = router;
