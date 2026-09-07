// 예약일이 상식적인 범위인가.
//
// 왜 필요한가(실측 2026-09-07): OID2075가 오늘 접수되면서 예약일이 2027-09-08로 저장됐다.
// 날짜 칸에 연도를 잘못 고른 것인데, 아무도 막지 않아 그대로 콜마너까지 등록됐다
// (conf_slip 182353721). 오더 리스트에는 멀쩡히 보이니 접수된 줄 알지만,
// "오늘·내일 예약 콜"에는 안 잡히고 그 날짜가 올 때까지 아무도 모른다.
//
// 막지는 않는다. 몇 달 뒤 출고 예정 차량을 미리 잡는 일이 실제로 있고, 우리가 그 판단을
// 대신할 수는 없다. 대신 눈에 띄게 만든다 — 접수할 때 한 번 되묻고, 목록에서 표시한다.
//
// 지난 날짜도 같이 본다. 오타로 작년을 고르면 그 오더는 조회에서 영영 안 나온다.

// 이보다 먼 미래는 되묻는다. 90일이면 분기 하나라, 정상적인 사전 예약은 대부분 들어온다.
const FAR_FUTURE_DAYS = 90;

// 지난 날짜는 **아주 멀 때만** 본다.
//
// 처음엔 하루만 봐줬는데, 실제 데이터에서 진행 중 오더 200건 중 38건이 걸렸다. 전부 경과일
// 8~48일이었다 — 예약일이 지났는데 아직 완료 안 된 **밀린 오더**지 잘못 입력한 게 아니다.
// 그런 것까지 표시하면 목록이 느낌표로 뒤덮이고, 그러면 정작 오타 한 건이 묻힌다.
//
// 연도를 잘못 고르면 1년쯤 어긋난다. 180일로 가르면 그건 잡고 밀린 오더는 안 잡는다.
// 밀린 오더는 별개의 문제라 별개로 다뤄야 한다(상태·기간 필터가 이미 그 일을 한다).
const PAST_LIMIT_DAYS = 180;

function toDate(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, dd] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(y, mo - 1, dd));
  if (Number.isNaN(d.getTime())) return null;
  // 2026-13-45 같은 값은 Date가 다음 해로 굴려버린다 — 그대로 두면 "1년 뒤 예약"으로 잡혀
  // 엉뚱한 경고가 나간다. 날짜가 아닌 것은 날짜가 아니라고 해야 다른 검증이 제 일을 한다.
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== dd) return null;
  return d;
}

// KST 기준 오늘. 서버가 UTC로 돌아도 한국 날짜로 판단해야 한다.
function todayKst(now) {
  const t = now ? new Date(now) : new Date();
  const kst = new Date(t.getTime() + 9 * 3600 * 1000);
  return new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()));
}

// { ok, reason, days } — ok가 false면 되물을 거리다. 판단만 하고 막지는 않는다.
function checkReservedDate(reservedDate, now) {
  const d = toDate(reservedDate);
  if (!d) return { ok: true, reason: null, days: 0 }; // 형식이 아니면 다른 검증이 잡는다
  const today = todayKst(now);
  const days = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (days < -PAST_LIMIT_DAYS) return { ok: false, reason: 'past', days };
  if (days > FAR_FUTURE_DAYS) return { ok: false, reason: 'far_future', days };
  return { ok: true, reason: null, days };
}

// 사람에게 보여줄 한 줄. 연도를 함께 적는다 — 이 사고의 원인이 연도였고, "9월 8일"만
// 보여주면 무엇이 이상한지 안 보인다.
function describe(reservedDate, now) {
  const r = checkReservedDate(reservedDate, now);
  if (r.ok) return null;
  if (r.reason === 'past') {
    return `예약일이 지난 날짜입니다(${reservedDate}, ${Math.abs(r.days)}일 전). 연도를 확인해주세요.`;
  }
  return `예약일이 ${r.days}일 뒤입니다(${reservedDate}). 연도를 확인해주세요.`;
}

module.exports = { checkReservedDate, describe, FAR_FUTURE_DAYS, PAST_LIMIT_DAYS };
