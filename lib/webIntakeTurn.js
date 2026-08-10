// 웹 AI 챗봇(로그인 사용자)의 탁송 접수 대화 — 판단을 서버로 옮긴 첫 조각(Stage A).
//
// 왜 서버로 옮겼나: 지금까지는 같은 판단(다음 질문 결정, 요금/운영시간 응답, 확인 요약)을
// 브라우저(public/js/ai-intake.js, 4천줄대)와 카카오 상담톡(routes/kakaoConsult.js)이 각자
// 구현하고 있었다. 이번 세션에 카카오 쪽 요금 문의 처리를 두 번(상담원 초안 경로, 봇 응대
// 경로) 따로 붙여야 했던 것도 같은 이유다 — 판단이 한 곳에 없으면 채널마다 버그가 따로 나고
// 따로 고쳐야 한다. `lib/intakeFields.js` 상단 주석이 이미 이 문제를 짚어두고 "접수 대화
// 전체를 옮기는 건 별개의 큰 작업"이라고 미뤄뒀는데, 이 모듈이 그 첫 조각이다.
//
// 범위: 탁송(dispatch_order)과 프리미엄/일일기사(proxy_order/daily_driver_order)의 수집→확인
// 루프. choose_field(필드 직접 지정 수정), offer_agent(상담원 제안)는 이번 범위 밖 — 지금처럼
// 브라우저가 처리한다. 프리미엄/일일기사는 경유지가 있는 요청도 범위 밖이다(개수를 모른 채
// 반복해 받는 루프라 이 모듈의 "missing 필드 한 번에 계산" 모델에 안 맞는다 — 감지되면
// fallthrough로 기존 브라우저 흐름에 넘긴다, lib/intakeFields.js의 getDailyDriverFields 주석
// 참고).
//
// 주소가 애매하면 먼저 확인한다(카카오 채널의 askAddressChoiceIfNeeded와 같은 규칙,
// lib/addressCandidates.js 재사용) — 서버 코드라 브라우저 Kakao Maps SDK를 쓸 수 없어
// REST API 기반으로 확인한다. "사당역"처럼 짧게 말한 주소를 서버가 첫 검색 결과로 조용히
// 확정하면, 기사가 출발한 뒤에야 엉뚱한 곳으로 등록된 걸 알게 되는 위험이 있다.
//
// 재사용: 파싱·되묻기 문구·요금/운영시간 응답·주소 확인·등록 실행은 전부 카카오 채널에서
// 이미 실사용 검증된 함수를 그대로 쓴다(lib/kakaoIntakeParser.js, lib/agentAssist.js,
// lib/addressCandidates.js, lib/kakaoIntakeService.js) — 새로 만든 판단은 "확인 대기"
// 단계 하나뿐이다(아래 참고).
const db = require('../db');
const { classifyAndExtract } = require('./hybridChat');
const { isGreeting, getSmalltalkMessage } = require('./smallTalk');
const { parseKakaoIntake, buildParsedFromClassified, buildMissingQuestion, normalizePhone, normalizePlate } = require('./kakaoIntakeParser');
const { buildFareSuggestion, buildHoursSuggestion, buildIntakeReply } = require('./agentAssist');
const { createOrdersFromIntake } = require('./kakaoIntakeService');
const { searchAddressCandidates, needsDisambiguation, buildCandidateListText, matchCandidateChoice, getClarifyText } = require('./addressCandidates');
const { getDailyDriverFields } = require('./intakeFields');
const { createPremiumOrderFromIntake, buildPremiumPreviewMessage } = require('./webPremiumIntakeService');

const INTAKE_SLOT_TTL_MINUTES = 30;

