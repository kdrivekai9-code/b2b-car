// 상담원 도우미 — 상담원이 응대 중인 세션에서 봇이 답변 초안을 만들어 "채택 대기"로 쌓는다.
//
// 왜 필요한가: 상담원이 붙으면 봇이 완전히 꺼지는데, 상담톡 로그 분석상 상담원 발화의 86%가
// 정형(접수 확인 17.2%, 배차 통보 6.1%, 사진 61.6%)이다. 즉 봇이 답을 이미 아는 구간에서
// 사람이 손으로 치고 있었다. 자동 발송은 오응대 위험 때문에 못 켜지만, 사람이 승인하는
// 초안이라면 그 위험이 없다.
//
// 설계 원칙 — **확신이 없으면 침묵한다.** 틀린 제안이 반복되면 상담원이 카드를 아예 안 보게
// 되고, 그 순간 이 기능은 죽는다. 그래서 근거가 분명한 두 종류만 만든다.
//   intake : 접수 폼이 파싱된 경우(룰 파서, 실사용 재생 98.2%) — 접수 확인 문구 + 접수장 슬롯
//   faq    : 지식베이스 유사도가 임계값을 넘은 경우 — 그 답변 원문
// 그 외(잡담·현장 조율·클레임)는 제안하지 않는다.
const { parseKakaoIntake, buildParsedFromClassified, buildMissingQuestion } = require('./kakaoIntakeParser');
const { searchKnowledgeBase } = require('./knowledgeSearch');
const { resolveReservation } = require('./kakaoIntakeService');
const { quoteFareByAddress } = require('./fareQuote');
const { describeOperatingHours } = require('./operatingHoursInfo');
const { previewIntakeAddresses } = require('./intakeAddressPreview');
// 접수 요약은 등록 후 통보·웹 접수 화면과 같은 모듈이 만든다.
const { buildSummaryText, fromParsed } = require('./intakeSummary');
const { classifyAndExtract } = require('./hybridChat');

// 봇이 직접 응대할 때보다 임계값을 높게 잡는다 — 상담원이 이미 보고 있는 화면이라, 애매한
// 제안은 도움이 아니라 소음이다.
const FAQ_THRESHOLD = 0.72;

// 요금 문의는 지식베이스로 풀 게 아니라 실제 요금표로 계산해야 한다 — "사당역에서 반포역까지
// 얼마"에 맞는 KB 항목은 존재할 수 없다(거리마다 답이 다르다). 오더 등록 화면이 쓰는 것과 같은
// 계산(주소→좌표→경로거리→지사 구간요금표)을 서버에서 돌려 금액을 뽑는다.
const FARE_QUESTION_RE = /(요금|얼마|비용|가격|견적|단가)/;

// 어느 상품을 묻는지. 겹치는 낱말이 있어 **좁은 것부터** 본다 —
// "일일기사"에는 대리가 없지만 "법인대리"에는 대리가 있어서, 순서를 뒤집으면 일일기사 질문이
// 프리미엄으로 잡힌다.
const DAILY_DRIVER_RE = /(일일\s*기사|하루\s*(종일|단위)|종일)/;
const PREMIUM_RE = /(대리|프리미엄)/;
const DISPATCH_RE = /탁송/;
function askedProduct(raw) {
  const t = String(raw || '');
  if (DAILY_DRIVER_RE.test(t)) return 'daily_driver';
  if (PREMIUM_RE.test(t)) return 'premium';
  if (DISPATCH_RE.test(t)) return 'dispatch';
  return null; // 구분이 없다 — 탁송으로 답하고 다른 상품을 안내한다
}
// 일일기사는 "일일기사"라는 말 없이 대리 계열로만 물어도 시간을 함께 말하면 그쪽이다 —
// "대리 8시간 얼마예요?"는 편도 대리가 아니라 시간제다.
const DAILY_PROXY_RE = /(일일\s*대리|하루\s*대리|데일리\s*대리)/;

// base_hours는 numeric이라 5, 5.5, 5.00 이 다 올 수 있다 — "5.00시간"으로 안내하지 않는다.
function formatHours(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return `${Number.isInteger(v) ? v : Number(v.toFixed(1))}시간`;
}

