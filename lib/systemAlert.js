// 시스템 장애 알림 — 로그에만 쌓이고 아무도 모르는 상태를 없앤다.
//
// 왜 만들었나(실측): 2026-08-19 ~ 08-24에 콜마너 동기화 오류가 7,737건 쌓였다. 그동안 배차·
// 운행시작·완료 감지와 고객 통보가 7일간 멈춰 있었는데, 매분 같은 오류 한 줄이 로그에 남을 뿐
// 아무도 몰랐다. 요금이 안 나가거나 통보가 안 가는 실패는 조용해서 더 위험하다.
//
// 감시 대상 세 가지:
//   A. 연동 오류 급증  — 같은 곳에서 오류가 몰아친다
//   B. 동기화 백로그   — 1분 배치 상한에 근접해 오더 확인이 밀리기 시작한다
//   C. 동기화 정지     — 확인할 오더가 있는데 아무것도 갱신되지 않는다(위 7일 사고가 이것)
//   D. 고착 오류       — 같은 오류가 몰아치지 않고 **꾸준히** 계속된다
//
// D를 따로 두는 이유(2026-09-01 실측): 세션 저장소가 1시간 30분 동안 모든 요청을 500으로
// 만들었는데 A(급증)에 걸리지 않았다. 실패가 콘솔로만 나갔던 것이 1차 원인이지만, 기록이
// 남았더라도 A는 못 잡는다 — 같은 실패를 매 요청 기록하면 DB를 더 밀어붙이므로 분당 한 줄로
// 줄여 남기는데(lib/sessionStore.js), 그러면 10분에 10건이라 임계 20건에 영원히 못 닿는다.
// 크기로 잡는 신호와 **길이로 잡는 신호**는 다른 축이다.
const db = require('../db');
const appSettings = require('./appSettings');
const { notify } = require('./push');

// KST 문자열 시각. integration_errors.created_at / orders.callmaner_synced_at 이 모두 text라
// 같은 형식으로 만들어 문자열 비교한다(타입 캐스팅은 다른 곳에서 충돌을 냈다).
function kstStringMinutesAgo(minutes) {
  const now = new Date(Date.now() + 9 * 3600 * 1000 - minutes * 60 * 1000);
  return now.toISOString().slice(0, 19).replace('T', ' ');
}

// 동기화가 실제로 보는 대상과 **같은 조건**이어야 한다.
//
// 처음엔 "미완료 콜마너 오더 전부"로 셌는데, 그러면 조회 대상에서 이미 빠진 오래된 오더까지
// 세어 알림이 영원히 울린다(실측: 3일보다 오래된 미완료 오더 28건 때문에 '동기화 정지'가
// 곧바로 오탐으로 걸렸다). 동기화는 최근 N일 안에 접수된 건만 보므로 그 창을 그대로 쓴다.
const SYNC_LOOKBACK_DAYS = Number(process.env.CALLMANER_SYNC_LOOKBACK_DAYS || 3);
const SYNC_TARGET_SQL = `callmaner_conf_slip IS NOT NULL
        AND status NOT IN ('완료', '취소')
        AND created_at >= ?`;

function syncLookbackSince() {
  return kstStringMinutesAgo(SYNC_LOOKBACK_DAYS * 24 * 60);
}

const SETTINGS = {
  errorWindowMin: ['alert_error_window_min', 10, 1, 1440],
  errorThreshold: ['alert_error_threshold', 20, 1, 100000],
  cooldownMin: ['alert_cooldown_min', 60, 1, 10080],
  // 배치 상한의 몇 %에서 알릴지. 80%면 아직 밀리기 전이라 손 쓸 시간이 있다.
  backlogPercent: ['alert_sync_backlog_percent', 80, 10, 100],
  // 확인할 오더가 있는데 이만큼 갱신이 없으면 멈춘 것으로 본다. 크론이 1분 주기라
  // 15분이면 15번 연속 실패한 셈이다 — 일시적 오류로 보기 어렵다.
  stalledMin: ['alert_sync_stalled_min', 15, 2, 1440],
  // 시간 예산 초과는 회차당 최대 1건만 기록되므로(지사당 1건) 일반 오류 임계(20건)에는
  // 영원히 안 걸린다. 3건 = 3분 연속 초과라면 일시적 지연이 아니다.
  timeBudgetThreshold: ['alert_sync_time_budget_threshold', 3, 1, 1000],
  // 같은 오류가 이만큼 이어지면 일시적 실패가 아니다. 15분이면 재시도로 풀릴 것은 이미 풀렸다.
  stuckMin: ['alert_error_stuck_min', 15, 3, 1440],
  // 지속 시간만으로 판정하면 우연히 15분 간격으로 두 번 난 오류가 걸린다. 최소 건수를 함께 본다.
  stuckMinCount: ['alert_error_stuck_min_count', 3, 2, 1000],
  // 얼마나 거슬러 올라가 "언제부터였나"를 셀지. 이 값이 곧 **보고할 수 있는 지속 시간의 상한**이다.
  // 좁게 잡으면 90분짜리 장애도 29분으로 보이고, 그러면 아래 상향 규칙(2배마다 재알림)이
  // 창 끝에서 멈춰 장기 장애를 잊는다. 6시간이면 15→30→60→120→240분으로 다섯 번 울린다.
  stuckWindowMin: ['alert_error_stuck_window_min', 360, 30, 10080],
};

