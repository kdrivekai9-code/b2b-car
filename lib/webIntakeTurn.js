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
const {
  parseKakaoIntake, buildParsedFromClassified, buildMissingQuestion, normalizePhone, normalizePlate,
  PREMIUM_DECLINE_RE, PREMIUM_DECLINABLE_FIELD_IDS, IMMEDIATE_WORDING_RE, premiumOrderTypeToIntentHint, parseTripTypeBareReply,
  buildPremiumParsedFromClassified, isAffirmative, isNegative, FAILURE_MESSAGES,
} = require('./kakaoIntakeParser');
const {
  loadPendingIntake, savePendingIntake, savePendingState, clearPendingIntake, wasPendingIntakeExpired,
  looksLikeRouteRestart, INTAKE_RESTARTED_NOTICE,
  INTAKE_EXPIRED_NOTICE, looksSelfContained,
} = require('./intakeSlotState');
const { buildFareSuggestion, buildHoursSuggestion, buildIntakeReply, toIntakeFields } = require('./agentAssist');
const { createOrdersFromIntake } = require('./kakaoIntakeService');
const { searchAddressCandidates, needsDisambiguation, rankByCoverage, buildCandidateListText, matchCandidateChoice, getClarifyText } = require('./addressCandidates');
const { getDailyDriverFields } = require('./intakeFields');
const { createPremiumOrderFromIntake, buildPremiumPreviewMessage } = require('./webPremiumIntakeService');

// 되묻기 상태 관리(만료 판정 포함)와 실패 문구는 카카오 채널과 공유한다(lib/intakeSlotState.js,
// lib/kakaoIntakeParser.js) — 위에서 이미 require했다.

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
// 파싱 로직(PREMIUM_DECLINE_RE, buildPremiumParsedFromClassified 등)은 카카오 채널도 같은
// 변환이 필요해져 lib/kakaoIntakeParser.js로 옮겼다 — 위에서 이미 require했다.

// 상담관리 카드의 "접수 마무리" 폼과 이 화면 우측 "AI 파싱 결과 자동 반영 폼"이 함께 보는
// 값이다(draft_json → toIntakeFields, lib/agentAssist.js). 카카오 채널(routes/kakaoConsult.js
// saveIntakeDraft)과 같은 저장 형식을 쓴다 — 폼이 읽는 소스가 채널을 가리지 않기 때문이다.
//
// 이 턴 엔진(webIntakeTurn)은 처음 만들어질 때 이 저장을 아예 하지 않았다(실사용 지적,
// 2026-08-11) — 판단이 서버로 옮겨간 뒤로 카드 폼도, 화면 우측 자동 반영 폼도 챗봇이 파악한
// 내용을 전혀 보여주지 못했다. 매 반환 지점마다 개별로 저장을 끼워 넣으면(카카오 채널이 그렇게
// 되어 있다 — saveIntakeDraft 호출이 9곳에 흩어져 있다) 새 분기를 추가할 때 또 빠뜨리기 쉽다.
// 그래서 여기서는 한 곳(runWebIntakeTurn 최상위)에서만 처리한다 — 내부 함수들은 그저 결과
// 객체에 parsed를 실어 돌려주기만 하면 된다.
async function saveDraft(session, user, parsed) {
  try {
    const fields = toIntakeFields(parsed);
    if (user.branch_id) fields.branch_id = String(user.branch_id);
    if (user.group_id) fields.requester_group_id = String(user.group_id);
    await db.run('UPDATE chat_sessions SET draft_json = ? WHERE id = ?', [JSON.stringify({ fields }), session.id]);
  } catch (e) {
    console.error('웹 AI 접수 폼 프리필 저장 실패(대화는 계속):', e.message);
  }
}