// ---- 일일기사 요금 — **경로가 아니라 이용 시간이 입력이다** ----
//
// 탁송·프리미엄대리는 출발·도착이 있어야 금액이 나오지만 일일기사는 시간만 있으면 나온다.
// 그래서 이 흐름은 구간 추출(extractRoute)보다 **앞에** 있어야 한다 — 뒤에 두면 "일일기사
// 8시간 얼마예요?"가 "출발지·도착지를 못 찾았다"로 떨어져 답이 안 나간다.
//
// 실측(2026-09-09): 프로덕션 고객 챗봇(EJS 위젯)은 이 질문에 "일일대리기사 요금 문의는 현재
// 설계 준비 중입니다"라고 답하고 있었다. 요금표(premium_fare_rules / group_daily_driver_fare_rules)는
// 이미 등록돼 있는데 안내만 없었다.

// "8시간", "8시간 30분", "8시간반", "여덟시간"은 안 본다(숫자만) — 한글 수사는 오탐이 많고,
// 실사용 표현이 대부분 숫자다. 분은 시간으로 환산한다(요금표가 소수 시간을 받는다).
const USE_HOURS_RE = /(\d+(?:\.\d+)?)\s*시간(?:\s*(반|(\d+)\s*분))?/;
function parseUseHours(raw) {
  const m = USE_HOURS_RE.exec(String(raw || ''));
  if (!m) return null;
  let hours = Number(m[1]);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  if (m[2] === '반') hours += 0.5;
  else if (m[3]) hours += Number(m[3]) / 60;
  // 하루는 24시간을 넘을 수 없다 — "100시간"은 시간이 아니라 다른 숫자를 잘못 읽은 것이다.
  if (hours > 24) return null;
  return Math.round(hours * 100) / 100;
}

// 시간을 못 받았을 때 되묻는 문장. **상수로 둔다** — 호출부(웹 엔드포인트)가 "방금 이 질문을
// 했는가"로 다음 답을 해석하므로, 문구가 갈리면 그 판단이 조용히 깨진다.
const DAILY_DRIVER_HOURS_QUESTION = '몇 시간 이용하실 예정인지 알려주시면 계산해 드립니다. (예: 8시간)';

// 등록된 구간표를 문장으로. 숫자를 코드에 박지 않는다 — 관리자가 표를 바꾸면 안내도 바뀐다.
function describeDailyDriverTiers(daily) {
  const tiers = (daily.tiers && daily.tiers.length) ? daily.tiers : [{
    baseHours: daily.baseHours, baseFare: daily.baseFare, extraPerHour: daily.extraPerHour,
  }];
  return tiers.map((t) => `· ${formatHours(t.baseHours)} ${formatWon(t.baseFare)}`
    + (t.extraPerHour ? ` (초과 시 시간당 ${formatWon(t.extraPerHour)})` : ''));
}