async function loadSettings() {
  const out = {};
  await Promise.all(Object.entries(SETTINGS).map(async ([name, [key, fallback, min, max]]) => {
    out[name] = await appSettings.getNumber(key, fallback, { min, max }).catch(() => fallback);
  }));
  return out;
}

// ── A. 연동 오류 급증 ───────────────────────────────────────────────────────
async function checkErrorSpikes(cfg) {
  const since = kstStringMinutesAgo(cfg.errorWindowMin);
  const rows = await db.all(
    `SELECT source, COALESCE(operation, '-') AS operation, COUNT(*) AS c, MAX(message) AS sample
       FROM integration_errors
      WHERE created_at >= ?
      GROUP BY source, COALESCE(operation, '-')
     HAVING COUNT(*) >= ?
      ORDER BY COUNT(*) DESC`,
    [since, cfg.errorThreshold]
  ).catch(() => []);

  return (rows || []).map((r) => ({
    key: `error:${r.source}:${r.operation}`,
    value: Number(r.c),
    title: `⚠️ ${r.source} 오류 ${r.c}건`,
    body: `${cfg.errorWindowMin}분 사이 ${r.operation}에서 ${r.c}건 — ${String(r.sample || '').slice(0, 80)}`,
    url: '/integration-errors',
  }));
}

// ── B. 동기화 백로그 ────────────────────────────────────────────────────────
// 1분마다 확인할 수 있는 건수(배치 상한)보다 대상이 많아지면, 넘치는 만큼 오더 확인이
// 다음 차례로 밀린다 — 배차 감지와 고객 통보가 그만큼 늦어진다.
async function checkSyncBacklog(cfg, syncLimit) {
  const row = await db.get(
    `SELECT COUNT(*) AS c FROM orders WHERE ${SYNC_TARGET_SQL}`,
    [syncLookbackSince()]
  ).catch(() => null);
  if (!row) return [];

  const count = Number(row.c) || 0;
  const threshold = Math.ceil(syncLimit * (cfg.backlogPercent / 100));
  if (count < threshold) return [];

  const over = count > syncLimit;
  return [{
    key: 'sync:backlog',
    value: count,
    title: over ? `🚨 동기화가 밀리고 있습니다 (${count}건)` : `⚠️ 동기화 배치 한계 근접 (${count}건)`,
    body: over
      ? `진행 중 오더 ${count}건 / 1분 배치 상한 ${syncLimit}건 — 초과분은 다음 차례로 밀려 배차 감지와 고객 통보가 늦어집니다.`
      : `진행 중 오더 ${count}건 / 1분 배치 상한 ${syncLimit}건. 상한을 올리거나(CALLMANER_SYNC_ORDER_LIMIT) 정리가 필요합니다.`,
    url: '/orders',
  }];
}

// ── 죽은 상담원 접속행 청소 ────────────────────────────────────────────────
// 정리는 새 연결이 들어올 때 스스로 한다(lib/realtimeChat.js). 다만 아무도 상담 화면을 열지
// 않는 기간에는 그 청소가 돌지 않으므로, 5분마다 도는 이 크론이 안전망을 한 겹 더 둔다.
//
// 알림을 보내지는 않는다 — 쌓인 행은 장애가 아니라 찌꺼기다. 사람을 깨울 일이 아니다.
async function sweepStalePresence() {
  const r = await db.run(
    "DELETE FROM chat_agent_presence WHERE last_seen_at < now() - interval '5 minutes'"
  ).catch((e) => {
    console.error('죽은 상담원 접속행 정리 실패(무시):', e.message);
    return null;
  });
  const removed = r && typeof r.rowCount === 'number' ? r.rowCount : 0;
  if (removed) console.log(`죽은 상담원 접속행 ${removed}건 정리`);
  return removed;
}