// 한 턴 처리. text는 이번에 사용자가 보낸 원문(병합 전). 실제 판단은 Core가 하고, 여기서는
// 그 결과에 parsed가 실려 있으면 카드 폼 프리필까지 저장한 뒤 그대로 돌려준다.
async function runWebIntakeTurn(args) {
  const result = await runWebIntakeTurnCore(args);
  if (result && result.parsed) await saveDraft(args.session, args.user, result.parsed);
  return result;
}

async function runWebIntakeTurnCore({ user, session, text }) {
  const raw = String(text || '').trim();
  if (!raw) return { replyText: '', ok: true };

  const pending = await loadPendingIntake(session);

  // 진행 중이던 되묻기가 시간이 지나 사라진 상태(TTL 30분 초과)였다면, 그 사실을 모른 채
  // 짧게 이어 보낸 답이 맥락 없이 새 메시지로 재분류된다(카카오 실측 사고와 같은 위험 —
  // routes/kakaoConsult.js의 wasPendingIntakeExpired 참고). 조용히 넘기지 않고 알린다.
  // 다만 이번 메시지가 그 자체로 완결된 새 요청이면 안내를 내지 않고 그대로 처리한다 —
  // 안내만 돌려주고 끝내면 그 요청이 통째로 삼켜진다(카카오에서 실제로 그랬다).
  if (!pending && wasPendingIntakeExpired(session)) {
    await clearPendingIntake(session);
    if (!looksSelfContained(raw)) {
      return { replyText: INTAKE_EXPIRED_NOTICE, ok: true, awaitingConfirmation: false };
    }
  }

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
  //
  // 다만 이번 발화 하나에 출발·도착이 다 들어 있으면 보충이 아니라 **다른 오더로 갈아탄 것**이다.
  // 그때 이어붙이면 두 주문이 한 문장이 돼 서로 섞인다(lib/intakeSlotState.js
  // looksLikeRouteRestart에 실측 사례). 앞 내용을 버리고 이번 발화만으로 다시 읽는다.
  const restarting = !!(pending && pending.raw && looksLikeRouteRestart(raw));
  const mergedRaw = (pending && pending.raw && !restarting) ? `${pending.raw}\n${raw}` : raw;
  // 갈아탄 사실은 답변 앞에 붙여 알린다 — 조용히 버리면 "아까 말한 건 어디 갔냐"가 된다.
  const restartNotice = restarting ? INTAKE_RESTARTED_NOTICE + '\n' : '';

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
      const fare = await buildFareSuggestion(raw, {
        branchId: user.branch_id, groupId: user.group_id || null, extracted: classified,
      }).catch(() => null);
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
      // 갈아타기로 판정해 앞 내용을 버렸는데 이번 발화를 접수로 읽지 못한 경우.
      //
      // 여기서 그냥 넘기면 되묻기 상태에는 **옛 경로가 그대로 남는다**. 고객은 바꿨다고 알고
      // 있는데 다음 답변이 옛 경로에 붙어버린다 — 섞이는 것보다 나쁘다.
      // 실측(2026-08-28): "아니요 사당역에서 서초동으로 바꿔주세요"는 분류기가 unsupported로
      // 읽는다("바꿔주세요"에 접수 동사가 없어서다 — 같은 문장을 "탁송해주세요"로 바꾸면
      // 정상 인식된다). 그 한계는 여기서 못 고치므로, 옛 내용을 지우고 다시 받는다.
      if (restarting) {
        await clearPendingIntake(session);
        return {
          replyText: '앞서 진행하던 접수는 취소했습니다. 새로 접수하실 내용을 "○○에서 ○○까지 탁송" 형태로 알려주시겠어요?',
          ok: true,
          awaitingConfirmation: false,
        };
      }
      // choose_field/offer_agent/unsupported — 이번 범위 밖. 클라이언트가 기존 경로(상담원
      // 제안 등)로 이어가게 그대로 넘긴다. 분류 결과를 함께 넘겨 parse의 재분류를 아낀다.
      return { replyText: null, ok: true, fallthrough: true, classified };
    }
    parsed = buildParsedFromClassified(classified, mergedRaw);
  }

  if (!parsed.complete) {
    await savePendingIntake(session, mergedRaw, parsed.missing);
    return { replyText: restartNotice + buildMissingQuestion(parsed.missing, parsed), ok: true, awaitingConfirmation: false, parsed };
  }

  const done = await finishParsed({ session, parsed, mergedRaw });
  return restartNotice && done.replyText ? { ...done, replyText: restartNotice + done.replyText } : done;
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
    replyText: `${buildIntakeReply(parsed)}\n\n맞으면 "네" 수정하시려면 수정할 항목만 고쳐서 다시 보내주세요`,
    ok: true,
    awaitingConfirmation: true,
    parsed,
  };
}