// 일일기사 요금 답변. hours가 null이면 표를 알려주고 시간을 묻는다.
async function buildDailyDriverFareAnswer({ groupId, branchId, hours }) {
  const policy = require('./branchPolicy');
  const daily = await policy.describeDailyDriverFare(groupId, branchId)
    .catch((e) => { console.error('일일기사 요금 조회 실패:', e.message); return { enabled: false }; });
  if (!daily.enabled) {
    return {
      kind: 'fare',
      text: ['일일기사는 요금 정보가 등록되어 있지 않습니다.', '상담원에게 연결해 드릴까요?'].join('\n'),
      intake: null,
      fare: null,
      offerAgent: true,
    };
  }

  if (hours == null) {
    return {
      kind: 'fare',
      text: ['일일기사 요금은 이용 시간 기준입니다.', ...describeDailyDriverTiers(daily), DAILY_DRIVER_HOURS_QUESTION].join('\n'),
      intake: null,
      fare: null,
      // 호출부가 다음 답을 "시간"으로 받을 수 있게 알린다.
      awaitingHours: true,
    };
  }

  const quote = await policy.calculatePremiumFare(branchId, hours, { groupId })
    .catch((e) => { console.error('일일기사 요금 계산 실패:', e.message); return { enabled: false }; });
  if (!quote.enabled) {
    return {
      kind: 'fare',
      text: ['일일기사는 요금 정보가 등록되어 있지 않습니다.', '상담원에게 연결해 드릴까요?'].join('\n'),
      intake: null, fare: null, offerAgent: true,
    };
  }

  const lines = [`일일기사 ${formatHours(hours)} 예상 요금은 ${formatWon(quote.fare)}입니다.`];
  // **왜 그 금액인지 밝힌다.** 기준 시간보다 짧게 쓰는데도 기준요금이 그대로 나오면(3시간을
  // 물어도 5시간 요금) 설명 없이는 과청구로 보인다.
  if (quote.extraHours > 0) {
    lines.push(`(기준 ${formatHours(quote.baseHours)} ${formatWon(quote.baseFare)}`
      + ` + 초과 ${formatHours(quote.extraHours)} × ${formatWon(quote.extraPerHour)})`);
  } else if (hours < quote.baseHours) {
    lines.push(`(기준 ${formatHours(quote.baseHours)} ${formatWon(quote.baseFare)} — 기준 시간 미만도 기준요금으로 청구됩니다)`);
  } else {
    lines.push(`(기준 ${formatHours(quote.baseHours)} ${formatWon(quote.baseFare)})`);
  }
  lines.push('※ 차종·시간대·현장 상황에 따라 최종 요금은 달라질 수 있습니다.');
  return {
    kind: 'fare',
    text: lines.join('\n'),
    intake: null,
    // 일일기사는 경로가 없다 — 거리·도선 칸은 비운다(없는 값을 0으로 채우면 "계산했는데
    // 0km"로 읽힌다).
    fare: { total: quote.fare, hours, orderType: 'daily_driver', fareSource: quote.fareSource || null },
  };
}

// 운영시간도 같은 이유로 지식베이스에 두지 않는다 — 지사가 시간을 바꾸면 KB 문구는 조용히
// 낡는데, operating_hours에는 항상 최신값이 있고 오더 등록이 이미 그 값으로 접수를 막는다.
// "언제까지 하나요", "몇 시까지 해요" 같은 표현도 함께 잡는다.
const HOURS_QUESTION_RE = /(운영\s*시간|영업\s*시간|고객센터\s*시간|몇\s*시까지|언제까지\s*(하|영업|운영)|휴무|주말에?\s*(도|하나요|되나요)|공휴일에?\s*(도|하나요|되나요))/;

function formatWon(n) {
  return Number(n).toLocaleString('ko-KR') + '원';
}

// "사당역에서 반포역까지 탁송요금은?" 같은 문장에서 구간을 뽑는다.
// classifyAndExtract는 요금 문의를 faq로 분류하고 주소를 채우지 않으므로(접수 의도일 때만
// 추출한다) 여기서 직접 본다. 조사가 분명해 규칙으로 충분하고, LLM보다 빠르고 싸다.
const ROUTE_RE = /([가-힣A-Za-z0-9()·\-]+(?:\s+[가-힣A-Za-z0-9()·\-]+){0,5}?)\s*(?:에서|부터)\s*([가-힣A-Za-z0-9()·\-]+(?:\s+[가-힣A-Za-z0-9()·\-]+){0,5}?)\s*(?:까지|으로|로)/;

function extractRoute(raw) {
  const m = ROUTE_RE.exec(String(raw || ''));
  if (!m) return null;
  const clean = (v) => String(v || '').trim().replace(/^(그리고|또|저기|혹시)\s*/, '');
  const from = clean(m[1]);
  const to = clean(m[2]);
  if (!from || !to) return null;
  return { from, to };
}

