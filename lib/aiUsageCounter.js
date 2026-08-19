// AI 사용량을 세고, 지금 얼마나 썼는지 돌려준다.
//
// 왜 직접 세나: express-rate-limit의 기본 저장소는 프로세스 메모리라 서버리스에서 인스턴스마다
// 따로 산다(마이그레이션 20260819010000 주석 참조). 한 곳에 모아 세야 한도가 설정한 대로
// 동작하고, 관리자가 "지금 얼마나 쓰고 있는지"도 볼 수 있다.
//
// 비용: 요청당 쿼리 한 번(분·시간 두 창을 한 문장으로 처리한다). 이 미들웨어가 지키는 요청은
// 뒤에서 Gemini를 3초쯤 부르므로, 그 앞의 작은 UPSERT 하나는 문제가 되지 않는다.
const db = require('../db');

const UNDEFINED_TABLE = '42P01';
// 지난 창은 화면에도 안 쓰고 판정에도 안 쓴다 — 하루쯤 지나면 지운다.
const RETENTION_HOURS = 24;
// 매 요청마다 정리하면 그게 더 비싸다 — 가끔만 한다.
const CLEANUP_PROBABILITY = 0.01;

function subjectOf(req) {
  const userId = req.session && req.session.user && req.session.user.id;
  if (userId) return `u:${userId}`;
  // IPv6는 주소 하나하나가 아니라 대역으로 묶어야 한다(개별 주소는 무한히 바꿀 수 있다).
  const ip = String(req.ip || 'unknown');
  return `ip:${ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip}`;
}

function cleanupSoon() {
  if (Math.random() > CLEANUP_PROBABILITY) return;
  db.run(`DELETE FROM ai_rate_usage WHERE window_start < now() - interval '${RETENTION_HOURS} hours'`)
    .catch((e) => console.error('AI 사용량 카운터 정리 실패:', e.message));
}

// 한 번 쓴 것으로 세고, 분·시간 각각의 현재 값을 돌려준다.
// 실패하면(테이블 없음 등) null — 호출부는 "셀 수 없으면 통과"로 처리한다. 사용량 집계 하나
// 때문에 챗봇이 멈추면 안 된다.
async function hit(subject) {
  const rows = await db.all(
    `INSERT INTO ai_rate_usage (subject, window_kind, window_start, count)
     VALUES (?, 'minute', date_trunc('minute', now()), 1),
            (?, 'hour',   date_trunc('hour',   now()), 1)
     ON CONFLICT (subject, window_kind, window_start)
     DO UPDATE SET count = ai_rate_usage.count + 1
     RETURNING window_kind, count`,
    [subject, subject]
  ).catch((e) => {
    if (e && e.code === UNDEFINED_TABLE) return null;
    console.error('AI 사용량 카운터 기록 실패:', e.message);
    return null;
  });
  if (!rows) return null;
  cleanupSoon();
  const byKind = new Map(rows.map((r) => [r.window_kind, Number(r.count) || 0]));
  return { minute: byKind.get('minute') || 0, hour: byKind.get('hour') || 0 };
}

// 화면에 보여줄 현재 사용량. 지금 창(이번 분·이번 시간)만 본다.
// 계정 이름을 같이 붙인다 — 'u:12'만 보여주면 누구인지 알 수 없다.
async function currentUsage({ limit = 20 } = {}) {
  const rows = await db.all(
    `SELECT r.subject, r.window_kind, r.count
       FROM ai_rate_usage r
      WHERE (r.window_kind = 'minute' AND r.window_start = date_trunc('minute', now()))
         OR (r.window_kind = 'hour'   AND r.window_start = date_trunc('hour',   now()))`
  ).catch((e) => {
    if (e && e.code === UNDEFINED_TABLE) return [];
    console.error('AI 사용량 조회 실패:', e.message);
    return [];
  });

  const bySubject = new Map();
  rows.forEach((r) => {
    const cur = bySubject.get(r.subject) || { subject: r.subject, minute: 0, hour: 0 };
    cur[r.window_kind] = Number(r.count) || 0;
    bySubject.set(r.subject, cur);
  });

  const userIds = [...bySubject.keys()]
    .filter((s) => s.startsWith('u:'))
    .map((s) => Number(s.slice(2)))
    .filter(Number.isFinite);
  let names = new Map();
  if (userIds.length) {
    const placeholders = userIds.map(() => '?').join(',');
    const users = await db.all(
      `SELECT id, login_id, name FROM users WHERE id IN (${placeholders})`, userIds
    ).catch(() => []);
    names = new Map(users.map((u) => [Number(u.id), `${u.name || ''}(${u.login_id})`.trim()]));
  }

  return [...bySubject.values()]
    .map((r) => ({
      ...r,
      label: r.subject.startsWith('u:')
        ? (names.get(Number(r.subject.slice(2))) || `사용자 #${r.subject.slice(2)}`)
        : `비로그인 ${r.subject.slice(3)}`,
    }))
    // 이번 시간 사용량이 많은 순 — 한도에 가까운 쪽을 먼저 보여준다.
    .sort((a, b) => b.hour - a.hour || b.minute - a.minute)
    .slice(0, limit);
}

module.exports = { subjectOf, hit, currentUsage, RETENTION_HOURS };