// ── B-2. 동기화 시간 예산 초과 ──────────────────────────────────────────────
// 콜마너 응답이 느려져 한 회차 안에 대상을 다 못 본 상태. 건수(백로그)와는 다른 신호다 —
// 오더가 몇 건 없어도 콜마너가 느리면 여기가 걸린다. 방치하면 조회가 계속 밀린다.
async function checkSyncTimeBudget(cfg) {
  const since = kstStringMinutesAgo(cfg.errorWindowMin);
  const row = await db.get(
    `SELECT COUNT(*) AS c, MAX(message) AS sample
       FROM integration_errors
      WHERE source = 'callmaner' AND operation = 'sync_time_budget' AND created_at >= ?`,
    [since]
  ).catch(() => null);
  if (!row) return [];
  const count = Number(row.c) || 0;
  if (count < cfg.timeBudgetThreshold) return [];

  return [{
    key: 'sync:time_budget',
    value: count,
    title: `⚠️ 콜마너 동기화가 시간 안에 못 끝납니다 (${count}회)`,
    body: `${cfg.errorWindowMin}분 사이 ${count}회 — ${String(row.sample || '').slice(0, 80)}. 콜마너 응답이 느려졌거나 대상이 너무 많습니다.`,
    url: '/integration-errors',
  }];
}

// ── D. 고착 오류 ────────────────────────────────────────────────────────────
// 같은 오류가 "계속되고 있는" 상태. 급증(A)이 크기를 보는 신호라면 이쪽은 길이를 본다.
//
// 판정: 같은 곳·같은 메시지가 stuckMin 분 전부터 있었고(MIN), 지금도 나고 있다(MAX).
// 둘 다 봐야 한다 — MIN만 보면 이미 끝난 옛 오류가 계속 걸리고, MAX만 보면 방금 한 번 난
// 오류가 걸린다. 메시지 앞 80자로 묶는 이유는 오더 번호 같은 꼬리가 붙어도 같은 장애로
// 세기 위해서다.
async function checkStuckErrors(cfg) {
  const windowStart = kstStringMinutesAgo(Math.max(cfg.stuckWindowMin, cfg.stuckMin + 10));
  const startedBefore = kstStringMinutesAgo(cfg.stuckMin);
  // "지금도 나고 있다"의 기준. 크론이 5분 주기라 그보다 짧게 잡으면 크론 사이에 난 오류를 놓친다.
  const stillRecent = kstStringMinutesAgo(6);

  const rows = await db.all(
    `SELECT source, COALESCE(operation, '-') AS operation, LEFT(message, 80) AS sample,
            COUNT(*) AS c, MIN(created_at) AS first_at
       FROM integration_errors
      WHERE created_at >= ?
      GROUP BY source, COALESCE(operation, '-'), LEFT(message, 80)
     HAVING MIN(created_at) <= ? AND MAX(created_at) >= ? AND COUNT(*) >= ?
      ORDER BY MIN(created_at) ASC`,
    [windowStart, startedBefore, stillRecent, cfg.stuckMinCount]
  ).catch(() => []);

  return (rows || []).map((r) => {
    const minutes = Math.round((Date.now() - new Date(String(r.first_at).replace(' ', 'T') + '+09:00').getTime()) / 60000);
    return {
      key: `stuck:${r.source}:${r.operation}`,
      // 값은 건수가 아니라 **지속 분**이다. 쿨다운의 "2배면 다시 알린다"가 길어질수록
      // 다시 울리는 규칙이 되어, 안 풀리는 장애를 잊지 않게 한다.
      value: Number.isFinite(minutes) && minutes > 0 ? minutes : cfg.stuckMin,
      title: `🚨 ${r.source} 오류가 계속되고 있습니다`,
      body: `${r.operation}에서 같은 오류가 ${Number.isFinite(minutes) ? minutes : cfg.stuckMin}분째 반복 중(${r.c}건) — ${String(r.sample || '').slice(0, 80)}`,
      url: '/integration-errors',
    };
  });
}

// ── C. 동기화 정지 ──────────────────────────────────────────────────────────
// 확인할 오더가 있는데 아무것도 갱신되지 않는 상태. 7일간 통보가 멈췄던 사고가 정확히 이것이라,
// 오류 건수가 아니라 "결과가 없다"는 사실로 잡아야 한다(그 사고에서는 오류도 함께 났지만,
// 조용히 0건만 돌려주는 실패도 있을 수 있다).
async function checkSyncStalled(cfg) {
  const pending = await db.get(
    `SELECT COUNT(*) AS c FROM orders WHERE ${SYNC_TARGET_SQL}`,
    [syncLookbackSince()]
  ).catch(() => null);
  if (!pending || Number(pending.c) === 0) return [];

  const since = kstStringMinutesAgo(cfg.stalledMin);
  const fresh = await db.get(
    `SELECT COUNT(*) AS c FROM orders
      WHERE callmaner_conf_slip IS NOT NULL AND callmaner_synced_at >= ?`,
    [since]
  ).catch(() => null);
  if (!fresh || Number(fresh.c) > 0) return [];

  return [{
    key: 'sync:stalled',
    value: Number(pending.c),
    title: '🚨 콜마너 동기화가 멈춘 것 같습니다',
    body: `진행 중 오더 ${pending.c}건이 있는데 ${cfg.stalledMin}분간 상태 갱신이 한 건도 없습니다. 배차·완료 감지와 고객 통보가 멈춰 있을 수 있습니다.`,
    url: '/integration-errors',
  }];
}