async function buildFareSuggestion(raw, options) {
  const opts = options || {};
  const groupIdEarly = opts.groupId || null;
  const branchIdEarly = opts.branchId || null;

  // **일일기사는 경로가 아니라 이용 시간이 입력이다** — 구간 추출보다 앞에서 처리한다.
  //
  // 두 가지 경로로 들어온다:
  //   (1) 질문 자체가 일일기사다 — "일일기사 8시간 얼마예요?", "일일대리 요금"
  //   (2) 직전 턴에 우리가 시간을 물었고 이번 답이 그 시간이다 — "8시간이요"
  //       그 답에는 요금 낱말이 없어서 아래 관문(FARE_QUESTION_RE)에 걸리지 않는다.
  //       호출부가 awaitingDailyDriverHours로 알려준다.
  const t = String(raw || '');
  if (opts.awaitingDailyDriverHours) {
    const hours = parseUseHours(t);
    // 시간으로 못 읽으면 이 흐름이 아니다 — 조용히 삼키지 않고 기존 경로로 넘긴다.
    if (hours != null) return buildDailyDriverFareAnswer({ groupId: groupIdEarly, branchId: branchIdEarly, hours });
  }

  // 요금 문의가 아니면 곧바로 접는다 — 이 함수를 직접 부르는 경로(봇 응대·웹 위젯)에서
  // 무관한 질문에 LLM 추출이 도는 걸 막는다.
  if (!FARE_QUESTION_RE.test(t)) return null;

  // 일일기사 계열이면 여기서 끝난다. "대리 8시간 얼마"처럼 대리로 물었어도 시간이 함께 오면
  // 시간제를 묻는 것이다 — 편도 대리에는 이용 시간 개념이 없다.
  const askedHours = parseUseHours(t);
  const isDailyDriverAsk = askedProduct(t) === 'daily_driver'
    || DAILY_PROXY_RE.test(t)
    || (PREMIUM_RE.test(t) && askedHours != null);
  if (isDailyDriverAsk) {
    return buildDailyDriverFareAnswer({ groupId: groupIdEarly, branchId: branchIdEarly, hours: askedHours });
  }

  const route = extractRoute(raw);

  // **프리미엄대리를 구간 없이 물었을 때.**
  //
  // 이 상품은 편도 거리 기준이라 출발·도착이 없으면 금액이 안 나온다. 그렇다고 아무 답도 안
  // 하면(예전 동작) "법인대리 요금 얼마예요?"가 통째로 FAQ 검색으로 새서 "관련된 답변을 찾지
  // 못했습니다"로 끝났다 — 요금표가 등록돼 있든 아니든 고객은 아무것도 못 받았다.
  //
  // 요금표가 없으면 그 사실을 밝히고 상담원을 제안하고(사용자 확정 문구), 있으면 구간을 묻는다.
  if (!route && askedProduct(t) === 'premium') {
    const policy = require('./branchPolicy');
    // 거리 0으로 물어 "표가 등록돼 있는지"만 본다 — 금액은 쓰지 않는다.
    const table = await policy.calculatePremiumOnewayFare(groupIdEarly, branchIdEarly, 0)
      .catch(() => ({ enabled: false }));
    if (!table.enabled) {
      return {
        kind: 'fare',
        text: ['프리미엄대리(법인)는 요금 정보가 등록되어 있지 않습니다.', '상담원에게 연결해 드릴까요?'].join('\n'),
        intake: null, fare: null, offerAgent: true,
      };
    }
    return {
      kind: 'fare',
      text: ['법인대리(프리미엄) 요금은 편도 거리 기준입니다.', '출발지와 도착지를 알려주시면 계산해 드립니다.'].join('\n'),
      intake: null, fare: null,
    };
  }
  // 호출부가 이미 분류를 돌렸으면 그 결과를 그대로 쓴다 — 같은 문장에 LLM을 두 번 태우면
  // 응답이 3초 넘게 늘어난다(구간 없는 "요금조회 되나요?"에서 실제로 그랬다).
  let extracted = (options && options.extracted) || null;
  if (!route && !extracted) {
    // 규칙으로 못 잡고 분류 결과도 없을 때만 LLM 추출을 시도한다(상담원 초안 경로).
    try {
      extracted = await classifyAndExtract(raw, null, null);
    } catch (e) {
      console.error('상담원 도우미 요금문의 분석 실패:', e.message);
      return null;
    }
  }
  const from = route ? route.from : String((extracted && extracted.originAddress) || '').trim();
  const to = route ? route.to : String((extracted && extracted.destinationAddress) || '').trim();
  // 출발/도착이 다 잡히지 않으면 계산할 수 없다 — 되묻는 초안도 만들지 않는다(상담원이 이미
  // 화면을 보고 있어서, 애매한 카드는 도움이 아니라 소음이다).
  if (!from || !to) return null;

  const quote = await quoteFareByAddress({
    originAddress: from,
    destinationAddress: to,
    branchId: (options && options.branchId) || null,
    groupId: (options && options.groupId) || null,
    vehicleType: (extracted && extracted.vehicleType) || '',
    reservedDate: (extracted && extracted.reservationDate) || null,
    reservedTime: (extracted && extracted.reservationTime) || null,
  });
  if (!quote.ok) return null;

  // 요금을 고객에게 보여주지 않는 지사 설정이면 초안을 만들지 않는다 — 이 카드는 상담원이
  // 승인하면 그대로 고객에게 나간다.
  if (quote.fare && quote.fare.visibleToClient === false) return null;

  // 표시는 고객이 말한 원문("사당역")을 쓴다 — 지오코딩 결과는 "서울 동작구 남부순환로 지하 2089"
  // 처럼 나와서, 고객에게 그대로 보내면 오히려 어느 곳인지 알아보기 어렵다.
  const lines = [`${quote.origin.query} → ${quote.destination.query}`];

  // **어느 상품의 요금인지 밝히고, 그 상품의 표로 계산한다.**
  //
  // 실사용(2026-09-08): "사당역에서 판교역까지 요금이 얼마에요?"에 금액만 답했더니 고객이
  // 곧바로 "탁송요금이나요?"라고 되물었다 — 화면이 답해야 할 것을 고객이 물어야 했다.
  //
  // 세 상품의 청구 기준이 다르다:
  //   탁송            거리 구간   fare_rules / group_fare_rules
  //   법인대리(프리미엄) 거리 구간   premium_oneway_fare_rules / group_premium_oneway_fare_rules
  //   일일기사         이용 시간   premium_fare_rules(이름 함정) / group_daily_driver_fare_rules
  //
  // 그래서 출발·도착만으로 금액이 나오는 것은 앞의 둘이다. 일일기사는 시간을 받아야 한다 —
  // 거리를 시간으로 환산해 추정하면 그건 우리가 만든 숫자이고, 실제 청구와 어긋나면 금액을
  // 안 알려준 것보다 나쁘다.
  const policy = require('./branchPolicy');
  const groupId = (options && options.groupId) || null;
  const branchId = (options && options.branchId) || null;
  const product = askedProduct(raw);

  // 등록된 표가 없으면 { enabled: false }다 — 표가 비어 있는데 금액을 만들어내는 일은 없다.
  const premium = await policy.calculatePremiumOnewayFare(groupId, branchId, quote.distanceKm)
    .catch((e) => { console.error('프리미엄 편도 요금 계산 실패:', e.message); return { enabled: false }; });
  const daily = await policy.describeDailyDriverFare(groupId, branchId)
    .catch((e) => { console.error('일일기사 요금 조회 실패:', e.message); return { enabled: false }; });

  // 등록돼 있지 않은 상품을 물었을 때 — 금액을 지어내지 않고 상담원으로 넘긴다.
  // 사용자 확정 문구(2026-09-08)다.
  const NOT_REGISTERED = [
    '프리미엄대리(법인)는 요금 정보가 등록되어 있지 않습니다.',
    '상담원에게 연결해 드릴까요?',
  ];

  if (product === 'premium') {
    if (!premium.enabled) {
      return { kind: 'fare', text: [lines[0], ...NOT_REGISTERED].join('\n'), intake: null, fare: null, offerAgent: true };
    }
    lines.push(`법인대리(프리미엄) 예상 요금은 ${formatWon(premium.fare)}입니다. (편도, 약 ${quote.distanceKm.toFixed(1)}km)`);
    lines.push('※ 차종·시간대·현장 상황에 따라 최종 요금은 달라질 수 있습니다.');
    return {
      kind: 'fare',
      text: lines.join('\n'),
      intake: null,
      fare: {
        total: premium.fare,
        distanceKm: quote.distanceKm,
        from: quote.origin.address,
        to: quote.destination.address,
        orderType: 'premium',
        hasFerryLeg: !!quote.hasFerryLeg,
        ferryFare: 0,
        fareSource: premium.fareSource || null,
      },
    };
  }

  // 여기부터는 탁송을 물었거나(product === 'dispatch') 상품 구분이 없는 질문이다.
  // 일일기사는 이 함수 첫머리에서 이미 답하고 돌아갔다(경로가 필요 없어서다).
  lines.push(`탁송 예상 요금은 ${formatWon(quote.total)}입니다. (약 ${quote.distanceKm.toFixed(1)}km)`);
  if (quote.hasFerryLeg) lines.push('※ 도선(배편) 구간이 포함된 경로로, 선박 요금이 함께 반영된 금액입니다.');

  // **구분이 없으면 대리도 함께 안내한다**(사용자 확정 2026-09-08) — b2b-car는 탁송만이
  // 아니라 프리미엄대리도 취급하므로, 탁송 금액만 답하면 절반만 답한 것이다.
  //
  // 프리미엄 표가 등록돼 있으면 두 금액을 나란히 보여준다. 없으면 등록돼 있는 일일기사 표를
  // 알려주고(요금 안내가 "준비 중"으로 끝나면 고객은 어디로 가야 할지 모른다), 프리미엄은
  // 등록되지 않았음을 밝히고 상담원 연결을 제안한다.
  let offerAgent = false;
  if (product === null) {
    if (premium.enabled) {
      lines.push(`법인대리(프리미엄) 예상 요금은 ${formatWon(premium.fare)}입니다. (편도)`);
    } else {
      if (daily.enabled) {
        lines.push(`· 일일기사(하루 단위)로 이용하시려면 "일일기사 요금"이라고 말씀해주세요`
          + ` — 이용 시간 기준입니다(${formatHours(daily.baseHours)} ${formatWon(daily.baseFare)}부터).`);
      }
      lines.push(`· ${NOT_REGISTERED[0]} ${NOT_REGISTERED[1]}`);
      offerAgent = true;
    }
  }

  lines.push('※ 차종·시간대·현장 상황에 따라 최종 요금은 달라질 수 있습니다.');

  return {
    kind: 'fare',
    text: lines.join('\n'),
    intake: null,
    fare: {
      total: quote.total,
      distanceKm: quote.distanceKm,
      from: quote.origin.address,
      to: quote.destination.address,
      orderType: 'dispatch',
      // 문의 기록에 그대로 남는 값들(lib/inquiryRecord.js) — 화면이 되돌려 보내는 왕복 없이
      // 계산한 자리에서 바로 남기려고 함께 돌려준다.
      hasFerryLeg: !!quote.hasFerryLeg,
      ferryFare: (quote.fare && quote.fare.ferryFare) || 0,
      fareSource: (quote.fare && quote.fare.fareSource) || null,
    },
    offerAgent,
  };
}