// 출발지·도착지가 여러 곳으로 검색되면 물어본다. 물어봤으면 그 응답 객체를, 아니면 null을
// 돌려준다. 두 검색은 서로 독립적이라 동시에 시작해두고, 출발지가 애매하면 도착지는 보지도
// 않고 그것부터 묻는다(우선순위, 카카오와 동일). extra는 물어봐야 할 때 저장할 대기 상태에
// 함께 얹을 값 — 프리미엄/일일기사(finishParsedPremium)가 category/orderType/tripType/declined를
// 여기 실어 넘긴다. 이게 없으면 이 함수가 저장하는 대기 상태에 그 값들이 빠져, 주소를 고른 뒤
// handleAddressChoiceReply가 어느 카테고리로 이어가야 할지 알 수 없게 된다.
async function askAddressChoiceIfNeeded({ session, parsed, mergedRaw, cache, extra }) {
  // 경유지도 출발/도착과 같은 원칙으로 확인한다(카카오와 동일) — 현재는 한 번에 경유지
  // 하나만 다룬다(첫 항목).
  const waypoint = (parsed.waypoints || [])[0];
  const sides = [
    { key: 'origin', label: '출발지', query: parsed.origin && parsed.origin.address },
    { key: 'destination', label: '도착지', query: parsed.destination && parsed.destination.address },
    { key: 'waypoint', label: '경유지', query: waypoint && waypoint.address },
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
    // 물어볼 때는 질문을 잘 덮는 후보를 1번에 올린다 — 고객은 대개 "1"이라고 답하므로,
    // 카카오가 준 순서 그대로 두면 엉뚱한 곳이 1번이 되어 잘못 확정될 수 있다.
    const candidates = rankByCoverage(side.query, results[i]);
    if (!needsDisambiguation(side.query, candidates)) continue;

    await savePendingIntake(session, mergedRaw, [], {
      awaiting: 'address_choice', side: side.key, sideLabel: side.label, query: side.query, candidates,
      ...(extra || {}),
    });
    // 아직 확정 전이지만 이 시점의 parsed는 이미 필수 항목이 다 찬 상태라(finishParsed*가
    // 이 함수를 그 시점에만 부른다) 카드 폼에 보여줄 값으로 충분하다 — 주소만 후보 중 하나로
    // 마저 확정되면 된다.
    return { replyText: buildCandidateListText(side.label, candidates), ok: true, awaitingConfirmation: false, parsed };
  }
  return null;
}

