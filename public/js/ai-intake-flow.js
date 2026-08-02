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
  };
})();