// 운영시간 문의 — operating_hours를 읽어 안내 문구를 만든다. 지사를 특정할 수 없거나 운영시간이
// 설정돼 있지 않으면 null이라, 호출부는 기존 경로(지식검색 → 상담원 연결)로 그대로 넘어간다.
async function buildHoursSuggestion(raw, options) {
  if (!HOURS_QUESTION_RE.test(String(raw || ''))) return null;
  const info = await describeOperatingHours({ branchId: (options && options.branchId) || null }).catch((e) => {
    console.error('운영시간 안내 생성 실패:', e.message);
    return null;
  });
  if (!info) return null;
  return { kind: 'hours', text: info.text, intake: null };
}

// 접수 폼이 파싱됐을 때의 확인 문구. lib/kakaoIntakeService.js의 자동 접수 확인 메시지와
// 같은 정보를 담되, 아직 등록 전이라 접수번호가 없고 "확인해주시면 접수하겠다"는 톤이다.
// 요약 본문은 등록 후 통보(lib/kakaoIntakeService.js)·웹 접수 화면과 같은 모듈이 만든다
// (lib/intakeSummary.js). 여기서는 아직 등록 전이라 접수번호가 없고 톤만 다르다.
function buildIntakeReply(parsed) {
  const reservation = resolveReservation(parsed.when);
  const vehicleCount = (parsed.vehicles || []).filter((v) => v && (v.plate || v.type)).length;
  const head = vehicleCount > 1 ? `${vehicleCount}건 접수하겠습니다.` : '접수하겠습니다.';
  return buildSummaryText(fromParsed(parsed, reservation), { head, labeled: false });
}

