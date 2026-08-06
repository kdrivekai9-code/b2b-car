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

// OrderAllStatus 응답에는 요금(charge)이 들어있어 안전하게 동기화할 수 있다 — 반면 주소
// (dep_*/arr_*)는 콜마너가 축약된 지명만 주는 경우가 많아(우리 쪽 상세주소를 덮어써서 정보
// 손실이 날 위험) 폴링으로는 동기화하지 않는다(주소/예약시간 변경은 MCP 챗봇 도구 실행 직후
// 우리 쪽에서 직접 반영 — lib/mcpDispatchAgent.js 참고). 예약시간(reservation_time)은
// 정의서상 OrderAllStatus/OrderInfo 응답 어디에도 없어 폴링으로는 애초에 알 수 없다.
async function syncFare(order, item) {
  const charge = Number(item.charge);
  if (!Number.isFinite(charge) || charge <= 0) return;
  if (charge === Number(order.fare_amount || 0)) return;
  await db.run(
    `UPDATE orders SET fare_amount = ?, updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [charge, order.id]
  );
  await db.run(
    `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note) VALUES (?, NULL, ?, ?, ?)`,
    [order.id, order.status, order.status, `[콜마너] 요금 동기화: ${Number(order.fare_amount || 0).toLocaleString('ko-KR')}원 → ${charge.toLocaleString('ko-KR')}원`]
  );
}

// 우리가 접수한 오더의 현재 상태를 conf_slip으로 직접 확인한다(OrderInfo).
//
// 왜 이 경로가 필요한가: 폴링용 OrderAllStatus는 요청단말번호(userHp)에 매인 결과만 돌려주는데,
// 우리는 지사 대표번호(branches.main_phone)를 보내고 있었다. 서울지사의 경우 그 값이 "12345"라
// 어떤 고객의 번호도 아니어서 조회 결과가 항상 0건이었고, 콜마너에서 대기→접수로 바꿔도
// 우리 쪽 상태가 영영 바뀌지 않았다(실측: userHp=12345 → 0건, 실제 고객번호 → 조회됨).
// OrderInfo는 conf_slip만으로 조회되고 userHp 스코프를 타지 않아 이 문제가 없다.
const SYNC_BY_CONF_SLIP_LIMIT = Number(process.env.CALLMANER_SYNC_ORDER_LIMIT || 40);
const SYNC_LOOKBACK_DAYS = Number(process.env.CALLMANER_SYNC_LOOKBACK_DAYS || 3);
const SYNC_CONCURRENCY = Number(process.env.CALLMANER_SYNC_CONCURRENCY || 5);
const TERMINAL_LOCAL_STATUSES = ['완료', '취소'];

async function syncOrdersByConfSlip(branch) {
  const placeholders = TERMINAL_LOCAL_STATUSES.map(() => '?').join(',');
  // 1분마다 도는 폴링이라 대상 건수를 묶어둔다 — 종료 상태가 아니고 최근 접수된 오더만 본다
  // (오래된 미완료 건까지 매분 조회하면 API 호출이 계속 쌓인다).
  const orders = await db.all(
    `SELECT * FROM orders
     WHERE branch_id = ? AND callmaner_conf_slip IS NOT NULL
       AND status NOT IN (${placeholders})
       AND created_at >= to_char((now() at time zone 'Asia/Seoul') - interval '${SYNC_LOOKBACK_DAYS} days', 'YYYY-MM-DD HH24:MI:SS')
     ORDER BY id DESC LIMIT ?`,
    [branch.id, ...TERMINAL_LOCAL_STATUSES, SYNC_BY_CONF_SLIP_LIMIT]
  );

  // 오더 1건당 1회 호출이라 순차로 돌면 건수만큼 시간이 걸린다 — 작은 묶음으로 병렬 조회한다.
  // (목록형 API가 있으면 1회로 끝나지만 콜마너에 그런 명령이 없다: OrderList/OrderAll/
  //  OrderStatusList 등 전부 E4[1003]. 유일한 목록형인 OrderAllStatus는 우리 외부연동 접수건을
  //  돌려주지 않고, 돌려주는 건들도 status_code가 비어 있어 상태 매핑이 불가능하다 — 실측.)
  const infoByOrderId = new Map();
  for (let i = 0; i < orders.length; i += SYNC_CONCURRENCY) {
    const chunk = orders.slice(i, i + SYNC_CONCURRENCY);
    await Promise.all(chunk.map(async (order) => {
      try {
        infoByOrderId.set(order.id, await callmaner.orderInfo(branch, order.callmaner_conf_slip, order.origin_contact));
      } catch (e) {
        console.error(`단건 상태조회 실패 (conf_slip=${order.callmaner_conf_slip}):`, e.message);
      }
    }));
  }

  let updated = 0;
  for (const order of orders) {
    const info = infoByOrderId.get(order.id);
    if (!info) continue;

    // 같은 응답에 요금(price)도 들어 있어 함께 맞춘다 — 요금 동기화는 원래 OrderAllStatus
    // 응답으로만 하고 있었는데 그 경로가 사실상 죽어 있어 한 번도 동작하지 않았다.
    if (info.price != null) {
      await syncFare(order, { charge: info.price }).catch((e) => console.error(`요금 동기화 실패 (conf_slip=${order.callmaner_conf_slip}):`, e.message));
    }

    const mappedStatus = callmaner.STATUS_TEXT_TO_LOCAL_STATUS[info.status];
    const note = `[콜마너] 상태동기화(단건조회): ${info.status || '-'}`;
    if (info.status === order.callmaner_status && (!mappedStatus || mappedStatus === order.status)) continue;

    if (mappedStatus && mappedStatus !== order.status) {
      await db.run(
        `UPDATE orders SET status = ?, callmaner_status = ?,
         callmaner_synced_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'), callmaner_last_error = NULL,
         updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
         WHERE id = ?`,
        [mappedStatus, info.status || null, order.id]
      );
      await db.run(
        `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note) VALUES (?, NULL, ?, ?, ?)`,
        [order.id, order.status, mappedStatus, note]
      );
      try {
        await notify({
          branchId: branch.id, eventType: 'order_events', excludeUserId: 0,
          title: '오더 상태 변경(콜마너)', body: `${order.oid}: ${order.status} → ${mappedStatus}`, url: `/orders/${order.id}`,
        });
      } catch (e) { console.error('콜마너 동기화 알림 발송 실패:', e.message); }
      updated += 1;
    } else if (info.status !== order.callmaner_status) {
      // 매핑 대상이 아닌 상태는 콜마너 쪽 표기만 갱신하고 로컬 status는 그대로 둔다.
      await db.run(
        `UPDATE orders SET callmaner_status = ?,
         callmaner_synced_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
         WHERE id = ?`,
        [info.status || null, order.id]
      );
    }
  }
  return { checked: orders.length, updated };
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
        await syncFare(order, item).catch((e) => console.error(`요금 동기화 실패 (conf_slip=${item.conf_slip}):`, e.message));

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

      // OrderAllStatus가 우리 userHp로는 아무것도 돌려주지 않는 문제가 있어(위 주석 참고),
      // 진행 중인 오더는 conf_slip 단건조회로 한 번 더 확인한다.
      const bySlip = await syncOrdersByConfSlip(branch).catch((e) => {
        console.error(`단건 상태동기화 실패 (branch ${branch.id}):`, e.message);
        return { checked: 0, updated: 0 };
      });
      updated += bySlip.updated;

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
