// 콜마너 상태동기화 폴링 — Vercel Cron이 주기적으로 호출한다(vercel.json의 crons 참고).
// 세션 로그인 사용자가 없는 서버 대 서버 호출이라 다른 routes/*.js처럼 requireAuth를 쓰지
// 않고, Vercel이 CRON_SECRET 환경변수 설정 시 자동으로 붙여주는 Authorization 헤더로 검증한다.
const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const callmaner = require('../lib/callmaner');
const callmanerPhotos = require('../lib/callmanerPhotos');
const photoAvailability = require('../lib/photoAvailability');
const odometerOcr = require('../lib/odometerOcr');
const { runKakaoOrderNotifications } = require('../lib/kakaoOrderNotify');
const { notify } = require('../lib/push');
const { broadcastOrderListChanged } = require('../lib/realtimeChat');
const { logIntegrationErrorAsync } = require('../lib/integrationLog');

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
// 기사 이름·사번은 조회 응답의 wk_info에서 바로 나오고, 연락처만 별도 API(기사연락처조회/
// WkContactSearch)를 한 번 더 불러야 채워진다.
//
// 예전에는 그 호출 조건이 "상태가 배차(status_code=02)일 때"였다. 그런데 예약 건은 기사가
// 배정돼도 콜마너 상태가 계속 '예약'이라 이 조건에 영영 들어오지 않았다 — 실측 OID1455는
// 기사 이름(채정식)은 저장됐는데 연락처가 null로 남았고, 그래서 "기사님 연락처요"에 답할 수도,
// 배차 통보에 기사 줄을 넣을 수도 없었다.
//
// 조건을 "기사가 배정됐는데 번호가 없을 때"로 바꾼다. 상태 표기가 무엇이든 기사 정보가 들어온
// 이상 번호도 있어야 한다. 번호를 받으면 phone이 채워져 다음 폴링부터는 부르지 않는다.
async function syncDriverInfo(branch, order, item, statusCode) {
  const parsed = callmaner.parseDriverNameField(item.wk_name);
  let name = parsed.name || null;
  let sabun = parsed.sabun || null;
  let phone = order.callmaner_driver_phone || null;

  const needsContact = !!(name || sabun || statusCode === '02') && !phone;
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

// 우리가 접수한 오더의 현재 상태를 확인한다 — 연락처 단위 목록조회(OrderHistory) 후,
// 목록에 없는 건만 단건조회(OrderInfo)로 보완한다.
//
// 왜 OrderAllStatus를 안 쓰는가: 그쪽은 요청단말번호(userHp)에 매인 결과만 돌려주는데 우리는
// 지사 대표번호(branches.main_phone)를 보내고 있었다. 서울지사는 그 값이 "12345"라 어떤 고객의
// 번호도 아니어서 결과가 항상 0건이었고, 콜마너에서 대기→접수로 바꿔도 우리 쪽 상태가 영영
// 바뀌지 않았다. 게다가 올바른 번호로 보내도 OrderReceipt로 접수한 건은 목록에 나오지 않고,
// 나오는 건들조차 status_code가 빈 문자열이라 매핑이 불가능하다(정의서상 필수 항목인데도).
// OrderHistory는 같은 userHp로 우리 접수건이 정상 조회되고 상태도 한글로 채워져 온다(실측).
// 1분마다 상태를 확인할 오더 수의 상한.
//
// 40 → 200 → 500으로 올렸다(2026-08-29). 40은 근거 없이 보수적으로 잡은 값이었는데, 실제로
// 재보니 콜마너 단건조회가 **중앙값 14ms · 최대 87ms**로 매우 빠르다. 오더 하나당 조회 3회를
// 잡고 동시 10개로 돌리면:
//   500건 × 3회 ÷ 10동시 = 150라운드 × 87ms ≒ 13초  (1분 창 안에 넉넉히 들어간다)
//
// 왜 상한 자체는 남기나: 없애면 진행 중 오더가 몇 천 건일 때 매분 그만큼 API를 두드린다.
// 콜마너도 같은 회사 인프라라 우리가 부담을 다 떠넘길 이유가 없다.
//
// 상한을 넘겨도 빠지는 오더는 없다 — 위 ORDER BY가 "오래 확인 안 된 순"이라 다음 회차에
// 맨 앞으로 온다. 대상 N건·상한 L일 때 모든 오더가 ceil(N/L)분 안에 한 번은 확인된다.
const SYNC_BY_CONF_SLIP_LIMIT = Number(process.env.CALLMANER_SYNC_ORDER_LIMIT || 500);
const SYNC_LOOKBACK_DAYS = Number(process.env.CALLMANER_SYNC_LOOKBACK_DAYS || 3);
// 동시 호출 수. 상한을 올릴 때 여기를 같이 올려야 의미가 있다 — 걸리는 시간은
// (건수 ÷ 동시성) × 응답시간이라, 동시성이 그대로면 상한만 올려도 시간만 길어진다.
const SYNC_CONCURRENCY = Number(process.env.CALLMANER_SYNC_CONCURRENCY || 10);

// 한 회차에 쓸 수 있는 시간(ms). 이 시간을 넘기면 남은 오더는 건드리지 않고 끝낸다.
//
// 왜 건수 상한만으로는 부족한가: 상한은 "콜마너가 지금만큼 빠를 때" 걸리는 시간을 정할 뿐이다.
// 콜마너가 느려지면 같은 500건이 10초가 아니라 2분이 걸리고, 그러면 1분 주기 크론이 겹쳐
// 같은 오더를 두 번 조회하며 부하가 배로 뛴다. 시간으로 자르면 얼마나 느려지든 겹치지 않는다.
//
// 45초로 둔 이유: 크론 주기가 60초라 여유 15초를 남긴다. 남긴 오더는 버려지는 게 아니라
// 다음 회차에 **가장 오래 확인 안 된 순서**로 맨 앞에 오므로(위 ORDER BY) 곧바로 처리된다.
const SYNC_TIME_BUDGET_MS = Number(process.env.CALLMANER_SYNC_TIME_BUDGET_MS || 45000);
const TERMINAL_LOCAL_STATUSES = ['완료', '취소'];
// 완료/취소로 기록된 뒤에도 이 시간 동안은 계속 상태를 확인한다. 콜마너가 재배차 직전에 잠깐
// 주는 '취소'를 우리가 종료로 굳혀버리는 것을 막기 위한 창이다(실측상 1~2분 안에 되살아난다).
// 너무 길게 잡으면 종료 건까지 매분 조회하게 되므로 기본 60분으로 둔다.
const TERMINAL_RECHECK_MINUTES = Number(process.env.CALLMANER_TERMINAL_RECHECK_MINUTES || 60);
const DISPATCHED_LOCAL_STATUS = '기사배정';
const STARTED_LOCAL_STATUS = '운행시작';
// 콜마너 baecha_status: 0 배차상태아님 / 1 기사도착 / 2 운행시작 (정의서 "오더상세조회").
const BAECHA_STATUS_DRIVING = '2';

// 아직 기사가 붙기 전 단계들. 여기 있는 동안 기사 정보가 들어오면 배차된 것으로 본다.
// 완료·취소·문의는 넣지 않는다 — 종료된 건을 기사배정으로 되돌리면 통보까지 다시 나간다.
const PRE_DISPATCH_LOCAL_STATUSES = new Set(['접수', '대기', '예약']);

// 콜마너가 기사를 붙였는지 — wk_info("사번*이름")에 값이 있으면 배정된 것이다.
function hasDriverAssigned(info) {
  const parsed = callmaner.parseDriverNameField(info && info.wkInfo);
  return !!(parsed && (parsed.name || parsed.sabun));
}

// 콜마너 상태 + 배차이후상태를 로컬 상태 하나로 합친다. 콜마너는 기사가 출발한 뒤에도 계속
// status='배차'를 주고, 출발 여부는 baecha_status로만 구분된다.
function resolveLocalStatus(info) {
  let mapped = callmaner.STATUS_TEXT_TO_LOCAL_STATUS[info.status];

  // 예약 건은 기사가 배정돼도 콜마너 status가 한동안 '예약'에 머문다(실측 OID1455 — status "예약",
  // wk_info "T11111*채정식", baecha_status "3"). 그래서 status 문자열만 보면 그 구간 내내 배차를
  // 못 알아챈다.
  //
  // 통보가 아예 누락되는 것은 아니다 — 콜마너가 나중에 '배차'로 바꾸면 그때 전이가 잡히고 통보도
  // 나간다. 이 매핑이 하는 일은 그 통보를 **앞당기는 것**이다. OID1455 실측: 콜마너의 '배차' 전환은
  // 14:50:01(statusTime 20260825145001)이었는데, wk_info를 보고 10:46:41에 기사배정으로 올려
  // 배차완료 통보가 4시간 3분 먼저 나갔다.
  //
  // 배차 여부는 wk_info(기사 정보)로 판단한다. baecha_status는 쓰지 않는다 — 정의서에 정의된
  // 값이 0(배차상태아님)/1(기사도착)/2(운행시작)뿐인데 실서버가 문서에 없는 3을 준다. 뜻을
  // 모르는 값으로 운행 단계를 정하면 "기사도착"과 헷갈릴 수 있어, 확실한 신호만 쓴다.
  if (PRE_DISPATCH_LOCAL_STATUSES.has(mapped) && hasDriverAssigned(info)) {
    mapped = DISPATCHED_LOCAL_STATUS;
  }

  if (mapped === DISPATCHED_LOCAL_STATUS && String(info.baechaStatus || '') === BAECHA_STATUS_DRIVING) {
    return STARTED_LOCAL_STATUS;
  }
  return mapped;
}

// 운행시작 → 기사배정으로 되돌리는 것을 막는다.
//
// 이 가드가 없으면: 콜마너는 운행 중에도 status='배차'를 계속 주므로 baecha_status를 못 받은
// 주기(단건조회 실패, 응답에 값 없음 등)마다 매핑 결과가 '기사배정'이 되어 상태가 매분
// 운행시작 ↔ 기사배정을 왕복한다. 상태가 바뀔 때마다 order_status_history에 행이 쌓이고,
// 그걸 읽는 능동 통보(lib/kakaoOrderNotify.js)가 "배차되었습니다"를 매분 고객에게 보낸다.
function isBackwardTransition(currentStatus, nextStatus) {
  return currentStatus === STARTED_LOCAL_STATUS && nextStatus === DISPATCHED_LOCAL_STATUS;
}

async function syncOrdersByConfSlip(branch) {
  const placeholders = TERMINAL_LOCAL_STATUSES.map(() => '?').join(',');
  // 1분마다 도는 폴링이라 대상 건수를 묶어둔다 — 최근 접수된 오더만 본다(오래된 건까지 매분
  // 조회하면 API 호출이 계속 쌓인다).
  //
  // 완료/취소도 잠시 동안은 계속 본다(사용자 요청). 예전에는 종료 상태를 아예 빼서, 한 번
  // 취소로 기록되면 그 오더를 다시는 조회하지 않았다 — 그런데 콜마너는 기사가 배차를 취소하면
  // 잠깐 '취소'를 준 뒤 곧바로 '접수'로 되돌려 재배차를 진행한다(OID1237 실측: 18:41:29 취소 →
  // 18:42:30 접수). 그 순간을 잡으면 오더가 실제로는 살아 있는데 우리 화면에는 영영 '취소'로
  // 굳어버린다. 되살아나는 것은 대개 1~2분 안이라 짧은 창만 열어두면 충분하다.
  //
  // ORDER BY 두 단계:
  //
  //  1) 진행 중인 오더를 먼저 담는다 — 종료 건이 LIMIT을 차지해 정작 진행 중인 오더가 밀려나면 안 된다.
  //
  //  2) 그다음은 **오래 확인 안 된 순서**(callmaner_synced_at ASC)다. 예전에는 id DESC였는데,
  //     그러면 대상이 LIMIT을 넘는 순간 조용히 굶는 오더가 생긴다. id DESC는 매분 같은 결과를
  //     주므로 최신 N건만 영원히 확인되고, N번째 뒤로 밀린 오더는 **한 번도** 조회되지 않는다.
  //     그 상태로 3일이 지나면 조회 대상(created_at 조건)에서 아예 빠져 영영 미완료로 남는다 —
  //     배차·완료 감지도, 고객 통보도 나가지 않는다. "밀린다"가 아니라 "버려진다"였다.
  //
  //     확인 시각순으로 돌리면 대상이 N건이고 상한이 L일 때 모든 오더가 ceil(N/L)분마다 한 번은
  //     확인된다. 늦어지기는 해도 빠지지는 않는다. 한 번도 확인 안 된 건(NULL)이 가장 먼저다.
  //
  // callmaner_synced_at은 text(KST 'YYYY-MM-DD HH24:MI:SS')라 문자열 정렬이 곧 시간순이다.
  const orders = await db.all(
    `SELECT * FROM orders
     WHERE branch_id = ? AND callmaner_conf_slip IS NOT NULL
       AND created_at >= to_char((now() at time zone 'Asia/Seoul') - interval '${SYNC_LOOKBACK_DAYS} days', 'YYYY-MM-DD HH24:MI:SS')
       AND (
         status NOT IN (${placeholders})
         OR updated_at >= to_char((now() at time zone 'Asia/Seoul') - interval '${TERMINAL_RECHECK_MINUTES} minutes', 'YYYY-MM-DD HH24:MI:SS')
       )
     ORDER BY (status IN (${placeholders})) ASC, callmaner_synced_at ASC NULLS FIRST, id DESC
     LIMIT ?`,
    [branch.id, ...TERMINAL_LOCAL_STATUSES, ...TERMINAL_LOCAL_STATUSES, SYNC_BY_CONF_SLIP_LIMIT]
  );

  // 연락처(userHp) 단위로 묶어 목록조회(OrderHistory) 한 번에 그 번호의 오더를 모두 받는다.
  // 접수(OrderReceipt)에 쓴 것과 같은 방식으로 userHp를 만들어야 같은 묶음으로 조회된다.
  // 목록에서 못 찾은 건만 단건조회(OrderInfo)로 보완한다 — 콜마너가 기록한 userHp가 우리가
  // 보낸 값과 다른 경우가 있을 수 있어서(목록은 userHp 스코프, 단건은 conf_slip 스코프).
  const byUserHp = new Map();
  orders.forEach((order) => {
    const hp = callmaner.normalizeUserHp([order.origin_contact, order.requester_phone, branch.main_phone]);
    if (!hp) return;
    if (!byUserHp.has(hp)) byUserHp.set(hp, []);
    byUserHp.get(hp).push(order);
  });

  // 회차 시작 시각. 아래 조회 루프들이 이 예산을 함께 나눠 쓴다.
  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > SYNC_TIME_BUDGET_MS;
  let skippedForTime = 0;

  const infoBySlip = new Map();
  const userHps = Array.from(byUserHp.keys());
  for (let i = 0; i < userHps.length; i += SYNC_CONCURRENCY) {
    if (outOfTime()) { skippedForTime += userHps.length - i; break; }
    const chunk = userHps.slice(i, i + SYNC_CONCURRENCY);
    await Promise.all(chunk.map(async (hp) => {
      try {
        const { orders: list } = await callmaner.orderHistory(branch, hp, { page: 1, pageSize: 50 });
        list.forEach((o) => { if (o.confSlip) infoBySlip.set(o.confSlip, o); });
      } catch (e) {
        logIntegrationErrorAsync({ source: 'callmaner', operation: 'order_history', refType: 'branch', refId: branch.id,
          message: e.message, context: { userHp: hp } });
      }
    }));
  }

  const infoByOrderId = new Map();
  const missing = [];
  orders.forEach((order) => {
    const found = infoBySlip.get(String(order.callmaner_conf_slip));
    if (found) infoByOrderId.set(order.id, found);
    else missing.push(order);
  });

  for (let i = 0; i < missing.length; i += SYNC_CONCURRENCY) {
    if (outOfTime()) { skippedForTime += missing.length - i; break; }
    const chunk = missing.slice(i, i + SYNC_CONCURRENCY);
    await Promise.all(chunk.map(async (order) => {
      try {
        infoByOrderId.set(order.id, await callmaner.orderInfo(branch, order.callmaner_conf_slip, order.origin_contact));
      } catch (e) {
        logIntegrationErrorAsync({ source: 'callmaner', operation: 'order_info', refType: 'order', refId: order.id,
          message: e.message, context: { confSlip: order.callmaner_conf_slip, oid: order.oid } });
      }
    }));
  }

  // 운행시작 판정용 보강 조회 — 목록조회(OrderHistory)는 baecha_status를 안 준다(응답에 아예
  // 없는 필드다, lib/callmaner.js orderHistory 참고). 그래서 콜마너가 '배차'라고 답한 오더만
  // 골라 단건조회(OrderInfo)를 한 번 더 부른다. 이미 로컬이 '운행시작'인 오더는 다시 안 부른다 —
  // 운행시작은 배차로 되돌아가지 않으므로 물어볼 필요가 없고, 그만큼 호출이 줄어든다.
  const needBaecha = orders.filter((order) => {
    const info = infoByOrderId.get(order.id);
    if (!info || info.status !== '배차') return false;
    if (order.status === STARTED_LOCAL_STATUS) return false;
    return info.baechaStatus === undefined; // 단건조회로 이미 받은 건은 값이 있다(빈 문자열 포함)
  });
  for (let i = 0; i < needBaecha.length; i += SYNC_CONCURRENCY) {
    // 운행시작 보강 조회는 없어도 상태는 '기사배정'으로 남는다(다음 회차에 다시 잡는다).
    // 시간이 없으면 여기부터 포기하는 것이 맞다.
    if (outOfTime()) { skippedForTime += needBaecha.length - i; break; }
    const chunk = needBaecha.slice(i, i + SYNC_CONCURRENCY);
    await Promise.all(chunk.map(async (order) => {
      try {
        const detail = await callmaner.orderInfo(branch, order.callmaner_conf_slip, order.origin_contact);
        // 목록조회로 받은 정보에 baecha_status만 얹는다(요금/기사명은 목록 값을 그대로 신뢰).
        const base = infoByOrderId.get(order.id) || {};
        infoByOrderId.set(order.id, { ...base, baechaStatus: detail.baechaStatus });
      } catch (e) {
        logIntegrationErrorAsync({ source: 'callmaner', operation: 'order_info_baecha', refType: 'order', refId: order.id,
          message: e.message, context: { confSlip: order.callmaner_conf_slip, oid: order.oid } });
      }
    }));
  }

  let updated = 0;
  // 이번 회차에 실제로 콜마너 응답을 받은 오더. 아래에서 확인 시각(callmaner_synced_at)을
  // 한꺼번에 찍는다.
  //
  // 왜 필요한가: 이 루프는 "바뀐 게 없으면 continue"라서, 상태가 그대로인 오더는 확인을 하고도
  // 확인 시각이 갱신되지 않았다. 그러면 위 ORDER BY(오래 확인 안 된 순)가 매분 같은 오더를
  // 다시 골라 순환이 돌지 않는다 — 상한을 넘는 순간 굶는 오더가 그대로 생긴다.
  //
  // 덤으로 '동기화 정지' 알림(lib/systemAlert.js)의 오탐도 사라진다. 지금은 상태가 안 바뀌면
  // 확인 시각이 멈춰 있어서, 조용한 시간대가 "멈춘 것"으로 보였다.
  const checkedIds = [];
  for (const order of orders) {
    const info = infoByOrderId.get(order.id);
    if (!info) continue;
    checkedIds.push(order.id);

    // 같은 응답에 요금(price)도 들어 있어 함께 맞춘다 — 요금 동기화는 원래 OrderAllStatus
    // 응답으로만 하고 있었는데 그 경로가 사실상 죽어 있어 한 번도 동작하지 않았다.
    if (info.price != null) {
      await syncFare(order, { charge: info.price }).catch((e) => console.error(`요금 동기화 실패 (conf_slip=${order.callmaner_conf_slip}):`, e.message));
    }

    // 기사 정보도 여기서 맞춘다. 예전에는 전체조회(OrderAllStatus) 경로에만 있었는데, 그 경로가
    // 사실상 죽어 있어(위 주석) 실제로는 대부분의 오더가 기사 이름·연락처 없이 남았다. 그 탓에
    // "기사님 연락처요"에 답하지 못했고, 배차 통보 문구의 기사 줄도 비어서 통째로 빠졌다.
    // OrderInfo는 wk_info("사번*이름")를 주고, 연락처는 WkContactSearch로 채운다 — 기사가
    // 배정됐는데 번호가 없으면 상태 표기와 무관하게 부른다(syncDriverInfo 주석 참고).
    await syncDriverInfo(
      branch,
      order,
      { wk_name: info.wkInfo, conf_slip: order.callmaner_conf_slip },
      info.status === '배차' ? '02' : null
    ).catch((e) => console.error(`기사정보 동기화 실패 (conf_slip=${order.callmaner_conf_slip}):`, e.message));

    const resolvedStatus = resolveLocalStatus(info);
    // 되돌림(운행시작 → 기사배정)은 매핑 결과를 버린다 — 콜마너 쪽 표기(callmaner_status)만
    // 갱신되도록 아래 else 분기로 흘려보낸다.
    const mappedStatus = isBackwardTransition(order.status, resolvedStatus) ? null : resolvedStatus;
    const note = resolvedStatus === STARTED_LOCAL_STATUS
      ? `[콜마너] 상태동기화(단건조회): ${info.status || '-'}(운행시작)`
      : `[콜마너] 상태동기화(단건조회): ${info.status || '-'}`;
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

      // 탁송사진은 상태가 운행시작/완료로 바뀐 그 순간에만 가져온다 — 매 폴링마다 부르면
      // 안 바뀐 오더에도 호출이 쌓인다. 정의서는 "탁송콜 완료시" 채워진다고 하므로 운행시작
      // 시점에는 아직 없을 수 있고(빈 응답), 그건 오류가 아니다.
      if (mappedStatus === STARTED_LOCAL_STATUS || mappedStatus === '완료') {
        const collected = await callmanerPhotos.collectPhotos(callmaner, branch, order)
          .catch((e) => {
            logIntegrationErrorAsync({
              source: 'callmaner', operation: 'cons_picture', refType: 'order', refId: order.id,
              message: e.message, context: { confSlip: order.callmaner_conf_slip, oid: order.oid, status: mappedStatus },
            });
            return null;
          });
        // 사진이 새로 들어왔을 때만 계기판을 읽는다 — 제미나이 호출이라 공짜가 아니다.
        // 통보는 이 값이 없어도 나가므로(주행거리 줄만 빠진다) 실패해도 동기화를 막지 않는다.
        if (collected && (collected.before || collected.after)) {
          await callmanerPhotos.syncOdometer(odometerOcr, branch, order)
            .catch((e) => console.error(`계기판 주행거리 동기화 실패 (oid=${order.oid}):`, e.message));
        }
      }
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

  // 확인 시각은 한 문장으로 몰아 찍는다 — 오더마다 UPDATE를 날리면 200건이면 분당 200번,
  // 하루 28만 번의 쓰기가 된다. 여기서는 분당 한 번이면 충분하다.
  //
  // 상태를 바꾼 오더는 위에서 이미 같은 값을 찍었지만 다시 찍어도 무해하다(같은 시각).
  if (checkedIds.length) {
    await db.run(
      `UPDATE orders SET callmaner_synced_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
       WHERE id = ANY(?)`,
      [checkedIds]
    ).catch((e) => console.error('확인 시각 갱신 실패(무시):', e.message));
  }

  if (skippedForTime) {
    // 조용히 넘어가면 안 된다 — 이 값이 계속 잡히면 상한을 낮추거나 콜마너 응답이 느려진 것이다.
    console.warn(`콜마너 동기화 시간 예산(${SYNC_TIME_BUDGET_MS}ms) 초과 — ${skippedForTime}건은 다음 회차로 미룸`);
    logIntegrationErrorAsync({
      source: 'callmaner', operation: 'sync_time_budget', refType: 'branch', refId: branch.id,
      message: `동기화 시간 예산 초과: ${skippedForTime}건을 다음 회차로 미룸`,
      context: { budgetMs: SYNC_TIME_BUDGET_MS, elapsedMs: Date.now() - startedAt, limit: SYNC_BY_CONF_SLIP_LIMIT, target: orders.length },
    });
  }
  return { checked: orders.length, updated, skippedForTime, elapsedMs: Date.now() - startedAt };
}

// 탁송사진이 실제로 열리기 시작한 시각을 재는 크론(30분 간격). 통보를 보내지 않는다 —
// 지연 분포를 실측하는 것이 목적이다(lib/photoAvailability.js 주석 참고).
router.get('/cron/photo-availability', checkCronAuth, asyncHandler(async (req, res) => {
  const result = await photoAvailability.checkPhotoAvailability();
  res.json(result);
}));

router.get('/sync', checkCronAuth, asyncHandler(async (req, res) => {
  const branches = await db.all('SELECT * FROM branches WHERE callmaner_enabled = true');
  const summary = [];

  for (const branch of branches) {
    try {
      const stateRow = await db.get('SELECT last_up_date FROM callmaner_sync_state WHERE branch_id = ?', [branch.id]);
      const lastUpDate = (stateRow && stateRow.last_up_date) || '0';

      // 이 호출이 실패해도 아래 단건조회는 반드시 돌아야 한다.
      //
      // 실제로 멈췄다(2026-08-24 발견): 저장된 커서가 하루를 넘기자 콜마너가 "날짜는 최대
      // 전날까지 가능합니다"로 거부했고, 던져진 예외가 같은 try를 빠져나가면서 아래
      // syncOrdersByConfSlip까지 건너뛰었다. 배차·운행시작·완료 감지와 통보가 7일간 전부
      // 멈춰 있었는데, 로그에는 매분 같은 오류 한 줄만 남아 있었다.
      //
      // 애초에 이 호출은 우리 접수건을 돌려주지 않는다(아래 주석) — 실제 감지는 단건조회가
      // 한다. 그러니 이쪽 실패는 기록만 하고 넘어가는 것이 맞다.
      const allStatus = await callmaner.orderAllStatus(branch, lastUpDate).catch((e) => {
        logIntegrationErrorAsync({
          source: 'callmaner', operation: 'order_all_status', refType: 'branch', refId: branch.id,
          message: e.message, context: { lastUpDate },
        });
        console.error(`전체 상태조회 실패(단건조회로 계속) (branch ${branch.id}):`, e.message);
        return null;
      });
      const orderList = (allStatus && allStatus.orderList) || [];
      const nextLastUpDate = (allStatus && allStatus.lastUpDate) || lastUpDate;

      let updated = 0;
      for (const item of orderList) {
        const confSlip = item.conf_slip;
        if (!confSlip) continue;
        const order = await db.get('SELECT * FROM orders WHERE branch_id = ? AND callmaner_conf_slip = ?', [branch.id, confSlip]);
        if (!order) continue;

        const statusCode = item.status_code;
        const codeStatus = callmaner.STATUS_CODE_TO_LOCAL_STATUS[statusCode];
        // 이 경로(OrderAllStatus)에는 baecha_status가 없어 운행시작을 알 수 없다 — 그래서
        // 02(배차)를 그대로 매핑하면 이미 운행시작인 오더를 기사배정으로 되돌린다. 아래
        // 단건조회 경로와 같은 가드를 둔다.
        const mappedStatus = isBackwardTransition(order.status, codeStatus) ? null : codeStatus;
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
      logIntegrationErrorAsync({ source: 'callmaner', operation: 'sync', refType: 'branch', refId: branch.id,
        message: e.message });
      summary.push({ branchId: branch.id, ok: false, error: e.message });
    }
  }

  // 상태를 막 갱신한 직후에 고객 통보까지 이어서 처리한다.
  //
  // 왜 여기서 또 부르나: 통보 크론(/kakao-consult/cron/order-notifications)도 매분 돌지만,
  // 두 크론이 각자 1분 주기라 "상태 감지 → 통보 발송" 사이에 최대 1분이 더 붙는다. 상태를
  // 방금 바꾼 이 자리에서 이어 부르면 그 한 홉이 사라진다(실측: 완료 통보가 상태변경 후
  // 2분 30초 걸렸고 그중 47초가 이 대기였다).
  //
  // 두 곳에서 부르지만 중복 발송은 나지 않는다 — sendDue가 FOR UPDATE SKIP LOCKED로 통보를
  // 원자적으로 집어가므로 한쪽만 가져간다(lib/kakaoOrderNotify.js claimDue).
  let notified = null;
  try {
    notified = await runKakaoOrderNotifications();
  } catch (e) {
    // 통보가 실패해도 동기화 자체는 성공으로 본다 — 통보는 크론이 1분 뒤 다시 시도한다.
    console.error('콜마너 동기화 후 통보 처리 실패:', e.message);
    notified = { error: e.message };
  }

  res.json({ ok: true, summary, notified });
}));

module.exports = router;
// 운행시작 판정과 되돌림 가드는 콜마너를 실제로 호출하지 않고 확인할 수 있어야 한다 —
// 되돌림 가드가 깨지면 고객에게 "배차되었습니다"가 매분 다시 나간다
// (scripts/check-callmaner-drive-started.js).
module.exports.resolveLocalStatus = resolveLocalStatus;
module.exports.isBackwardTransition = isBackwardTransition;
