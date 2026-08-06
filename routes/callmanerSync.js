// 콜마너 상태동기화 폴링 — Vercel Cron이 주기적으로 호출한다(vercel.json의 crons 참고).
// 세션 로그인 사용자가 없는 서버 대 서버 호출이라 다른 routes/*.js처럼 requireAuth를 쓰지
// 않고, Vercel이 CRON_SECRET 환경변수 설정 시 자동으로 붙여주는 Authorization 헤더로 검증한다.
const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const callmaner = require('../lib/callmaner');
const { notify } = require('../lib/push');
const { broadcastOrderListChanged } = require('../lib/realtimeChat');

const router = express.Router();

function checkCronAuth(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: 'CRON_SECRET 환경변수가 설정되어 있지 않습니다.' });
  if (req.get('Authorization') !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// callmaner_driver_* 컬럼은 20260806000000 마이그레이션에서 추가된다 — 아직 적용하지 않은
// DB에서도(구버전 호환, callmaner_last_error_code와 같은 이유) 상태 동기화 자체는 계속
// 돌아야 하므로, 컬럼 있는 쿼리가 실패하면 그 컬럼 없는 쿼리로 한 번 더 시도한다.
async function tryUpdateDriverColumns(sqlWithDriver, paramsWithDriver, sqlWithoutDriver, paramsWithoutDriver) {
  try {
    await db.run(sqlWithDriver, paramsWithDriver);
  } catch (e) {
    await db.run(sqlWithoutDriver, paramsWithoutDriver).catch(() => {});
  }
}

// OrderAllStatus의 wk_name("사번*이름")을 분리해 우리쪽 배정 기사(drivers 테이블)와는 별개인
// "콜마너 배정 기사" 이름/사번을 저장한다. 실제 연락처(가상번호)는 이 폴링 응답에 없으므로,
// 상태가 배차(status_code=02)로 갓 바뀌었고 아직 연락처를 못 받은 경우에만 별도 API
// (기사연락처조회/WkContactSearch)를 호출해 채운다 — 매 폴링(1분)마다 부르면 불필요한 호출이
// 쌓이므로 "아직 없을 때"로만 제한한다.
async function syncDriverInfo(branch, order, item, statusCode) {
  const parsed = callmaner.parseDriverNameField(item.wk_name);
  let name = parsed.name || null;
  let sabun = parsed.sabun || null;
  let phone = order.callmaner_driver_phone || null;

  const needsContact = statusCode === '02' && !order.callmaner_driver_phone;
  if (needsContact) {
    try {
      const contact = await callmaner.wkContactSearch(branch, item.conf_slip);
      name = contact.name || name;
      sabun = contact.sabun || sabun;
      phone = contact.phone || phone;
    } catch (e) {
      console.error(`기사연락처조회 실패 (conf_slip=${item.conf_slip}):`, e.message);
    }
  }

  const changed = name !== (order.callmaner_driver_name || null)
    || sabun !== (order.callmaner_driver_sabun || null)
    || phone !== (order.callmaner_driver_phone || null);
  if (!changed) return;

  await tryUpdateDriverColumns(
    `UPDATE orders SET callmaner_driver_name = ?, callmaner_driver_sabun = ?, callmaner_driver_phone = ? WHERE id = ?`,
    [name, sabun, phone, order.id],
    // 마이그레이션 전 DB에서는 그냥 아무것도 안 함(할 수 있는 컬럼이 없음) — 두 번째 인자로 no-op 쿼리
    `SELECT 1`,
    []
  );
}

router.get('/sync', checkCronAuth, asyncHandler(async (req, res) => {
  const branches = await db.all('SELECT * FROM branches WHERE callmaner_enabled = true');
  const summary = [];

  for (const branch of branches) {
    try {
      const stateRow = await db.get('SELECT last_up_date FROM callmaner_sync_state WHERE branch_id = ?', [branch.id]);
      const lastUpDate = (stateRow && stateRow.last_up_date) || '0';
      const { orderList, lastUpDate: nextLastUpDate } = await callmaner.orderAllStatus(branch, lastUpDate);

      let updated = 0;
      for (const item of orderList) {
        const confSlip = item.conf_slip;
        if (!confSlip) continue;
        const order = await db.get('SELECT * FROM orders WHERE branch_id = ? AND callmaner_conf_slip = ?', [branch.id, confSlip]);
        if (!order) continue;

        const statusCode = item.status_code;
        const mappedStatus = callmaner.STATUS_CODE_TO_LOCAL_STATUS[statusCode];
        const rawNote = `[콜마너] 상태동기화: ${item.status || ''}(${statusCode || ''})`;

        // 기사(이름/사번/연락처) 정보는 상태 매핑 여부와 무관하게 항상 확인한다 — 03(타사배차)처럼
        // 로컬 status는 안 바꾸는 코드라도 기사 배정 정보 자체는 그대로 보여줘야 한다.
        await syncDriverInfo(branch, order, item, statusCode);

        if (mappedStatus && mappedStatus !== order.status) {
          await db.run(
            `UPDATE orders SET status = ?, callmaner_status = ?, callmaner_status_code = ?,
             callmaner_synced_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'), callmaner_last_error = NULL,
             updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
             WHERE id = ?`,
            [mappedStatus, item.status || null, statusCode || null, order.id]
          );
          await db.run(
            `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note) VALUES (?, NULL, ?, ?, ?)`,
            [order.id, order.status, mappedStatus, rawNote]
          );
          try {
            await notify({
              branchId: branch.id, eventType: 'order_events', excludeUserId: 0,
              title: '오더 상태 변경(콜마너)', body: `${order.oid}: ${order.status} → ${mappedStatus}`, url: `/orders/${order.id}`,
            });
          } catch (e) { console.error('콜마너 동기화 알림 발송 실패:', e.message); }
          updated += 1;
        } else if (item.status !== order.callmaner_status || statusCode !== order.callmaner_status_code) {
          // 03(타사배차)/04(강제)/06(예약)/08(예약배차) 등 자동 매핑 대상이 아닌 상태코드는
          // 참고용으로만 기록하고 로컬 status는 그대로 둔다(관리자가 직접 확인/변경).
          await db.run(
            `UPDATE orders SET callmaner_status = ?, callmaner_status_code = ?,
             callmaner_synced_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
             WHERE id = ?`,
            [item.status || null, statusCode || null, order.id]
          );
          await db.run(
            `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note) VALUES (?, NULL, NULL, NULL, ?)`,
            [order.id, `${rawNote} — 자동 상태변경 대상 아님, 관리자 확인 필요`]
          );
        }
      }

      if (updated > 0) broadcastOrderListChanged().catch((e) => console.error('콜마너 동기화 후 목록 갱신 신호 실패:', e.message));

      await db.run(
        `INSERT INTO callmaner_sync_state (branch_id, last_up_date, updated_at)
         VALUES (?, ?, to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'))
         ON CONFLICT (branch_id) DO UPDATE SET last_up_date = excluded.last_up_date, updated_at = excluded.updated_at`,
        [branch.id, nextLastUpDate]
      );
      summary.push({ branchId: branch.id, ok: true, count: orderList.length, updated });
    } catch (e) {
      console.error(`콜마너 동기화 실패 (branch ${branch.id}):`, e.message);
      summary.push({ branchId: branch.id, ok: false, error: e.message });
    }
  }

  res.json({ ok: true, summary });
}));

module.exports = router;