// 자유 문장이 접수 요청처럼 보이는지 — LLM을 태우기 전의 값싼 관문이다. 모든 메시지에 분류를
// 돌리면 상담원 화면에 초안이 뜨는 속도도, 비용도 감당이 안 된다. "A에서 B까지" 꼴이거나
// 접수 동사가 있을 때만 본다.
const INTAKE_HINT_RE = /(탁송|배차|접수|예약|픽업|가져다|보내주|이동해|옮겨)/;
const ROUTE_HINT_RE = /(에서\s*\S+\s*(까지|으로|로)|→)/;

async function buildFreeTextIntakeSuggestion(raw, options) {
  if (!INTAKE_HINT_RE.test(raw) && !ROUTE_HINT_RE.test(raw)) return null;

  // 요금 경로가 이미 분류를 돌렸으면 그 결과를 재사용한다 — 같은 문장에 LLM을 두 번 태우지 않는다.
  let extracted = (options && options.extracted) || null;
  if (!extracted) {
    try {
      extracted = await classifyAndExtract(raw, null, null);
    } catch (e) {
      console.error('상담원 도우미 자유문장 접수 분석 실패:', e.message);
      return null;
    }
  }
  // 탁송(dispatch_order)만 대상이다 — 프리미엄/일일기사는 오더 컬럼과 요금 체계가 달라
  // 접수장 프리필이 맞지 않는다(자동 등록 경로와 같은 기준).
  if (!extracted || extracted.intent !== 'dispatch_order') return null;

  const parsed = buildParsedFromClassified(extracted, raw);
  // 아무 필드도 못 뽑았으면 초안을 만들지 않는다 — 빈 확인 문구는 소음이다.
  if (!parsed.origin.address && !parsed.destination.address && !parsed.vehicles.length) return null;

  if (parsed.complete) {
    return { kind: 'intake', text: buildIntakeReply(parsed), intake: toIntakeFields(parsed) };
  }
  // 확인된 내용 요약은 buildMissingQuestion이 붙여준다 — 봇 응대 경로와 같은 문구를 쓴다.
  const addressPreview = await previewIntakeAddresses(parsed);
  const question = buildMissingQuestion(parsed.missing, parsed, addressPreview);
  if (!question) return null;
  return { kind: 'intake', text: question, intake: toIntakeFields(parsed), missing: parsed.missing };
}

