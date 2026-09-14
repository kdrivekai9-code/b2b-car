// 고객이 연도를 안 적었는데 우리가 **내년으로 민** 경우인지 알아낸다.
//
// 왜 필요한가: 고객은 "07/27"처럼 연도를 안 적는다(로그 전수에서 연도 표기 0건). 그 날짜가
// 올해 기준으로 이미 지났으면 내년으로 넘긴다 — 연말에 "1/3"이 들어오는 경우를 위한 처리다.
// 그런데 확인 문구에는 결과만 "2027-07-27"로 찍혀서, 읽는 사람은 그게 고객이 말한 값인지
// 우리가 민 값인지 알 수 없다. 실제로 그렇게 접수돼 1년 뒤 예약으로 콜마너까지 등록된 건이
// 있다(OID2075, 2026-09-07).
//
// lib/intakeSummary.js는 그 경고를 붙일 준비가 되어 있고(reservedYearGuessed), 카카오 경로는
// fromParsed가 파서의 when.dateRolled를 실어줘서 잘 나온다. **웹 챗봇만 빠져 있었다** —
// 그 경로는 Gemini가 연도까지 정해서 내려주므로 "밀었다"는 신호 자체가 없다(모델 지시문은
// 오늘 날짜만 알려주고, 연도를 추정했는지는 돌려받지 않는다). 그래서 결과로 되짚는다.
//
// 판단: **연도를 안 적었는데 결과가 올해가 아니면** 우리가 정한 것이다. 어느 파서가 그
// 날짜를 만들었는지와 무관하게 성립하므로 Gemini 경로와 규칙 파서 경로에 모두 쓸 수 있다.
//
// 막지는 않는다 — 몇 달 뒤 차량을 미리 잡는 일이 실제로 있다. 다만 "네"라고 답하기 전에
// 보이게는 해야 한다.
//
// DB에 닿지 않는다.
const { kstNow } = require('./period');

// 연도를 적어준 표기. 이게 있으면 우리가 추정한 것이 없다.
// (lib/kakaoIntakeParser.js EXPLICIT_YEAR_RE와 같은 취지 — 네 자리 연도 + 구분자)
const EXPLICIT_YEAR_RE = /(\d{4})\s*(?:[-./]|년)/;
// 고객이 직접 밝힌 상대 표기. "내년 3월"은 고객이 내년이라고 말한 것이라 추정이 아니다 —
// 여기에 경고를 붙이면 "연도를 안 적으셔서"가 사실과 다른 말이 된다.
const EXPLICIT_RELATIVE_YEAR_RE = /내년|명년|다음\s*해/;

function reservedYearGuessed(text, reservedDate) {
  const raw = String(text || '');
  const date = String(reservedDate || '').trim();
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(date);
  if (!m) return false;
  if (EXPLICIT_YEAR_RE.test(raw) || EXPLICIT_RELATIVE_YEAR_RE.test(raw)) return false;
  return Number(m[1]) !== kstNow().getUTCFullYear();
}

module.exports = { reservedYearGuessed };
