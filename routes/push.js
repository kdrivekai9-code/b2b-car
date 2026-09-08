const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
// 통보 종류 목록·이름은 통보 모듈이 주인이다 — 화면에 따로 적으면 종류가 늘 때 갈린다.
const { EVENT_TYPES, DEFAULT_EVENT_SETTINGS } = require('../lib/kakaoOrderNotify');

const router = express.Router();
router.use(requireAuth);

router.get('/vapid-public-key', (req, res) => {
  res.type('text/plain').send(process.env.VAPID_PUBLIC_KEY || '');
});

router.get('/settings/data.json', asyncHandler(async (req, res) => {
  const branches = req.session.user.role === 'admin'
    ? await db.all('SELECT * FROM branches ORDER BY name')
    : [];
  res.json({ currentUser: req.session.user, branches });
}));

router.get('/settings', asyncHandler(async (req, res) => {
  const branches = req.session.user.role === 'admin' ? await db.all('SELECT * FROM branches ORDER BY name') : [];
  // 고객 화면이 종류별 체크박스를 그린다.
  res.render('push_settings', { title: '오더 알림 설정', branches, eventTypes: clientEventTypes() });
}));

// 이 브라우저의 구독 상태.
//
// effective를 함께 준다 — "구독이 있다"와 "알림이 실제로 온다"는 다르다. 오더 알림 설정에서
// 체크를 끄고 저장하면 구독은 남고 플래그만 0이 되는데, 사이드바 버튼은 브라우저 구독 유무만
// 보고 "🔔 알림 켜짐"이라고 적고 있었다(실사용 지적 2026-09-08: 두 곳이 다른 말을 한다).
// 판정을 서버에 두는 이유는 역할마다 기준이 다르기 때문이다 — 고객에게 의미 있는 칸은
// notify_order_events 하나뿐이고, 나머지는 애초에 고객에게 보내지 않는다(lib/push.js notify).
router.get('/status', asyncHandler(async (req, res) => {
  const { endpoint } = req.query;
  if (!endpoint) return res.json({ subscribed: false, effective: false });
  const sub = await db.get('SELECT * FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [endpoint, req.session.user.id]);
  res.json({ subscribed: !!sub, effective: isEffective(req.session.user, sub), sub: sub || null });
}));

// 고객이 고른 통보 종류를 저장 가능한 문자열로 만든다.
//
// 화면이 보낸 값을 그대로 믿지 않는다 — 아는 종류(EVENT_TYPES)만 남기고 정해진 순서로 담는다.
// 오타나 없어진 종류가 칸에 남으면 "왜 안 오지"를 데이터에서 읽을 수 없게 된다.
//
// 전부 고른 경우와 아무것도 안 고른 경우는 **모두 NULL**이다:
//  · 전부 = 고르지 않은 것과 같은 뜻이고, 종류가 늘어났을 때 새 종류까지 자동으로 받는다.
//  · 아무것도 = 그 상태는 notify_order_events=0(전체 끄기)으로 표현한다. 빈 문자열을 남기면
//    "전부 켜짐"으로 읽히는 규칙과 부딪친다(lib/push.js wantsEvent).
function sanitizeEventTypes(raw) {
  if (raw == null) return null;
  const list = (Array.isArray(raw) ? raw : String(raw).split(',')).map((v) => String(v).trim());
  const picked = EVENT_TYPES.filter((t) => list.includes(t));
  if (!picked.length || picked.length === EVENT_TYPES.length) return null;
  return picked.join(',');
}

// 고객이 고를 수 있는 통보 종류와 이름.
function clientEventTypes() {
  return EVENT_TYPES.map((key) => ({
    key,
    label: (DEFAULT_EVENT_SETTINGS[key] && DEFAULT_EVENT_SETTINGS[key].label) || key,
  }));
}

// 이 사용자에게 **실제로 알림이 갈 수 있는가**. 켜진 칸이 하나도 없으면 구독이 있어도 안 온다.
function isEffective(user, sub) {
  if (!sub) return false;
  const on = (v) => Number(v) === 1;
  if (user.role === 'client') return on(sub.notify_order_events);
  // 내부 사용자는 종류가 여럿이라 하나라도 켜져 있으면 "켜짐"이다.
  return ['notify_order_events', 'notify_driver_assign', 'notify_agent_call',
    'notify_system_alert', 'notify_plate_mismatch'].some((k) => on(sub[k]));
}

router.post('/subscribe', asyncHandler(async (req, res) => {
  const {
    endpoint, keys, notify_order_events, notify_driver_assign, notify_agent_call,
    notify_system_alert, notify_plate_mismatch, branch_id, event_types,
  } = req.body;
  if (!endpoint || !keys) return res.status(400).json({ error: 'invalid subscription' });
  // 컬럼과 플레이스홀더 수를 손으로 맞추지 않는다.
  //
  // 2026-08-29에 notify_plate_mismatch 컬럼이 추가될 때 컬럼 목록만 늘리고 VALUES의 물음표를
  // 안 늘려서(10개 컬럼 / 8개 물음표) 이 INSERT가 42601로 항상 실패했다 — 그날부터 **아무도
  // 웹푸시를 구독할 수 없었다.** 알림이 안 오는 것은 조용해서, 남아 있는 구독 3건이 전부
  // 2026-08-03 이전 것인 걸 세어보고서야 알았다.
  //
  // 컬럼을 배열로 두고 물음표를 그 길이에서 만든다. 다음에 알림 종류가 늘어도 한 곳만 고친다.
  const COLUMNS = [
    'user_id', 'endpoint', 'p256dh', 'auth', 'branch_id',
    'notify_order_events', 'notify_driver_assign',
    'notify_agent_call', 'notify_system_alert', 'notify_plate_mismatch',
    // 고객이 고른 통보 종류(쉼표로 이음). NULL이면 전부 — sanitizeEventTypes 주석 참고.
    'event_types',
  ];
  const assignments = COLUMNS.slice(1).filter((c) => c !== 'endpoint')
    .map((c) => `${c}=excluded.${c}`).join(', ');
  // 고객 구독에는 내부 알림 칸을 켜주지 않는다.
  //
  // 왜(실측 2026-09-08): 고객 설정 화면에는 체크박스가 하나뿐이라(내 오더 진행 알림) 나머지
  // 넷은 화면에서 요소를 못 찾고 true로 굳어 전송된다(views/push_settings.ejs,
  // src/app/push/settings/PushSettingsClient.js 모두 `? el.checked : true`). 그래서 고객
  // 구독은 상담원 호출·시스템 장애·번호판 상이·기사 배정이 전부 켜짐으로 저장돼 있었다.
  //
  // 발송 쪽에 역할 조건을 걸어 막았지만(lib/push.js notify), 데이터가 거짓말을 하는 상태를
  // 남겨두지 않는다 — 나중에 그 조건을 잊은 조회 하나가 다시 새게 만든다. 화면이 아니라
  // 서버에서 끊는 이유는 요청 본문을 만들어 보낼 수 있기 때문이다.
  const isClient = req.session.user.role === 'client';
  const internalOn = (v) => (isClient ? 0 : (v === false ? 0 : 1));

  await db.run(`
    INSERT INTO push_subscriptions (${COLUMNS.join(', ')})
    VALUES (${COLUMNS.map(() => '?').join(', ')})
    ON CONFLICT (endpoint) DO UPDATE SET ${assignments}
  `, [
    req.session.user.id, endpoint, keys.p256dh, keys.auth,
    // 고객은 지사 범위 알림 대상이 아니라 지사도 매지 않는다.
    isClient ? null : (branch_id || null),
    notify_order_events === false ? 0 : 1,
    internalOn(notify_driver_assign),
    internalOn(notify_agent_call),
    internalOn(notify_system_alert),
    internalOn(notify_plate_mismatch),
    sanitizeEventTypes(event_types),
  ]);
  res.json({ ok: true });
}));

router.post('/unsubscribe', asyncHandler(async (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) await db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [endpoint, req.session.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