// 접수 폼 파싱 결과를 우측 접수장(IntakeMiniForm)이 그대로 쓰는 필드명으로 변환한다.
// routes/chat.js의 /sessions/:id/intake-order 응답 구조와 키를 맞춰야 폼이 알아본다.
function toIntakeFields(parsed) {
  const reservation = resolveReservation(parsed.when);
  const first = parsed.vehicles[0] || {};
  return {
    reserved_date: reservation.date,
    reserved_time: reservation.time,
    origin_address: parsed.origin.address || '',
    // 접수 마무리 폼은 주소와 상세주소 칸이 따로 있다(IntakeMiniForm의 origin_detail_address).
    // 파서가 나눠준 값을 그대로 각 칸에 넣는다 — 예전에는 합친 문자열 하나만 넣어서, 상호명이
    // 주소 칸에 딸려 들어가고 상세주소 칸은 늘 비어 있었다.
    origin_detail_address: parsed.origin.addressDetail || '',
    origin_contact: parsed.origin.contact || '',
    destination_address: parsed.destination.address || '',
    destination_detail_address: parsed.destination.addressDetail || '',
    destination_contact: parsed.destination.contact || '',
    vehicle_number: first.plate || '',
    vehicle_type: first.type || '',
    memo_customer: buildIntakeMemo(parsed),
    // 폼에는 한 대만 채우고, 나머지는 상담원이 알 수 있게 메모로 남긴다(오더 N건 분해는
    // 자동 접수 경로에서만 한다 — 상담원 화면에서는 사람이 판단할 문제다).
    extra_vehicles: parsed.vehicles.slice(1).map((v) => [v.type, v.plate].filter(Boolean).join(' ')),
    // **오더구분까지 넘긴다.**
    //
    // 프리미엄대리·일일기사 접수를 서버 턴 엔진이 처리해도(lib/webIntakeTurn.js) 이 함수가
    // 카테고리를 안 실어주면 화면 우측 폼과 상담관리 카드가 **탁송으로** 보인다 — 대화는
    // 일일기사로 진행됐는데 폼은 탁송이라, 상담원이 그대로 저장하면 오더구분이 바뀐다.
    // 탁송 경로는 parsed.category가 없어 아래 값들이 전부 빠지므로 지금까지와 같다.
    ...(parsed.category === 'premium_daily' ? {
      order_type: parsed.orderType || 'premium',
      trip_type: parsed.tripType || null,
      final_destination_address: parsed.finalDestinationAddress || null,
      destination_wait_minutes: (parsed.destinationWait && parsed.destinationWait.minutes != null)
        ? parsed.destinationWait.minutes : null,
      // 경유지는 폼이 한 칸만 받는다(대화도 하나만 다룬다 — lib/intakeFields.js 주석 참고).
      waypoint_address: ((parsed.waypoints || [])[0] || {}).address || null,
    } : {}),
  };
}

