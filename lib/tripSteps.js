// 기사 운행 단계 — 화면에 깔 순서와, 지금 누를 수 있는 단계.
//
// 왜 미리 다 깔아두나: 기사는 "다음에 무엇을 해야 하는지"를 버튼 하나로만 보면 알 수 없다.
// 경유지가 둘이면 대기·재출발이 두 번씩 있는데, 그걸 모르고 운행완료를 먼저 누르면
// 되돌릴 방법이 없다. 전체 사슬을 보여주고 그중 하나만 누를 수 있게 한다.
//
// 오더 상태(orders.status)는 건드리지 않는다. 배차 상태의 주인은 콜마너다(사용자 확정 규칙:
// 배차·알림톡은 콜마너 그대로). 여기 기록은 "기사가 언제 무엇을 했나"이고, 콜마너가 주는
// 상태값과 별개로 남는다 — 섞으면 콜마너 동기화가 우리 기록을 덮어쓴다.
const STEP_KEYS = ['origin_arrived', 'drive_started', 'waypoint_wait', 'waypoint_resume', 'trip_completed'];

// 경유지가 하나면 번호를 붙이지 않는다("경유지 대기"). 여럿일 때만 "경유지1 대기"처럼
// 번호를 붙인다 — 하나뿐인데 1번이라고 하면 두 번째가 있는 줄 알게 된다.
function waypointLabel(seq, total, tail) {
  return total > 1 ? `경유지${seq} ${tail}` : `경유지 ${tail}`;
}

// 경유지 개수에 따라 사슬을 만든다.
// 출발지 도착 → 운행 시작 → (경유지N 대기 → 운행 시작) × N → 운행 완료
function buildChain(waypointCount) {
  const n = Math.max(0, Math.floor(Number(waypointCount) || 0));
  const chain = [
    { key: 'origin_arrived', seq: 0, label: '출발지 도착' },
    { key: 'drive_started', seq: 0, label: '운행 시작' },
  ];
  for (let i = 1; i <= n; i += 1) {
    chain.push({ key: 'waypoint_wait', seq: i, label: waypointLabel(i, n, '대기') });
    // 경유지에서 다시 출발하는 것도 기사에게는 같은 "운행 시작"이다. 다른 말을 쓰면
    // 같은 동작에 두 이름이 생긴다.
    chain.push({ key: 'waypoint_resume', seq: i, label: '운행 시작' });
  }
  chain.push({ key: 'trip_completed', seq: 0, label: '운행 완료' });
  return chain;
}

function rowKey(step) { return `${step.key}#${step.seq}`; }

// 기록된 단계를 사슬에 얹는다.
//
// active(지금 누를 수 있는 단계)는 **아직 안 누른 첫 단계 하나뿐이다.** 건너뛰기를 허용하면
// 대기시간이 계산되지 않고(대기 시작이 없으니), 순서가 뒤집힌 기록은 나중에 아무도 못 읽는다.
function decorate(chain, rows, now) {
  const done = new Map();
  (rows || []).forEach((r) => {
    done.set(`${r.step_key}#${Number(r.seq) || 0}`, r);
  });

  let activeFound = false;
  const steps = chain.map((step) => {
    const row = done.get(rowKey(step));
    const isDone = !!row;
    const active = !isDone && !activeFound;
    if (active) activeFound = true;
    return {
      key: step.key,
      seq: step.seq,
      label: step.label,
      done: isDone,
      active,
      at: row ? String(row.occurred_at || '') : null,
      waitMinutes: row && row.wait_minutes != null ? Number(row.wait_minutes) : null,
    };
  });

  // 경유지에서 대기 중이면(대기는 눌렀고 재출발은 아직) 지금까지 몇 분인지 화면이 세어 보여준다.
  const waiting = steps.find((s) => s.key === 'waypoint_resume' && s.active);
  const waitStart = waiting
    ? (done.get(`waypoint_wait#${waiting.seq}`) || {}).occurred_at || null
    : null;

  return {
    steps,
    // 전부 눌렀으면 active가 없다 — 화면은 "운행 완료"만 남기고 버튼을 잠근다.
    allDone: steps.every((s) => s.done),
    waitingSeq: waiting ? waiting.seq : null,
    waitingSince: waitStart ? String(waitStart) : null,
    waitingMinutes: waitStart ? minutesBetween(waitStart, now) : null,
  };
}

// 두 시각 사이의 분. 형식이 어긋나면 null — 억지로 0을 만들면 "대기 0분"이 기록돼 실제로
// 안 기다린 것과 구분이 안 된다.
//
// 저장된 값은 KST 벽시계 문자열이고 호출부가 넘기는 now는 진짜 Date다. 둘을 그대로 빼면
// 9시간 어긋난다 — 실제로 그랬다(스펙이 잡았다: 23분 전으로 돌려놨는데 화면은 "대기 0분",
// 음수가 Math.max로 0에 눌렸다). 어느 쪽이 오든 KST 벽시계로 맞춘 뒤 뺀다.
function minutesBetween(from, to) {
  const a = toKstMoment(from);
  const b = toKstMoment(to);
  if (!a || !b) return null;
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000));
}

// Date(진짜 시각) → KST 벽시계를 UTC로 인코딩한 Date. 문자열은 이미 그 형태라 그대로 판다.
function toKstMoment(value) {
  if (value instanceof Date) return new Date(value.getTime() + 9 * 3600 * 1000);
  return parseKst(value);
}

function parseKst(value) {
  if (value instanceof Date) return value;
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
}

// 이 단계를 지금 누를 수 있는가. 서버가 다시 판정한다 — 화면이 오래된 상태로 보내거나
// 두 화면에서 동시에 누르는 경우가 있어, 화면 판단만 믿으면 순서가 깨진 기록이 남는다.
function canTake(chain, rows, stepKey, seq) {
  const view = decorate(chain, rows, new Date());
  const target = view.steps.find((s) => s.key === stepKey && s.seq === (Number(seq) || 0));
  if (!target) return { ok: false, error: '이 오더에 없는 단계입니다.' };
  if (target.done) return { ok: false, error: '이미 기록된 단계입니다.' };
  if (!target.active) {
    const next = view.steps.find((s) => s.active);
    return { ok: false, error: next ? `먼저 "${next.label}"을 눌러주세요.` : '모든 단계가 끝났습니다.' };
  }
  return { ok: true, step: target };
}

// KST 'YYYY-MM-DD HH:MM:SS'. DB의 now()는 UTC라 그대로 쓰면 9시간 어긋난다.
function kstStamp(now) {
  const t = now instanceof Date ? now : new Date();
  return new Date(t.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = { STEP_KEYS, buildChain, decorate, canTake, minutesBetween, kstStamp, parseKst, toKstMoment };