// 등록 실패 사유 → 사용자에게 그대로 보여줄 문구. 카카오(routes/kakaoConsult.js)는 외부
// 고객이라 사유를 숨기고 상담원에게 넘기지만, 웹은 로그인한 사내 직원이라 사유를 그대로
// 알려주는 편이 낫다 — 본인이 입력을 고칠 수 있고, 필요하면 수동 등록 화면(/orders/new)으로
// 바로 갈 수 있다.
const FAILURE_MESSAGES = {
  origin_geocode_failed: '출발지 주소를 확인할 수 없습니다. 더 정확한 주소로 다시 입력해주세요.',
  operating_hours: '요청하신 시간은 지사 운영시간 밖입니다. 시간을 다시 확인해주세요.',
  waypoint_unsupported: '경유지가 포함된 접수는 AI 챗봇으로 등록할 수 없습니다. 오더 등록 화면에서 직접 접수해주세요.',
  exception: '접수 처리 중 오류가 발생했습니다. 오더 등록 화면에서 직접 접수해주세요.',
};

async function loadPendingIntake(session) {
  if (!session.intake_slots_json) return null;
  try {
    const saved = JSON.parse(session.intake_slots_json);
    if (!saved || !saved.savedAt || !saved.raw) return null;
    if (Date.now() - saved.savedAt > INTAKE_SLOT_TTL_MINUTES * 60000) return null;
    return saved;
  } catch (e) {
    return null;
  }
}