function buildIntakeMemo(parsed) {
  const parts = [];
  const o = parsed.options || {};
  if (o.insurance) parts.push('책임보험 가입');
  if (o.refuel) parts.push(o.refuel.raw || '주유 요청');
  else if (o.fuelGauge) parts.push(`연료 ${o.fuelGauge}칸`);
  if (o.documents) parts.push(o.documents);
  if (o.releaseDate) parts.push(`출고일 ${o.releaseDate}`);
  if (parsed.memo) parts.push(parsed.memo);
  return parts.join(' / ').slice(0, 1000);
}

// 고객 메시지 하나에 대한 제안을 만든다. 만들 게 없으면 null(= 제안 없음).
async function buildSuggestion(text, options = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const parsed = parseKakaoIntake(raw);
  if (parsed.matched) {
    if (parsed.complete) {
      return {
        kind: 'intake',
        text: buildIntakeReply(parsed),
        intake: toIntakeFields(parsed),
      };
    }
    // 필수 항목이 빠진 폼 — 되묻는 문구를 초안으로 준다. 접수장에는 지금까지 파싱된 값만 채운다.
    const addressPreview = await previewIntakeAddresses(parsed);
  const question = buildMissingQuestion(parsed.missing, parsed, addressPreview);
    if (question) {
      return {
        kind: 'intake',
        text: question,
        intake: toIntakeFields(parsed),
        missing: parsed.missing,
      };
    }
  }

  // 요금 문의는 KB보다 먼저 실제 계산을 시도한다.
  if (FARE_QUESTION_RE.test(raw)) {
    const fare = await buildFareSuggestion(raw, options);
    if (fare) return fare;
  }

  // 자유 문장 접수 — "내일 오후2시 판교역에서 사당역까지 탁송예약해줘"처럼 폼이 아닌 접수 요청.
  // 봇 응대 경로(routes/kakaoConsult.js)는 이미 LLM 추출로 처리하는데 도우미에는 없어서, 상담원이
  // 응대 중일 때 이런 요청에 초안이 아예 안 만들어졌다. 접수는 이 채널에서 가장 흔한 용건이라
  // 그 구간에 도우미가 침묵하면 기능의 값어치가 절반으로 준다.
  const freeText = await buildFreeTextIntakeSuggestion(raw, options);
  if (freeText) return freeText;

  // 운영시간도 KB보다 먼저 실제 설정을 읽는다(요금과 같은 이유).
  const hours = await buildHoursSuggestion(raw, options);
  if (hours) return hours;

  const matches = await searchKnowledgeBase(raw, { limit: 1, threshold: FAQ_THRESHOLD, sessionId: options.sessionId || null }).catch((e) => {
    console.error('상담원 도우미 FAQ 검색 실패:', e.message);
    return [];
  });
  if (matches.length && matches[0].answer) {
    return { kind: 'faq', text: matches[0].answer, intake: null };
  }

  return null;
}

// 값싼 키워드 관문 — 호출부가 무거운 조회(거래처 확정 등) 전에 "이 질문이 맞는지"만 먼저 볼 때 쓴다.
function isHoursQuestion(text) { return HOURS_QUESTION_RE.test(String(text || '')); }
function isFareQuestion(text) { return FARE_QUESTION_RE.test(String(text || '')); }

module.exports = { buildSuggestion, buildFareSuggestion, buildHoursSuggestion, buildFreeTextIntakeSuggestion, extractRoute, buildIntakeReply, toIntakeFields, isHoursQuestion, isFareQuestion, parseUseHours, DAILY_DRIVER_HOURS_QUESTION, FAQ_THRESHOLD };
