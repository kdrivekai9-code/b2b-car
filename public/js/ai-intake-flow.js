(function () {
  function buildOfferAgentResumeState(input) {
    var state = input || {};
    return {
      phase: state.phase || 'collecting',
      pendingField: state.pendingField || null,
      pendingDisambiguation: state.pendingDisambiguation || null,
      disambiguationQueue: Array.isArray(state.disambiguationQueue) ? state.disambiguationQueue.slice() : [],
    };
  }

  function normalizeOfferAgentResumeState(state) {
    return buildOfferAgentResumeState(state);
  }

  function getRestorableDraftPhase(phase) {
    if (!phase) return null;
    if (phase === 'choose_address_candidate' || phase === 'offer_agent') return null;
    return phase;
  }

  function getOfferAgentClarifyText() {
    return '상담원 연결이 필요하시면 "네", 계속 진행하시려면 "아니요"라고 답해주세요.';
  }

  function getModifyFlowQuestion() {
    return '어느 부분을 수정해드릴까요?';
  }

  function getConfirmClarifyText() {
    return '등록해 드릴까요, 아니면 수정해 드릴까요?';
  }

  function getChooseFieldClarifyText() {
    return '출발지 주소 / 출발지 연락처 / 차량번호 / 예약일시 / 도착지 주소 / 도착지 연락처 중 어느 항목을 수정할지 말씀해주세요?';
  }

  function buildFieldAskAgainQuestion(field) {
    if (!field) return null;
    return field.label + '를 다시 알려주세요?' + (
      field.type === 'phone' ? ' (예: 010-1234-5678)'
        : field.type === 'datetime' ? ' (예: 내일 오후 3시 / 00일 00시)'
        : field.type === 'vehicle' ? ' (출발지 도착 후 확인 가능하면 "다음" 또는 "없어"라고 답해주셔도 됩니다)'
        : ''
    );
  }

  function matchCandidateChoice(text, candidates) {
    var list = Array.isArray(candidates) ? candidates : [];
    var t = String(text || '').trim();
    if (/^1\s*(번|\.|\))?$/.test(t) || /^첫/.test(t)) return list[0] || null;
    if (/^2\s*(번|\.|\))?$/.test(t) || /^(둘|두\s?번)/.test(t)) return list[1] || null;
    for (var i = 0; i < list.length; i++) {
      if (t.length >= 2 && list[i].label && list[i].label.indexOf(t) !== -1) return list[i];
    }
    return null;
  }

  function getDisambiguationClarifyText() {
    return '1번 또는 2번으로 답해주세요.';
  }

  function getResumeFollowUpQuestion(input) {
    var state = input || {};
    var phase = state.phase || 'collecting';
    if (phase === 'collecting') {
      if (typeof state.getFieldQuestion === 'function' && state.pendingField) {
        var fieldQuestion = state.getFieldQuestion(state.pendingField);
        if (fieldQuestion) return fieldQuestion;
      }
      if (state.pendingField === 'memo_customer') {
        return '추가 요청사항이 있으시면 알려주세요? 없으시면 \'없음\'이라고 답해주세요.';
      }
      return null;
    }
    if (phase === 'confirming') return '위 내용으로 등록해 드릴까요?';
    if (phase === 'choose_field') return state.chooseFieldClarify || null;
    if (phase === 'choose_address_candidate' && state.pendingDisambiguation && typeof state.candidateListText === 'function') {
      return state.candidateListText(state.pendingDisambiguation);
    }
    return null;
  }

  function runConfirmingPhase(input) {
    var ctx = input || {};
    var text = ctx.text || '';
    if (ctx.isAgentRequest && ctx.isAgentRequest(text)) {
      return ctx.onAgent ? ctx.onAgent() : null;
    }
    if (ctx.looksFrustrated && ctx.looksFrustrated(text)) {
      return ctx.onFrustrated ? ctx.onFrustrated() : null;
    }
    if (ctx.isNegative && ctx.isNegative(text)) {
      return ctx.onNegative ? ctx.onNegative() : null;
    }
    if (ctx.isAffirmative && ctx.isAffirmative(text)) {
      return ctx.onAffirmative ? ctx.onAffirmative() : null;
    }
    return ctx.classifyFallback ? ctx.classifyFallback(text, 'confirming').then(function (result) {
      if (result.action === 'agent') return ctx.onAgent ? ctx.onAgent() : null;
      if (result.action === 'no') return ctx.onNegative ? ctx.onNegative() : null;
      if (result.action === 'yes') return ctx.onAffirmative ? ctx.onAffirmative() : null;
      if (ctx.onTrouble && ctx.onTrouble()) return null;
      return ctx.onClarify ? ctx.onClarify() : null;
    }) : null;
  }

  function runDisambiguationPhase(input) {
    var ctx = input || {};
    var text = ctx.text || '';
    if (ctx.isAgentRequest && ctx.isAgentRequest(text)) {
      return ctx.onAgent ? ctx.onAgent() : null;
    }
    if (ctx.looksFrustrated && ctx.looksFrustrated(text)) {
      return ctx.onFrustrated ? ctx.onFrustrated() : null;
    }
    var chosen = matchCandidateChoice(text, ctx.candidates || []);
    if (chosen) return ctx.onChoice ? ctx.onChoice(chosen) : null;
    var candidateLabels = (ctx.candidates || []).map(function (c) { return c.label; });
    return ctx.classifyFallback ? ctx.classifyFallback(text, 'choose_address_candidate', candidateLabels).then(function (result) {
      if (result.action === 'agent') return ctx.onAgent ? ctx.onAgent() : null;
      if (result.action === 'choice1') return ctx.onChoice ? ctx.onChoice((ctx.candidates || [])[0]) : null;
      if (result.action === 'choice2') return ctx.onChoice ? ctx.onChoice((ctx.candidates || [])[1]) : null;
      if (ctx.onTrouble && ctx.onTrouble()) return null;
      return ctx.onClarify ? ctx.onClarify() : null;
    }) : null;
  }

  function runChooseFieldPhase(input) {
    var ctx = input || {};
    var text = ctx.text || '';
    if (ctx.isAgentRequest && ctx.isAgentRequest(text)) {
      return ctx.onAgent ? ctx.onAgent() : null;
    }
    if (ctx.looksFrustrated && ctx.looksFrustrated(text)) {
      return ctx.onFrustrated ? ctx.onFrustrated() : null;
    }
    var field = ctx.matchFieldKeyword ? ctx.matchFieldKeyword(text) : null;
    if (field) return ctx.onField ? ctx.onField(field, text) : null;

    return ctx.classifyFallback ? ctx.classifyFallback(text, 'choose_field').then(function (result) {
      if (result.action === 'agent') return ctx.onAgent ? ctx.onAgent() : null;
      if (result.action === 'field' && result.field) return ctx.onClassifiedField ? ctx.onClassifiedField(result.field, text) : null;
      if (result.action === 'none') return ctx.onNone ? ctx.onNone() : null;
      if (ctx.onTrouble && ctx.onTrouble()) return null;
      return ctx.onClarify ? ctx.onClarify() : null;
    }) : null;
  }

  function dispatchPhase(input) {
    var ctx = input || {};
    var phase = ctx.phase || 'collecting';
    var pendingField = ctx.pendingField || null;
    var text = ctx.text || '';

    function handled(value) {
      return { handled: true, value: value };
    }

    if (phase === 'offer_agent') return handled(ctx.onOfferAgent ? ctx.onOfferAgent(text) : null);
    if (phase === 'confirming') return handled(ctx.onConfirming ? ctx.onConfirming(text) : null);
    if (phase === 'choose_field') return handled(ctx.onChooseField ? ctx.onChooseField(text) : null);
    if (phase === 'choose_address_candidate') return handled(ctx.onDisambiguation ? ctx.onDisambiguation(text) : null);
    if (phase === 'collecting' && pendingField === 'memo_customer') {
      return handled(ctx.onAdditionalRequest ? ctx.onAdditionalRequest(text) : null);
    }
    if (phase === 'collecting' && pendingField === 'vehicle_number') {
      return handled(ctx.onVehicleNumber ? ctx.onVehicleNumber(text) : null);
    }
    return { handled: false, value: ctx.onDefault ? ctx.onDefault(text) : null };
  }

  // ----------------  일일기사/프리미엄 전용 FSM 헬퍼 ----------------

  // 일일기사 신호 패턴 — 8시간 이상 문구 또는 명시적 대절/기사 대여 키워드
  var DAILY_DRIVER_WORDING_RE = /일일\s*기사|기사\s*대절|하루\s*기사|종일\s*기사|8시간\s*이상|8\s*시간\s*이상|하루\s*종일|하루\s*빌려|기사\s*대여/;

  // 골프장 판별 패턴 (§5)
  var GOLF_VENUE_RE = /골프장|골프클럽|컨트리클럽|\bCC\b|\bGC\b/;

  // 왕복/편도 응답 파싱
  function parseTripTypeResponse(text) {
    var t = String(text || '').trim();
    if (/^1\s*(번|\.|\))?$/.test(t) || /왕복/.test(t)) return 'round_trip';
    if (/^2\s*(번|\.|\))?$/.test(t) || /편도/.test(t)) return 'one_way';
    return null;
  }

  // 대기시간 있는지 여부 응답 파싱 — 있으면 true, 없으면 false, 모르면 null
  function parseWaitYesNo(text) {
    var t = String(text || '').trim();
    if (/(없|0분|없어|아니오|아니요|안\s*있|no)/i.test(t)) return false;
    if (/(있|예|네|응|있어요|있습니다|yes)/i.test(t)) return true;
    return null;
  }

  // 대기시간 숫자 파싱(분) — "60분", "1시간", "잘모른다" → null
  function parseWaitMinutes(text) {
    var t = String(text || '').trim();
    if (/(잘\s*모르|몰라|미정|나중|확인\s*후|모름)/.test(t)) return -1; // -1 = "모름" 마킹
    var h = t.match(/(\d+)\s*시간/);
    var m = t.match(/(\d+)\s*분/);
    var mins = 0;
    if (h) mins += Number(h[1]) * 60;
    if (m) mins += Number(m[1]);
    if (mins > 0) return mins;
    var direct = t.match(/^(\d+)$/);
    if (direct) return Number(direct[1]);
    return null;
  }

  // 시간구간 응답 파싱 (§7-1)
  function parseHoursBracket(text) {
    var t = String(text || '').trim();
    if (/^1\s*(번|\.|\))?$/.test(t) || /4시간\s*이내/.test(t)) return 'within_4h';
    if (/^2\s*(번|\.|\))?$/.test(t) || /8시간\s*이내/.test(t)) return 'within_8h';
    if (/^3\s*(번|\.|\))?$/.test(t) || /8시간\s*이상/.test(t)) return 'over_8h';
    return null;
  }

  // 일일기사/프리미엄 FSM 전용 필드(수집 순서 반환)
  function getDailyDriverFields(tripType) {
    var fields = [
      { id: 'trip_type', label: '이용 형태(왕복/편도)', question: '이용 형태를 선택해 주세요.\n1. 왕복  2. 편도' },
      { id: 'reserved_date', label: '예약일시', type: 'datetime', question: '예약시간을 말씀해주세요? (예: 내일 오후 3시 출발)' },
      { id: 'origin_address', label: '출발지 주소', type: 'address', kind: 'origin', question: '출발지 주소를 알려주세요?' },
      { id: 'origin_contact', label: '출발지 연락처', type: 'phone', question: '출발지 담당자 연락처를 알려주세요? (예: 010-1234-5678)' },
      { id: 'vehicle_number', label: '차량번호', type: 'vehicle', question: '차량번호를 알려주세요? (모르시면 "없어"라고 답해주세요)' },
      { id: 'waypoints', label: '경유지', question: '경유지가 있으신가요? (있으면 주소를 알려주시고, 없으면 "없어"라고 답해주세요)' },
      { id: 'destination_address', label: '도착지 주소', type: 'address', kind: 'destination', question: '도착지 주소를 알려주세요?' },
      { id: 'destination_wait', label: '도착지 대기시간', question: '도착지에서 대기 시간이 있으신가요?' },
    ];
    if (tripType === 'round_trip') {
      fields.push({ id: 'final_destination_address', label: '최종 목적지(복귀 주소)', type: 'address', kind: 'final_destination', question: '최종 목적지(기사가 돌아올 주소)를 알려주세요?' });
    }
    fields.push({ id: 'memo_customer', label: '기사 전달사항', question: '기사 전달사항이 있으신가요? (없으면 "없어"라고 답해주세요)' });
    return fields;
  }

  function isDailyDriverIntent(text) {
    return DAILY_DRIVER_WORDING_RE.test(String(text || ''));
  }

  function isGolfVenue(address) {
    return GOLF_VENUE_RE.test(String(address || ''));
  }

  window.AiIntakeFlow = {
    buildOfferAgentResumeState: buildOfferAgentResumeState,
    normalizeOfferAgentResumeState: normalizeOfferAgentResumeState,
    getRestorableDraftPhase: getRestorableDraftPhase,
    getOfferAgentClarifyText: getOfferAgentClarifyText,
    getResumeFollowUpQuestion: getResumeFollowUpQuestion,
    runConfirmingPhase: runConfirmingPhase,
    runDisambiguationPhase: runDisambiguationPhase,
    runChooseFieldPhase: runChooseFieldPhase,
    dispatchPhase: dispatchPhase,
    getModifyFlowQuestion: getModifyFlowQuestion,
    getConfirmClarifyText: getConfirmClarifyText,
    getChooseFieldClarifyText: getChooseFieldClarifyText,
    buildFieldAskAgainQuestion: buildFieldAskAgainQuestion,
    matchCandidateChoice: matchCandidateChoice,
    getDisambiguationClarifyText: getDisambiguationClarifyText,
    // 일일기사/프리미엄 전용
    DAILY_DRIVER_WORDING_RE: DAILY_DRIVER_WORDING_RE,
    isDailyDriverIntent: isDailyDriverIntent,
    isGolfVenue: isGolfVenue,
    parseTripTypeResponse: parseTripTypeResponse,
    parseWaitYesNo: parseWaitYesNo,
    parseWaitMinutes: parseWaitMinutes,
    parseHoursBracket: parseHoursBracket,
    getDailyDriverFields: getDailyDriverFields,
  };
})();