async function savePendingIntake(session, raw, missing, extra) {
  await db.run(
    `UPDATE chat_sessions SET intake_slots_json = ?,
     intake_updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [JSON.stringify({ raw, missing: missing || [], savedAt: Date.now(), ...(extra || {}) }), session.id]
  );
}

async function clearPendingIntake(session) {
  await db.run('UPDATE chat_sessions SET intake_slots_json = NULL WHERE id = ?', [session.id]);
}

// 로그인 사용자를 카카오의 "채널 매핑 계정"과 같은 모양으로 만든다 — createOrdersFromIntake는
// 이 다섯 필드만 본다(auto_register/branch_id/requester_group_id/payment_method_id/user_id).
// 결제수단을 지정하지 않는 건 카카오의 "지정 안 함" 매핑과 같은 취급이다(insertOrder가 이미
// null을 받아들인다) — 결제수단 선택은 이번 범위 밖, 등록 후 오더 상세에서 바꿀 수 있다.
function accountFromUser(user) {
  return {
    user_id: user.id,
    branch_id: user.branch_id,
    requester_group_id: user.group_id || null,
    payment_method_id: null,
    auto_register: true,
  };
}

// ---- 프리미엄/일일기사 — 짧은 답 지름길 ----
// 대화 병합은 고객이 보낸 원문만 이어붙인다(챗봇이 물은 질문 문구는 안 남는다). "1"이나
// "없어"처럼 맥락이 없는 짧은 답은 Gemini가 무엇에 대한 답인지 알 길이 없다 — 브라우저
// FSM(public/js/ai-intake-flow.js의 parseTripTypeResponse/parseWaitYesNo)이 이미 같은 이유로
// 필드별 전용 파서를 따로 두고 있었다. 딱 하나가 남은 항목일 때만 이 지름길을 쓴다 —
// 두 개 이상 남았으면 어느 답인지 특정할 수 없어 그냥 Gemini 재분류로 넘긴다.
// ⚠ 끝에 \b(단어 경계)를 쓰면 안 된다 — JS \b는 [A-Za-z0-9_] 기준이라 한글 뒤에서는 절대
// 성립하지 않는다(lib/kakaoIntakeParser.js의 ADDRESS_HINT_RE 주석과 같은 함정). 대신
// 공백/구두점/문자열 끝을 직접 확인한다(이 파일의 isAffirmative와 같은 방식).
const PREMIUM_DECLINE_RE = /^(없음|없어요|없습니다|없어|없|모르겠|모름|모르|아니오|아니요|괜찮|스킵|no)([\s,.!~]|$)/i;
const PREMIUM_DECLINABLE_FIELD_IDS = new Set(['destination_wait', 'memo_customer', 'vehicle_number']);

// orderType('premium'|'daily_driver') → classifyAndExtract의 intent 힌트. 카테고리가 이미
// 확정된 뒤 재분류할 때만 넘긴다(첫 분류는 이 값을 알아내는 호출이라 넘길 수 없다) — 넘기면
// hybridChat.js가 요약형 전달사항 지시문(_premiumMemoInstructions)을 쓴다.
function premiumOrderTypeToIntentHint(orderType) {
  if (orderType === 'daily_driver') return 'daily_driver_order';
  if (orderType === 'premium') return 'proxy_order';
  return null;
}

function parseTripTypeBareReply(text) {
  const t = String(text || '').trim();
  if (/^1\s*(번|\.|\))?$/.test(t)) return 'round_trip';
  if (/^2\s*(번|\.|\))?$/.test(t)) return 'one_way';
  return null;
}

// Gemini 추출 결과(+짧은 답 지름길로 미리 정한 값)를 프리미엄/일일기사 parsed 모양으로 맞춘다.
// overrides.tripType/declined는 지난 턴까지 확정된 값 — 이번 턴 Gemini 결과가 이를 다시 못
// 잡아내도(짧은 답이라 못 잡는 게 당연하다) 덮어써 잃지 않는다.
function buildPremiumParsedFromClassified(classified, text, overrides) {
  const ov = overrides || {};
  const join = (a, b) => [a, b].map((v) => String(v || '').trim()).filter(Boolean).join(' ') || null;

  const tripType = ov.tripType
    || (classified.tripType === 'round_trip' || classified.tripType === 'one_way' ? classified.tripType : null);

  const date = String(classified.reservationDate || '').trim() || null;
  const time = String(classified.reservationTime || '').trim() || null;
  const when = (date || time)
    ? { immediate: false, date, time, dateRolled: false, raw: [date, time].filter(Boolean).join(' ') }
    : { immediate: true, date: null, time: null, dateRolled: false, raw: null };

  const originAddress = join(classified.originAddress, classified.originAddressDetail);
  const destAddress = join(classified.destinationAddress, classified.destinationAddressDetail);
  const finalDestAddress = join(classified.finalDestinationAddress, classified.finalDestinationAddressDetail);
  const plate = normalizePlate(classified.originVehicleNumber) || null;
  const vehicleType = String(classified.vehicleType || '').trim() || null;
  const waypointAddress = join(classified.waypointAddress, null);

  const declined = new Set(ov.declined || []);
  let waitMinutes = (classified.destinationWaitMinutes !== undefined && classified.destinationWaitMinutes !== null && classified.destinationWaitMinutes !== '')
    ? Number(classified.destinationWaitMinutes) : null;
  if ((waitMinutes === null || Number.isNaN(waitMinutes)) && declined.has('destination_wait')) waitMinutes = 0;
  const memo = String(classified.memo || '').trim() || null;

  const values = {
    trip_type: tripType,
    reserved_date: date || time,
    origin_address: originAddress,
    origin_contact: normalizePhone(classified.originContact) || null,
    vehicle_number: plate || (declined.has('vehicle_number') ? 'x' : null),
    destination_address: destAddress,
    destination_wait: waitMinutes !== null && !Number.isNaN(waitMinutes) ? String(waitMinutes) : null,
    final_destination_address: finalDestAddress,
    memo_customer: memo || (declined.has('memo_customer') ? 'x' : null),
  };

  const fields = getDailyDriverFields(tripType);
  const rawMissing = fields
    .filter((f) => {
      const v = values[f.id];
      return v === undefined || v === null || v === '';
    })
    .map((f) => f.id);

  // 짧은 답(없어 등)으로만 채워지는 항목이 한꺼번에 둘 이상 남으면, "없어" 한 마디가 그 중
  // 어느 것에 대한 답인지 알 수 없다(continuePremiumIntake의 지름길은 missing이 정확히 하나일
  // 때만 작동한다). 그래서 declinable 항목은 한 번에 하나만 남기고 나머지는 뒤로 미룬다 —
  // 앞선(비-declinable) 항목은 그대로 함께 보여줘도 된다, 그건 답이 뒤섞일 일이 없다.
  const firstDeclinableIdx = rawMissing.findIndex((id) => PREMIUM_DECLINABLE_FIELD_IDS.has(id));
  const missing = firstDeclinableIdx === -1
    ? rawMissing
    : rawMissing.filter((id, i) => i <= firstDeclinableIdx || !PREMIUM_DECLINABLE_FIELD_IDS.has(id));

  const vehicle = { plate, type: vehicleType };
  return {
    matched: true,
    complete: missing.length === 0,
    missing,
    category: 'premium_daily',
    tripType,
    origin: { address: originAddress, contact: normalizePhone(classified.originContact) || null },
    destination: { address: destAddress, contact: null },
    vehicle,
    vehicles: (plate || vehicleType) ? [vehicle] : [], // describeKnownFields(카카오 공용 되묻기 요약)가 이 모양을 본다.
    when,
    destinationWait: { minutes: waitMinutes !== null && !Number.isNaN(waitMinutes) ? waitMinutes : null },
    finalDestinationAddress: tripType === 'round_trip' ? finalDestAddress : null,
    memo,
    waypointAddress,
    declined: Array.from(declined),
    raw: text,
  };
}

// 한 턴 처리. text는 이번에 사용자가 보낸 원문(병합 전).
async function runWebIntakeTurn({ user, session, text }) {
  const raw = String(text || '').trim();
  if (!raw) return { replyText: '', ok: true };

  const pending = await loadPendingIntake(session);

  // 주소 후보를 고르는 중이면 이 답은 보충 정보가 아니라 "번호 선택"이다 — 카카오의
  // handleAddressChoiceReply와 같은 처리(matchCandidateChoice가 판정 규칙을 공유한다).
  if (pending && pending.awaiting === 'address_choice') {
    return handleAddressChoiceReply({ user, session, pending, text: raw });
  }

  // 확인 대기 중이었다면("네" 또는 "아니오/수정") 먼저 그 답으로 해석한다 — 이 판단은
  // 카카오에는 없다(카카오는 auto_register 계정이면 확인 없이 바로 등록한다). 로그인
  // 사용자가 잘못 채워진 채로 등록시키지 않게, 웹에서만 추가한 확인 관문이다.
  if (pending && pending.awaiting === 'confirm') {
    if (isAffirmative(raw)) {
      return submitPendingOrder({ user, session, pending });
    }
    if (isNegative(raw)) {
      await clearPendingIntake(session);
      return { replyText: '접수를 취소했습니다. 다시 접수하시려면 내용을 입력해주세요.', ok: true, closeSession: false };
    }
    // 그 외 답변은 "수정"으로 보고, 이번 발화를 원문에 이어붙여 다시 파싱한다(아래 공통 경로).
  }

  // 스몰토크/인사는 접수 판단으로 넘기지 않는다(웹 /orders/ai-intake/parse와 동일 규칙).
  const smalltalk = getSmalltalkMessage(raw);
  if (smalltalk) return { replyText: smalltalk, ok: true };
  if (isGreeting(raw)) {
    return { replyText: '안녕하세요. 오더 접수 내용을 입력하시거나, 궁금한 점을 질문해주세요.', ok: true };
  }

  // 프리미엄/일일기사 대화가 이미 진행 중이면(카테고리가 확정돼 있으면) 전용 흐름으로 이어간다
  // — 탁송 파서/분류를 다시 태우면 "1"/"없어" 같은 짧은 답이 엉뚱하게(또는 아예 못) 해석된다.
  if (pending && pending.category === 'premium_daily') {
    return continuePremiumIntake({ session, pending, raw });
  }

  // 되묻기 중이었으면 원문에 이어붙인다(카카오와 같은 병합 방식) — "그리고 차량은 12가1234요"
  // 처럼 보충 답변만 와도 앞서 받은 출발지·도착지가 사라지지 않는다.
  const mergedRaw = (pending && pending.raw) ? `${pending.raw}\n${raw}` : raw;

  let parsed = parseKakaoIntake(mergedRaw);
  let classified = null;
  if (!parsed.matched) {
    try {
      classified = await classifyAndExtract(mergedRaw, null, null);
    } catch (e) {
      console.error('웹 AI 접수 의도 분류 실패:', e.message);
      return { replyText: '요청을 이해하지 못했습니다. 접수 내용을 다시 말씀해주세요.', ok: false };
    }

    if (classified.intent === 'faq') {
      const fare = await buildFareSuggestion(raw, { branchId: user.branch_id, extracted: classified }).catch(() => null);
      if (fare) return { replyText: fare.text, ok: true };
      const hours = await buildHoursSuggestion(raw, { branchId: user.branch_id }).catch(() => null);
      if (hours) return { replyText: hours.text, ok: true };
      // 그 외 지식검색 FAQ는 기존 /orders/ai-intake/parse 경로가 이미 처리한다 — 이 턴 엔진은
      // "접수 대화 중" 판단만 맡고, 지식검색 매칭까지 흡수하지 않는다(범위를 좁게 유지).
      // 이미 뽑아둔 분류 결과를 함께 넘긴다 — parse 경로가 같은 문장에 Gemini를 다시 태우지 않도록.
      return { replyText: null, ok: true, fallthrough: true, classified };
    }
    if (classified.intent === 'proxy_order' || classified.intent === 'daily_driver_order') {
      const orderType = classified.intent === 'daily_driver_order' ? 'daily_driver' : 'premium';
      return startPremiumIntake({ session, mergedRaw, classified, orderType });
    }
    if (classified.intent !== 'dispatch_order') {
      // choose_field/offer_agent/unsupported — 이번 범위 밖. 클라이언트가 기존 경로(상담원
      // 제안 등)로 이어가게 그대로 넘긴다. 분류 결과를 함께 넘겨 parse의 재분류를 아낀다.
      return { replyText: null, ok: true, fallthrough: true, classified };
    }
    parsed = buildParsedFromClassified(classified, mergedRaw);
  }

  if (!parsed.complete) {
    await savePendingIntake(session, mergedRaw, parsed.missing);
    return { replyText: buildMissingQuestion(parsed.missing, parsed), ok: true, awaitingConfirmation: false };
  }

  return finishParsed({ session, parsed, mergedRaw });
}

// 필수 항목이 다 채워진 뒤 마무리 — 주소가 애매하면 먼저 확인하고, 확인까지 끝났으면
// 등록 전 요약을 보여준다. 카카오 채널(completeIntake 진입 직전의 askAddressChoiceIfNeeded
// 호출)과 같은 순서다. cache는 한 턴 안에서 지오코딩 결과를 재사용해 중복 조회를 없앤다
// (사당역 예시: 후보 검색 때 이미 조회한 주소를 등록 실행 때 다시 조회하지 않는다).
async function finishParsed({ session, parsed, mergedRaw, cache }) {
  const geoCache = cache || new Map();
  const asked = await askAddressChoiceIfNeeded({ session, parsed, mergedRaw, cache: geoCache });
  if (asked) return asked;

  // 다 채워졌고 주소도 확정됐다 — 바로 등록하지 않고 요약을 보여주고 확인을 받는다(웹만의 관문).
  await savePendingIntake(session, mergedRaw, [], { awaiting: 'confirm', parsed });
  return {
    replyText: `${buildIntakeReply(parsed)}\n\n맞으면 "네", 다시 입력하시려면 내용을 고쳐서 다시 보내주세요.`,
    ok: true,
    awaitingConfirmation: true,
  };
}

// 출발지·도착지가 여러 곳으로 검색되면 물어본다. 물어봤으면 그 응답 객체를, 아니면 null을
// 돌려준다. 두 검색은 서로 독립적이라 동시에 시작해두고, 출발지가 애매하면 도착지는 보지도
// 않고 그것부터 묻는다(우선순위, 카카오와 동일). extra는 물어봐야 할 때 저장할 대기 상태에
// 함께 얹을 값 — 프리미엄/일일기사(finishParsedPremium)가 category/orderType/tripType/declined를
// 여기 실어 넘긴다. 이게 없으면 이 함수가 저장하는 대기 상태에 그 값들이 빠져, 주소를 고른 뒤
// handleAddressChoiceReply가 어느 카테고리로 이어가야 할지 알 수 없게 된다.
async function askAddressChoiceIfNeeded({ session, parsed, mergedRaw, cache, extra }) {
  const sides = [
    { key: 'origin', label: '출발지', query: parsed.origin && parsed.origin.address },
    { key: 'destination', label: '도착지', query: parsed.destination && parsed.destination.address },
  ];
  const searches = sides.map((side) => (
    side.query
      ? searchAddressCandidates(side.query, { cache }).catch((e) => {
          console.error('웹 AI 접수 주소 후보 검색 실패(자동 확정으로 진행):', e.message);
          return [];
        })
      : Promise.resolve([])
  ));
  const results = await Promise.all(searches);

  for (let i = 0; i < sides.length; i += 1) {
    const side = sides[i];
    if (!side.query) continue;
    const candidates = results[i];
    if (!needsDisambiguation(side.query, candidates)) continue;

    await savePendingIntake(session, mergedRaw, [], {
      awaiting: 'address_choice', side: side.key, sideLabel: side.label, query: side.query, candidates,
      ...(extra || {}),
    });
    return { replyText: buildCandidateListText(side.label, candidates), ok: true, awaitingConfirmation: false };
  }
  return null;
}

// ---- 프리미엄/일일기사 — 탁송과 나란한 흐름 ----
// 시작(분류 직후, 카테고리를 처음 확정) — 경유지가 있으면 이번 범위 밖이라 바로 넘긴다.
async function startPremiumIntake({ session, mergedRaw, classified, orderType }) {
  const parsed = buildPremiumParsedFromClassified(classified, mergedRaw, {});
  if (parsed.waypointAddress) {
    return { replyText: null, ok: true, fallthrough: true };
  }
  parsed.orderType = orderType;
  return advancePremiumIntake({ session, parsed, mergedRaw });
}

// 프리미엄/일일기사 대화가 이미 진행 중일 때의 다음 턴. trip_type이 아직 남아 있으면 번호
// 답("1"/"2")을 먼저 시도한다 — trip_type은 항상 첫 항목이라 다른 항목과 함께 되물어지는
// 경우가 대부분이라(한 번에 다 묻는 방식) "남은 항목이 하나뿐일 때만" 조건으로는 거의 걸리지
// 않는다. declinable 항목(destination_wait 등)은 buildPremiumParsedFromClassified가 이미
// 한 번에 하나만 missing에 남기므로, 그 하나에 대해서만 "없어" 지름길을 시도한다.
async function continuePremiumIntake({ session, pending, raw }) {
  const mergedRaw = `${pending.raw}\n${raw}`;
  const missing = pending.missing || [];
  const overrides = { tripType: pending.tripType || null, declined: pending.declined || [] };

  if (missing.includes('trip_type')) {
    const t = parseTripTypeBareReply(raw);
    if (t) overrides.tripType = t;
  }
  const declinableMissing = missing.find((id) => PREMIUM_DECLINABLE_FIELD_IDS.has(id));
  if (declinableMissing && PREMIUM_DECLINE_RE.test(raw.trim())) {
    overrides.declined = Array.from(new Set([...overrides.declined, declinableMissing]));
  }

  let classified;
  try {
    classified = await classifyAndExtract(mergedRaw, null, premiumOrderTypeToIntentHint(pending.orderType));
  } catch (e) {
    console.error('웹 AI 접수(프리미엄/일일기사) 재분류 실패:', e.message);
    return { replyText: '요청을 이해하지 못했습니다. 접수 내용을 다시 말씀해주세요.', ok: false };
  }

  const parsed = buildPremiumParsedFromClassified(classified, mergedRaw, overrides);
  if (parsed.waypointAddress) {
    await clearPendingIntake(session);
    return { replyText: null, ok: true, fallthrough: true };
  }
  parsed.orderType = pending.orderType;
  return advancePremiumIntake({ session, parsed, mergedRaw });
}

// 다 채워졌는지 보고 되묻거나 마무리로 넘긴다 — 탁송의 완료 판단 분기와 같은 자리.
async function advancePremiumIntake({ session, parsed, mergedRaw }) {
  if (!parsed.complete) {
    await savePendingIntake(session, mergedRaw, parsed.missing, {
      category: 'premium_daily', orderType: parsed.orderType, tripType: parsed.tripType, declined: parsed.declined,
    });
    const fields = getDailyDriverFields(parsed.tripType);
    return { replyText: buildMissingQuestion(parsed.missing, parsed, null, fields), ok: true, awaitingConfirmation: false };
  }
  return finishParsedPremium({ session, parsed, mergedRaw });
}

// 탁송의 finishParsed와 같은 자리 — 주소 확인 후 등록 전 요약을 보여준다.
async function finishParsedPremium({ session, parsed, mergedRaw, cache }) {
  const geoCache = cache || new Map();
  const asked = await askAddressChoiceIfNeeded({
    session, parsed, mergedRaw, cache: geoCache,
    extra: { category: 'premium_daily', orderType: parsed.orderType, tripType: parsed.tripType, declined: parsed.declined },
  });
  if (asked) return asked;

  await savePendingIntake(session, mergedRaw, [], {
    awaiting: 'confirm', category: 'premium_daily', orderType: parsed.orderType, parsed,
  });
  return {
    replyText: `${buildPremiumPreviewMessage(parsed)}\n\n맞으면 "네", 다시 입력하시려면 내용을 고쳐서 다시 보내주세요.`,
    ok: true,
    awaitingConfirmation: true,
  };
}

// 고객이 번호로 답했을 때 — 고른 주소를 원문에 반영해 접수를 이어간다. 못 알아들으면 한 번 더
// 안내한다(카카오의 handleAddressChoiceReply와 같은 역할). 카테고리(탁송/프리미엄·일일기사)에
// 따라 재분류·완료 판단이 서로 다른 함수로 갈린다 — pending.category가 address_choice를 저장한
// askAddressChoiceIfNeeded의 extra를 통해 그대로 남아 있다.
async function handleAddressChoiceReply({ user, session, pending, text }) {
  const chosen = matchCandidateChoice(text, pending.candidates || []);
  if (!chosen) {
    return { replyText: getClarifyText(pending.candidates), ok: true, awaitingConfirmation: false };
  }

  const replacedRaw = String(pending.raw || '').replace(pending.query, chosen.address);
  const isPremium = pending.category === 'premium_daily';

  if (isPremium) {
    let classified;
    try {
      classified = await classifyAndExtract(replacedRaw, null, premiumOrderTypeToIntentHint(pending.orderType));
    } catch (e) {
      console.error('웹 AI 접수(프리미엄/일일기사) 주소 선택 후 재분류 실패:', e.message);
      await clearPendingIntake(session);
      return { replyText: '접수 내용을 다시 알려주시겠어요?', ok: false };
    }
    const parsed = buildPremiumParsedFromClassified(classified, replacedRaw, {
      tripType: pending.tripType || null, declined: pending.declined || [],
    });
    parsed.orderType = pending.orderType;
    if (parsed.waypointAddress) {
      await clearPendingIntake(session);
      return { replyText: null, ok: true, fallthrough: true };
    }
    if (!parsed.complete) {
      await savePendingIntake(session, replacedRaw, parsed.missing, {
        category: 'premium_daily', orderType: parsed.orderType, tripType: parsed.tripType, declined: parsed.declined,
      });
      const fields = getDailyDriverFields(parsed.tripType);
      return {
        replyText: `${pending.sideLabel}를 "${chosen.label}"로 확인했습니다.\n${buildMissingQuestion(parsed.missing, parsed, null, fields)}`,
        ok: true,
        awaitingConfirmation: false,
      };
    }
    const finished = await finishParsedPremium({ session, parsed, mergedRaw: replacedRaw });
    return {
      ...finished,
      replyText: `${pending.sideLabel}를 "${chosen.label}"로 확인했습니다.\n${finished.replyText}`,
    };
  }

  let parsed = parseKakaoIntake(replacedRaw);
  if (!parsed.matched) {
    // 폼이 아니었던(자유 문장) 접수는 다시 분류해서 읽는다 — 처음 이 대화를 읽은 경로와
    // 같은 경로로 한 번 더 읽어야, 자유 문장 접수에서 주소를 고른 뒤 처음부터 다시 묻지 않는다.
    let classified;
    try {
      classified = await classifyAndExtract(replacedRaw, null, null);
    } catch (e) {
      console.error('웹 AI 접수 주소 선택 후 재분류 실패:', e.message);
      classified = null;
    }
    parsed = (classified && classified.intent === 'dispatch_order')
      ? buildParsedFromClassified(classified, replacedRaw)
      : { matched: false };
  }
  if (!parsed.matched) {
    await clearPendingIntake(session);
    return { replyText: '접수 내용을 다시 알려주시겠어요?', ok: false };
  }

  if (!parsed.complete) {
    await savePendingIntake(session, replacedRaw, parsed.missing);
    return {
      replyText: `${pending.sideLabel}를 "${chosen.label}"로 확인했습니다.\n${buildMissingQuestion(parsed.missing, parsed)}`,
      ok: true,
      awaitingConfirmation: false,
    };
  }

  const finished = await finishParsed({ session, parsed, mergedRaw: replacedRaw });
  return {
    ...finished,
    replyText: `${pending.sideLabel}를 "${chosen.label}"로 확인했습니다.\n${finished.replyText}`,
  };
}

async function submitPendingOrder({ user, session, pending }) {
  // parsed는 확인 단계에서 이미 완성해 저장해둔 값을 그대로 쓴다 — "네" 한 마디에서 다시
  // 파싱할 원문이 없다.
  const parsed = pending.parsed;
  await clearPendingIntake(session);
  if (!parsed) {
    return { replyText: '접수 내용을 다시 확인할 수 없습니다. 처음부터 다시 입력해주세요.', ok: false };
  }

  const account = accountFromUser(user);
  const isPremium = pending.category === 'premium_daily';
  let result;
  try {
    result = isPremium
      ? await createPremiumOrderFromIntake({ session, account, parsed, orderType: pending.orderType })
      : await createOrdersFromIntake({ session, account, parsed, sourceChannel: 'web' });
  } catch (e) {
    console.error('웹 AI 접수 등록 실패:', e.message);
    result = { ok: false, reason: 'exception' };
  }

  if (!result.ok) {
    const message = FAILURE_MESSAGES[result.reason] || '접수를 완료할 수 없습니다. 오더 등록 화면에서 직접 접수해주세요.';
    return { replyText: message, ok: false };
  }

  return { replyText: result.message, ok: true, closeSession: true };
}

// "그대로 접수해주세요", "네네" 처럼 다양하게 오는 확인 답변을 넓게 인정한다 —
// public/js/ai-intake.js의 isAffirmative와 같은 취지(문자 그대로 공유하지는 않는다,
// 서버·클라이언트가 서로 require할 수 없는 다른 런타임이라 판단만 같게 유지한다).
function isAffirmative(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return /^(네|넵|예|응|어|그래|그럼|좋아|좋습니다|괜찮|오케이|콜|ok|okay|yes|y)([\s,.!~]|$)/i.test(s)
    || /(그대로\s*(진행|해)|그렇게\s*(해|진행|부탁)|접수\s*(해|할|하)|맞습니다|맞아요|부탁\s*(해|드립|합니다|드려))/.test(s);
}

function isNegative(text) {
  const s = String(text || '').trim();
  return /^(아니|아뇨|노|no|안\s?돼|안\s?할래|취소)/i.test(s);
}

module.exports = { runWebIntakeTurn };
