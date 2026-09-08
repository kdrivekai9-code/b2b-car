// 모델에게 넘길 대화 이력을 날짜 경계에서 끊는다.
//
// 왜 필요한가(실사용 2026-09-08): 카카오에서 "내일 예약건 보여줘"가 0건으로 나왔다. 그때
// 모델이 본 창(마지막 10개)을 그대로 재현해보니 이랬다.
//
//   2026-09-07 10:22  user 그럼 내일 예약한콜은?
//   2026-09-07 10:22  bot  내일 예약된 주문은 없습니다.
//   2026-09-08 11:56  user 내일 예약건 보여줘        ← 이번 질문
//
// 창이 **날짜 경계를 넘었다.** 카카오 세션은 안 닫히니 어제 대화가 바로 앞에 붙어 있고,
// 거기엔 글자가 거의 같은 질문이 있다. 그런데 09-07의 "내일"은 09-08이고 09-08의 "내일"은
// 09-09다 — 말은 같고 뜻이 다르다. 모델은 바로 위의 같은 문답을 보고 답을 그대로 가져왔다.
//
// 창 크기 문제가 아니다. 웹은 창이 12개로 더 넓은데도 멀쩡했다 — 방문마다 세션이 새로 열려
// 창 안이 전부 오늘 것이었기 때문이다. 그래서 "몇 개"가 아니라 "언제 것"으로 끊는다.
//
// 자정을 갓 넘긴 대화까지 자르지는 않는다. 23:55에 묻고 00:05에 이어 묻는 사람은 같은 대화를
// 하는 중이고, 거기서 앞 turn을 버리면 맥락이 끊긴다. 그래서 **오늘 것이거나, 최근 2시간 안**
// 이면 남긴다. 이번 사고처럼 25시간 벌어진 경우는 어느 조건에도 안 걸린다.
const RECENT_MINUTES = 120;

// chat_messages.created_at은 **text**이고 KST 벽시계가 그대로 들어 있다('2026-09-08 12:04:33').
// timestamptz가 아니다. 이 저장소에는 시각을 text로 담는 컬럼이 여럿 있으니(orders.created_at도
// 같다) 시각을 다룰 때마다 무슨 타입인지 확인해야 한다.
//
// 그 문자열을 new Date()에 넘기지 않는다. 시간대 표기가 없는 문자열을 Date가 어떻게 읽을지는
// 실행 환경에 달렸고(로컬은 KST, Vercel은 UTC), '+00'처럼 짧은 오프셋이 붙으면 아예 Invalid
// Date가 된다 — 그러면 이 함수는 "판단 불가"로 전부 남겨서 창을 끊지 못한다. 벽시계 문자열은
// 벽시계로 비교한다.
//
// Date 객체나 timestamptz가 들어오는 호출자도 있을 수 있어 그쪽은 KST 벽시계로 바꿔서 받는다.
function toKstWallClock(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(value.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  }
  const s = String(value === null || value === undefined ? '' : value).trim();
  // 'YYYY-MM-DD HH:MM(:SS)' — 이미 KST 벽시계다. 그대로 쓴다.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return s.replace('T', ' ').slice(0, 19);
  // 시간대가 붙은 문자열('...+00')은 Date에 맡긴다.
  const t = new Date(s);
  if (Number.isNaN(t.getTime())) return null;
  return new Date(t.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

// 벽시계 문자열 둘의 차이(분). 양쪽 모두 같은 방식으로 읽으므로 시간대 보정이 더 필요 없다.
function wallDiffMinutes(a, b) {
  const pa = Date.parse(`${a.replace(' ', 'T')}Z`);
  const pb = Date.parse(`${b.replace(' ', 'T')}Z`);
  if (Number.isNaN(pa) || Number.isNaN(pb)) return null;
  return (pa - pb) / 60000;
}

function kstDate(value) {
  const w = toKstWallClock(value);
  return w ? w.slice(0, 10) : null;
}

// rows: [{ sender, message, created_at }] — created_at이 없거나 못 읽는 행은 남긴다.
// 판단할 수 없다고 버리면 있는 맥락이 사라진다. 버리는 쪽은 확실할 때만.
function trimToConversationDay(rows, now) {
  const nowWall = toKstWallClock(now ? new Date(now) : new Date());
  if (!nowWall) return rows || [];
  const today = nowWall.slice(0, 10);
  return (rows || []).filter((row) => {
    if (!row || row.created_at === undefined || row.created_at === null) return true;
    const wall = toKstWallClock(row.created_at);
    if (!wall) return true;
    if (wall.slice(0, 10) === today) return true;
    const mins = wallDiffMinutes(nowWall, wall);
    return mins === null || mins <= RECENT_MINUTES;
  });
}

module.exports = { trimToConversationDay, kstDate, toKstWallClock, RECENT_MINUTES };
