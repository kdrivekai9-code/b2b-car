// 지나간 날짜로 예약하려 할 때 되묻기.
//
// 왜 필요한가: 카카오 폼에는 연도가 없다(고객 메시지 141건 전수에서 연도 표기 0건). 파서는
// 올해로 채우고, 그 날짜가 지났으면 내년으로 넘긴다(lib/kakaoIntakeParser.js parseFormDate).
// 12월 말에 "1/3"이 들어오는 경우를 위한 처리다.
//
// 그런데 그 규칙은 9월에 온 "07/27"도 2027-07-27로 만든다. 그렇게 등록돼 콜마너까지 나간
// 건이 있다(OID2075, 2026-09-07). 밀린 것을 확인 문구에 밝히는 것만으로는 부족하다 —
// 고객은 자기가 적은 날짜가 그대로 있는 줄 알고 "네"를 누른다. 지난 날짜면 등록하기 전에
// 되묻는 것이 맞다.
//
// 어디까지 되묻나: **밀린 결과가 상식적인 범위 안이면 그냥 쓴다.** 12/28에 "1/3"은 6일
// 뒤가 되고, 그건 고객이 말한 그대로다. 되물으면 정상적인 연말 요청마다 대화가 한 턴
// 늘어난다. 범위 기준은 오더 목록의 '!' 표시와 같은 값을 쓴다(lib/reservationSanity.js
// FAR_FUTURE_DAYS) — 목록이 이상하다고 표시할 날짜를 우리가 말없이 만들지는 않는다는 뜻이다.
//
// 연도를 적어준 지난 날짜(2025-07-27)도 되묻는다. 이건 추정이 아니라 명시라 밀지 않고
// 그대로 두는데, 그대로 등록하면 조회에서 영영 안 나온다.
const { FAR_FUTURE_DAYS, checkReservedDate } = require('./reservationSanity');
const { parseFormDate, parseFormTime } = require('./kakaoIntakeParser');

function todayKst(now) {
  const t = now ? new Date(now) : new Date();
  const kst = new Date(t.getTime() + 9 * 3600 * 1000);
  return new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()));
}

function daysFromToday(date, now) {
  const m = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.round((d - todayKst(now).getTime()) / 86400000);
}

// { ask, reason, date, days } — ask가 true면 등록 전에 되물어야 한다.
// reason: 'rolled_far'(연도가 없어 내년으로 밀렸고 그 결과가 너무 먼 미래) / 'past'(지난 날짜)
function needsDateReask(when, now) {
  // "즉시"는 날짜가 아니라 "지금"이다 — resolveReservation이 오늘로 되돌리므로 물을 것이 없다.
  if (!when || when.immediate || !when.date) return { ask: false, reason: null, date: null, days: null };
  const days = daysFromToday(when.date, now);
  if (days === null) return { ask: false, reason: null, date: null, days: null };

  if (when.dateRolled) {
    if (days > FAR_FUTURE_DAYS) return { ask: true, reason: 'rolled_far', date: when.date, days };
    return { ask: false, reason: null, date: when.date, days };
  }
  if (days < 0) return { ask: true, reason: 'past', date: when.date, days };
  // 연도를 적어준 먼 미래도 되묻는다.
  //
  // 예전에는 밀린 경우(dateRolled)와 지난 날짜만 봤다. 그래서 연도가 **적혀 있는** 먼 미래는
  // 그대로 통과했다 — 실사용에서 "2027-07-27"이 확인 화면까지 올라갔고, 고객이 그 자리에서
  // "2026년 9월 8일로 바꿔줘"라고 했는데도 원문의 2027이 그대로 남았다(그 수정이 안 먹은 것은
  // 별도 문제 — lib/intakeCorrection.js 참고).
  //
  // 목록에서 '!'로 표시할 날짜를 등록 전에 묻지도 않는 것은 앞뒤가 안 맞는다. 같은 기준
  // (FAR_FUTURE_DAYS)을 쓰므로, 표시될 날짜는 반드시 한 번 확인을 거친다.
  //
  // 거절이 아니라 확인이다 — 90일 뒤 예약은 실제로 있을 수 있다. 한 번 되묻고 그대로면 진행한다.
  if (days > FAR_FUTURE_DAYS) return { ask: true, reason: 'far', date: when.date, days };
  return { ask: false, reason: null, date: when.date, days };
}