// ── 쿨다운 ──────────────────────────────────────────────────────────────────
// 같은 장애로 매분 알림이 오면 사람은 알림을 꺼버리고, 그러면 다음 장애를 놓친다.
// 다만 규모가 크게 뛰면(2배 이상) 쿨다운 중이라도 다시 알린다 — 악화는 새 소식이다.
async function shouldSend(alert, cooldownMin) {
  const prev = await db.get('SELECT * FROM system_alert_state WHERE alert_key = ?', [alert.key]).catch(() => null);
  if (!prev) return true;
  const elapsedMin = (Date.now() - new Date(prev.last_sent_at).getTime()) / 60000;
  if (elapsedMin >= cooldownMin) return true;
  const prevValue = Number(prev.last_value) || 0;
  return prevValue > 0 && alert.value >= prevValue * 2;
}

async function recordSent(alert, sentTo) {
  await db.run(
    `INSERT INTO system_alert_state (alert_key, last_sent_at, last_value, last_title, send_count)
     VALUES (?, now(), ?, ?, 1)
     ON CONFLICT (alert_key) DO UPDATE SET
       last_sent_at = now(),
       last_value = excluded.last_value,
       last_title = excluded.last_title,
       send_count = system_alert_state.send_count + 1`,
    [alert.key, alert.value, alert.title]
  );
  await db.run(
    'INSERT INTO system_alert_log (alert_key, title, body, value, sent_to) VALUES (?, ?, ?, ?, ?)',
    [alert.key, alert.title, alert.body, alert.value, sentTo]
  );
}

// 장애가 해소되면 상태를 지운다 — 안 지우면 다음에 같은 장애가 나도 쿨다운에 걸려 조용하다.
async function clearResolved(activeKeys) {
  const rows = await db.all('SELECT alert_key FROM system_alert_state').catch(() => []);
  const stale = (rows || []).map((r) => r.alert_key).filter((k) => !activeKeys.includes(k));
  for (const key of stale) {
    await db.run('DELETE FROM system_alert_state WHERE alert_key = ?', [key]).catch(() => {});
  }
  return stale;
}

// 크론이 부른다. 반환값은 화면·검사에서 무엇이 걸렸는지 확인하는 용도다.
async function runChecks(options = {}) {
  const cfg = await loadSettings();
  const syncLimit = Number(options.syncLimit || process.env.CALLMANER_SYNC_ORDER_LIMIT || 500);
  const send = options.send || notify;

  // 알림 판정 전에 찌꺼기를 치운다 — 판정 결과에는 영향이 없고, 5분마다 도는 이 크론이
  // 청소를 걸어둘 가장 자연스러운 자리다.
  const sweptPresence = await sweepStalePresence();

  const alerts = [
    ...await checkErrorSpikes(cfg),
    ...await checkSyncBacklog(cfg, syncLimit),
    ...await checkSyncTimeBudget(cfg),
    ...await checkSyncStalled(cfg),
    ...await checkStuckErrors(cfg),
  ];

  const sent = [];
  const skipped = [];
  for (const alert of alerts) {
    if (!await shouldSend(alert, cfg.cooldownMin).catch(() => true)) { skipped.push(alert.key); continue; }
    const subs = await db.all('SELECT COUNT(*) AS c FROM push_subscriptions WHERE notify_system_alert = 1')
      .catch(() => [{ c: 0 }]);
    try {
      await send({
        branchId: null, eventType: 'system_alert', excludeUserId: 0,
        title: alert.title, body: alert.body, url: alert.url,
      });
    } catch (e) {
      // 발송이 실패해도 감지 결과는 남긴다 — 알림이 안 왔다는 사실 자체가 단서다.
      console.error('장애 알림 발송 실패:', e.message);
    }
    await recordSent(alert, Number((subs[0] || {}).c) || 0).catch((e) => console.error('알림 기록 실패:', e.message));
    sent.push(alert.key);
  }

  const resolved = await clearResolved(alerts.map((a) => a.key)).catch(() => []);
  return { checked: alerts.length, sent, skipped, resolved, sweptPresence, config: cfg, syncLimit };
}

module.exports = {
  runChecks, sweepStalePresence, checkErrorSpikes, checkSyncBacklog, checkSyncTimeBudget, checkSyncStalled,
  checkStuckErrors,
  shouldSend, loadSettings, kstStringMinutesAgo, SETTINGS,
};
