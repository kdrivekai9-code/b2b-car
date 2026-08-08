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
const { classifyAndExtract } = require('./hybridChat');

// 봇이 직접 응대할 때보다 임계값을 높게 잡는다 — 상담원이 이미 보고 있는 화면이라, 애매한
// 제안은 도움이 아니라 소음이다.
const FAQ_THRESHOLD = 0.72;

// 요금 문의는 지식베이스로 풀 게 아니라 실제 요금표로 계산해야 한다 — "사당역에서 반포역까지
// 얼마"에 맞는 KB 항목은 존재할 수 없다(거리마다 답이 다르다). 오더 등록 화면이 쓰는 것과 같은
// 계산(주소→좌표→경로거리→지사 구간요금표)을 서버에서 돌려 금액을 뽑는다.
const FARE_QUESTION_RE = /(요금|얼마|비용|가격|견적|단가)/;

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
  // 요금 문의가 아니면 곧바로 접는다 — 이 함수를 직접 부르는 경로(봇 응대·웹 위젯)에서
  // 무관한 질문에 LLM 추출이 도는 걸 막는다.
  if (!FARE_QUESTION_RE.test(String(raw || ''))) return null;
  const route = extractRoute(raw);
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
  const lines = [
    `${quote.origin.query} → ${quote.destination.query}`,
    `예상 요금은 ${formatWon(quote.total)}입니다. (약 ${quote.distanceKm.toFixed(1)}km)`,
  ];
  if (quote.hasFerryLeg) lines.push('※ 도선(배편) 구간이 포함된 경로로, 선박 요금이 함께 반영된 금액입니다.');
  lines.push('※ 차종·시간대·현장 상황에 따라 최종 요금은 달라질 수 있습니다.');

  return {
    kind: 'fare',
    text: lines.join('\n'),
    intake: null,
    fare: { total: quote.total, distanceKm: quote.distanceKm, from: quote.origin.address, to: quote.destination.address },
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
function buildIntakeReply(parsed) {
  const reservation = resolveReservation(parsed.when);
  const lines = [];
  const vehicles = parsed.vehicles
    .map((v) => [v.type, v.plate].filter(Boolean).join(' '))
    .filter(Boolean);

  lines.push(vehicles.length > 1 ? `${vehicles.length}건 접수하겠습니다.` : '접수하겠습니다.');
  vehicles.forEach((v) => lines.push(`· ${v}`));
  lines.push(`· ${parsed.origin.address} → ${parsed.destination.address || '(도착지 미기재)'}`);
  lines.push(`· ${reservation.date} ${reservation.time}${reservation.immediate ? ' 즉시' : ''}`);

  const opts = [];
  if (parsed.options.insurance) opts.push('책임보험 가입');
  if (parsed.options.refuel) {
    opts.push(parsed.options.refuel.fuel
      ? `${parsed.options.refuel.fuel} ${parsed.options.refuel.amount ? (parsed.options.refuel.amount / 10000) + '만원' : ''} 주유`.trim()
      : '주유 요청');
  }
  if (parsed.options.documents) opts.push(parsed.options.documents);
  if (opts.length) lines.push(`· 옵션: ${opts.join(', ')}`);

  return lines.join('\n');
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
    origin_contact: parsed.origin.contact || '',
    destination_address: parsed.destination.address || '',
    destination_contact: parsed.destination.contact || '',
    vehicle_number: first.plate || '',
    vehicle_type: first.type || '',
    memo_customer: buildIntakeMemo(parsed),
    // 폼에는 한 대만 채우고, 나머지는 상담원이 알 수 있게 메모로 남긴다(오더 N건 분해는
    // 자동 접수 경로에서만 한다 — 상담원 화면에서는 사람이 판단할 문제다).
    extra_vehicles: parsed.vehicles.slice(1).map((v) => [v.type, v.plate].filter(Boolean).join(' ')),
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

  const matches = await searchKnowledgeBase(raw, { limit: 1, threshold: FAQ_THRESHOLD }).catch((e) => {
    console.error('상담원 도우미 FAQ 검색 실패:', e.message);
    return [];
  });
  if (matches.length && matches[0].answer) {
    return { kind: 'faq', text: matches[0].answer, intake: null };
  }

  return null;
}

module.exports = { buildSuggestion, buildFareSuggestion, buildHoursSuggestion, buildFreeTextIntakeSuggestion, extractRoute, buildIntakeReply, toIntakeFields, FAQ_THRESHOLD };