function dateText(date) {
  const m = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일` : String(date || '');
}

// 되묻는 문구. 고객은 날짜를 이미 적었다고 생각하므로 "항목이 없습니다"가 아니라 "지났습니다,
// 다시 알려주세요"로 물어야 대화가 겉돌지 않는다(형식 어긋난 차량번호를 물을 때와 같은 원칙,
// lib/kakaoIntakeParser.js buildMissingQuestion).
function buildDateQuestion(info, when) {
  const said = when && when.raw ? String(when.raw).trim() : '';
  const saidLine = said ? `말씀하신 일시: ${said}\n` : '';
  if (info.reason === 'past') {
    return `${saidLine}${dateText(info.date)}은 이미 지난 날짜입니다.\n예약일시를 다시 알려주세요.\n(예: ${exampleDate()} 14시)`;
  }
  // 연도를 적어준 먼 미래 — 틀렸다고 단정하지 않고 확인만 받는다. 그대로 다시 말하면 진행된다.
  if (info.reason === 'far') {
    return `${saidLine}${dateText(info.date)}은 오늘부터 ${info.days}일 뒤입니다. 연도가 맞는지 확인 부탁드립니다.\n`
      + `맞으면 그대로 다시 알려주시고, 아니면 예약일시를 알려주세요.\n(예: ${exampleDate()} 14시)`;
  }
  // 밀린 경우 — 우리가 연도를 추정했다는 사실까지 밝힌다. 고객은 올해로 말한 것이다.
  return `${saidLine}적어주신 날짜는 올해 기준으로 이미 지났습니다. 연도를 안 적어주셔서 ${dateText(info.date)}로 봤는데, ${Math.abs(info.days)}일 뒤라 확인이 필요합니다.\n예약일시를 다시 알려주세요.\n(예: ${exampleDate()} 14시)`;
}

// 예시는 늘 미래여야 한다 — 굳은 날짜를 적어두면 언젠가 "지난 날짜"를 예시로 드는 문구가 된다.
function exampleDate(now) {
  const d = new Date(todayKst(now).getTime() + 3 * 86400000);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`;
}

// 되묻기에 대한 답 해석 — { ok:true, when } 또는 { ok:false, reason:'unparsed'|'still_past' }.
// 원문을 고쳐 다시 파싱하지 않고 when만 갈아끼운다. 등록 경로는 저장해둔 parsed를 그대로
// 쓰므로(createOrdersFromIntake) 이것으로 충분하고, 원문에 남은 옛 날짜 줄이 다시 읽혀
// 되묻기가 무한히 도는 일도 없다.
function applyDateAnswer(when, answerText, now) {
  const text = String(answerText || '');
  const parsedDate = parseFormDate(text);
  if (!parsedDate || !parsedDate.date) return { ok: false, reason: 'unparsed' };

  const days = daysFromToday(parsedDate.date, now);
  // 답에서도 지난 날짜가 나오면(연도를 적어 과거를 지정한 경우) 그대로 받지 않는다.
  if (days !== null && days < 0) return { ok: false, reason: 'still_past', date: parsedDate.date };
  // 답이 또 밀렸고 그 결과가 너무 먼 미래면 아직 확정된 게 아니다 — 한 번 더 묻는다.
  if (parsedDate.rolled && days !== null && days > FAR_FUTURE_DAYS) {
    return { ok: false, reason: 'still_past', date: parsedDate.date };
  }

  const time = parseFormTime(text);
  return {
    ok: true,
    when: {
      immediate: false,
      date: parsedDate.date,
      // 확정했으므로 추정 표시를 지운다 — 확인 문구에 "내년으로 봤습니다"가 남으면 안 된다.
      dateRolled: false,
      time: time || (when && when.time) || null,
      raw: text.trim() || (when && when.raw) || null,
    },
  };
}

// 답을 못 알아들었을 때. 같은 질문을 그대로 반복하면 고객은 무엇이 문제인지 모른다.
function buildRetryQuestion(result) {
  if (result.reason === 'still_past') {
    return `${dateText(result.date)}도 지난 날짜입니다.\n연도까지 함께 알려주시면 정확합니다.\n(예: ${exampleDate()} 14시 / 2027-01-05 14시)`;
  }
  return `날짜를 알아듣지 못했습니다.\n예약일시를 다시 알려주세요.\n(예: ${exampleDate()} 14시)`;
}

module.exports = {
  needsDateReask, buildDateQuestion, applyDateAnswer, buildRetryQuestion,
  // 검사·테스트용
  daysFromToday, checkReservedDate,
};