// ---- 프리미엄/일일기사 — 탁송과 나란한 흐름 ----
// 시작(분류 직후, 카테고리를 처음 확정) — 경유지는 탁송과 달리 항상 물어보는 필드다
// (getDailyDriverFields, 사용자 확정 규칙) — advancePremiumIntake의 되묻기 루프가 다룬다.
async function startPremiumIntake({ session, mergedRaw, classified, orderType }) {
  const parsed = buildPremiumParsedFromClassified(classified, mergedRaw, {});
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
  const overrides = { tripType: pending.tripType || null, declined: pending.declined || [], immediate: !!pending.immediate };

  if (missing.includes('trip_type')) {
    const t = parseTripTypeBareReply(raw);
    if (t) overrides.tripType = t;
  }
  const declinableMissing = missing.find((id) => PREMIUM_DECLINABLE_FIELD_IDS.has(id));
  if (declinableMissing && PREMIUM_DECLINE_RE.test(raw.trim())) {
    overrides.declined = Array.from(new Set([...overrides.declined, declinableMissing]));
  }
  // 예약일시를 묻는 중에 "즉시"라고 답하면 그게 답이다 — Gemini는 "즉시"에서 날짜를 못 뽑으니
  // 이 지름길이 없으면 같은 질문이 무한히 반복된다(실사용 2026-08-24). 없어→declined와 같다.
  if (missing.includes('reserved_date') && IMMEDIATE_WORDING_RE.test(raw.trim())) {
    overrides.immediate = true;
  }

  let classified;
  try {
    classified = await classifyAndExtract(mergedRaw, null, premiumOrderTypeToIntentHint(pending.orderType));
  } catch (e) {
    console.error('웹 AI 접수(프리미엄/일일기사) 재분류 실패:', e.message);
    return { replyText: '요청을 이해하지 못했습니다. 접수 내용을 다시 말씀해주세요.', ok: false };
  }

  const parsed = buildPremiumParsedFromClassified(classified, mergedRaw, overrides);
  parsed.orderType = pending.orderType;
  return advancePremiumIntake({ session, parsed, mergedRaw });
}

// 다 채워졌는지 보고 되묻거나 마무리로 넘긴다 — 탁송의 완료 판단 분기와 같은 자리.
async function advancePremiumIntake({ session, parsed, mergedRaw }) {
  if (!parsed.complete) {
    await savePendingIntake(session, mergedRaw, parsed.missing, {
      category: 'premium_daily', orderType: parsed.orderType, tripType: parsed.tripType, declined: parsed.declined,
      immediate: !!(parsed.when && parsed.when.immediate),
    });
    const fields = getDailyDriverFields(parsed.tripType);
    return { replyText: buildMissingQuestion(parsed.missing, parsed, null, fields), ok: true, awaitingConfirmation: false, parsed };
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
    replyText: `${buildPremiumPreviewMessage(parsed)}\n\n맞으면 "네" 수정하시려면 수정할 항목만 고쳐서 다시 보내주세요`,
    ok: true,
    awaitingConfirmation: true,
    parsed,
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
    if (!parsed.complete) {
      await savePendingIntake(session, replacedRaw, parsed.missing, {
        category: 'premium_daily', orderType: parsed.orderType, tripType: parsed.tripType, declined: parsed.declined,
      immediate: !!(parsed.when && parsed.when.immediate),
      });
      const fields = getDailyDriverFields(parsed.tripType);
      return {
        replyText: `${pending.sideLabel}를 "${chosen.label}"로 확인했습니다.\n${buildMissingQuestion(parsed.missing, parsed, null, fields)}`,
        ok: true,
        awaitingConfirmation: false,
        parsed,
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
      parsed,
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

  // 자동 등록에 성공했으면 카드 폼 프리필을 비운다(카카오 채널과 동일 원칙, routes/kakaoConsult.js
  // registerDispatchOrder) — 이미 오더가 만들어졌는데 폼이 채워진 채로 남으면 상담원이 같은
  // 건을 한 번 더 등록할 수 있다. parsed를 반환값에 싣지 않아 wrapper가 다시 채우지 않는다.
  await db.run('UPDATE chat_sessions SET draft_json = NULL WHERE id = ?', [session.id])
    .catch((e) => console.error('접수 완료 후 폼 프리필 정리 실패:', e.message));

  return { replyText: result.message, ok: true, closeSession: true };
}

// isAffirmative/isNegative는 카카오 채널과 공유한다(lib/kakaoIntakeParser.js, 위에서 이미
// require했다) — public/js/ai-intake.js의 클라이언트 쪽 isAffirmative와는 판단 취지만 같고
// 별개다(서버·클라이언트가 서로 require할 수 없는 다른 런타임이라).

module.exports = { runWebIntakeTurn };
