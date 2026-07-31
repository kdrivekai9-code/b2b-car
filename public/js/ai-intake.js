// AI 챗봇(하이브리드): 붙여넣은 텍스트를 Gemini로 분류해
// 오더접수 요청이면 출발지/경유지/도착지/연락처/차량번호/메모를 자동으로 채우고,
// FAQ성 질문이면 지식베이스에서 찾은 답변을 챗 말풍선으로 보여준다.
//
// 필수 항목(출발지/도착지 주소·연락처)이 채워질 때마다 챗봇이 그 자리에서 확인 메시지를 보여준다:
// - 주소/상호는 실제 카카오 검색 결과로 확정해 알려주고, 검색이 안 되면 그 항목만 다시 물어본다.
// - 전화번호는 형식을 검사해 하이픈 포맷으로 확인해주고, 형식이 틀리면 그 항목만 다시 물어본다.
// 모든 필수 항목이 확인되면 전체 내용을 요약해 보여주고 "등록해 드릴까요?"라고 물어서
// 긍정 답변이면 실제 등록(폼 제출)까지 진행하고, 부정 답변이면 어느 항목을 고칠지 물어
// 해당 항목만 다시 확인 후 등록 여부를 재확인하는 루프를 돈다(수정 모드).
//
// 봇이 처리 못하는 요청(intent: unsupported)이 오면 관리자에게 상담원 호출 알림을 보내고,
// 이후부터는 봇 대신 상담원의 응답을 실시간으로 받아 보여준다(세션은 /chat 라우트에 영속화).
// 실시간 수신은 Supabase Realtime Broadcast를 서버가 SSE로 중계하는 방식 — 브라우저는
// Supabase 키를 전혀 알 필요가 없다(EventSource + 우리 서버 세션 인증만 사용).
(function () {
  var textarea = document.getElementById('aiIntakeText');
  var sendBtn = document.getElementById('aiSendBtn');
  var messages = document.getElementById('aiChatMessages');
  var addWaypointBtn = document.getElementById('addWaypointBtn');
  var quickRepliesEl = document.getElementById('aiQuickReplies');
  var aiConnectionEl = document.getElementById('aiChatConnection');
  var aiConnectionTextEl = document.getElementById('aiChatConnectionText');
  if (!textarea || !sendBtn || !messages) return;

  var CHAT_INPUT_COLLAPSED_HEIGHT = 64;
  var CHAT_INPUT_MAX_HEIGHT = 180;

  function scrollMessagesToBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  function collapseChatInput() {
    textarea.style.height = CHAT_INPUT_COLLAPSED_HEIGHT + 'px';
  }

  function autoResizeChatInput() {
    textarea.style.height = 'auto';
    var next = Math.max(CHAT_INPUT_COLLAPSED_HEIGHT, Math.min(textarea.scrollHeight, CHAT_INPUT_MAX_HEIGHT));
    textarea.style.height = next + 'px';
  }

  var REQUIRED_FIELDS = [
    { id: 'origin_address', label: '출발지 주소', type: 'address', kind: 'origin', question: '차량을 픽업할 출발지 주소를 알려주세요?' },
    { id: 'origin_contact', label: '출발지 연락처', type: 'phone', question: '출발지 담당자 연락처를 알려주세요? (예: 010-1234-5678)' },
    { id: 'vehicle_number', label: '차량번호', type: 'vehicle', question: '차량번호를 알려주세요? (출발지 도착 후 확인 가능하면 "다음" 또는 "없어"라고 답해주셔도 됩니다)' },
    { id: 'reserved_date', label: '예약일시', type: 'datetime', question: '예약일시를 알려주세요? (예: 내일 오후 3시 / 00일 00시)' },
    { id: 'destination_address', label: '도착지 주소', type: 'address', kind: 'destination', question: '차량을 인도할 도착지 주소를 알려주세요?' },
    { id: 'destination_contact', label: '도착지 연락처', type: 'phone', question: '도착지 담당자 연락처를 알려주세요? (예: 010-1234-5678)' },
  ];
  // 채팅으로 "수정"을 물어볼 때 자연어로 어느 항목인지 알아듣기 위한 키워드 매칭.
  // 차량번호를 맨 앞에 둔다 — "차량번호 출발 전에 다시 확인해주세요"처럼 "출발"/"도착"이
  // 우연히 함께 들어간 문장이 뒤쪽 일반 패턴에 먼저 걸려 엉뚱한 필드로 잘못 라우팅되는 걸 막는다.
  var FIELD_KEYWORDS = [
    { re: /차량\s?번호|번호판/, id: 'vehicle_number' },
    { re: /예약\s?일시|예약\s?날짜|예약\s?시간/, id: 'reserved_date' },
    { re: /출발.*(연락처|전화)/, id: 'origin_contact' },
    { re: /출발/, id: 'origin_address' },
    { re: /도착.*(연락처|전화)/, id: 'destination_contact' },
    { re: /도착/, id: 'destination_address' },
  ];

  // 차량번호 질문에서 "출발지 도착 후 알려주겠다"는 취지의 답변은 차량번호 없이 넘어간다.
  var VEHICLE_NUMBER_SKIP_RE = /^(다음|없어요?|없습니다|없음|모르겠어요?|모름|몰라요?|아직\s*몰라요?|출발지에서\s*(확인|알려\S*|말씀\S*)|현장에서\s*(확인|알려\S*)|나중에\s*(확인|알려\S*)|미정|스킵|skip|패스|pass)[.!~\s]*$/i;
  // 차량번호 형식이 이 횟수만큼 연속으로 틀리면 포기하고 다음 질문으로 넘어간다.
  var VEHICLE_NUMBER_MAX_ATTEMPTS = 2;
  var vehicleNumberFailCount = 0;
  // "추가 요청사항 있으시면 알려주세요" 질문에서 요청사항이 없다는 취지의 답변.
  var ADDITIONAL_REQUEST_NONE_RE = /^(없어요?|없습니다|없음|딱히\s?없어요?|특별히\s?없어요?|아니오|아니요|괜찮아요?|no)[.!~\s]*$/i;

  var pendingField = null;
  var modifyFieldMode = false; // pendingField 응답이 "수정 요청"에 대한 답변인지 구분
  var lastModifiedFieldId = null;
  // reserved_date/reserved_time 입력칸은 폼 기본값으로 "지금 시각"이 항상 미리 채워져 있어서
  // (일반 오더 등록 화면 UX를 위한 기본값) 값이 비어있는지만으로는 "사용자가 실제로 예약일시를
  // 알려줬는지"를 판단할 수 없다 — 그래서 실제로 챗봇이 예약일시를 확인해준 적이 있는지 별도로 추적한다.
  var reservedDateTimeConfirmed = false;
  // 차량번호는 폼 기본값이 비어있어 "값이 없음"과 "아직 안 물어봄"을 구분할 수 없다(스킵한 경우
  // 값은 계속 비어있는 게 정상이라서) — 질문을 실제로 마쳤는지(스킵/확인/포기 불문) 별도로 추적한다.
  var vehicleNumberResolved = false;
  // "추가 요청사항" 질문도 마찬가지 이유로 별도 추적한다(응답이 "없음"이면 memo가 계속 빈 채로 남는다).
  var additionalRequestResolved = false;
  // 이번 대화에서 오더유형(탁송/대리/일일기사)이 몇 번째 메시지에서 정해졌는지와 무관하게 한 번만
  // 안내하기 위한 추적 — 확정되면 우측 "오더 접수 내용" 패널 옆에도 배지로 표시한다.
  var confirmedOrderType = null;
  // 검증 실패/못 알아들음이 연속으로 쌓이면(형식 오류, 주소 검색 실패, "1번/2번으로 답해주세요" 반복 등)
  // 사용자가 답답해할 가능성이 높다고 보고 상담원 연결을 먼저 제안한다. 뭔가 하나라도 성공하면 초기화된다.
  var troubleStreak = 0;
  var TROUBLE_STREAK_LIMIT = 3;
  // 상담원 연결 제안 중 "아니요, 계속할게요"를 선택하면 원래 하던 질문/단계로 그대로 돌아가야 하므로,
  // 제안하기 직전 상태를 여기 담아둔다.
  var preOfferState = null;
  // Gemini가 이번 메시지에서 화남/답답함을 감지했으면(seemsFrustrated) true — 그 메시지의 내용은
  // 평소대로 처리(필드 확인 등)하되, 다음 질문 대신 상담원 연결 제안을 먼저 보여주기 위한 플래그.
  var pendingFrustrationOffer = false;
  var phase = 'collecting'; // 'collecting' | 'confirming' | 'choose_field' | 'choose_address_candidate' | 'offer_agent'
  var pendingDisambiguation = null; // { fieldId, label, candidates } — 지금 사용자에게 확인받는 중인 주소 후보
  var disambiguationQueue = []; // 한 턴에 모호한 주소가 여러 개면 순서대로 처리하기 위한 대기열
  var sessionId = null;
  var sessionStatus = 'bot';
  var lastWaitingStatusShown = null; // 'needs_agent'/'agent_active' 대기 안내를 마지막으로 보여준 상태 — 같은 상태 반복이면 다시 안 보여줌
  var lastPolledId = 0;
  var isComposing = false;
  var submitAfterCompositionEnd = false;
  var fareProgressEl = null;
  var fareInquiryDraft = null;
  var fareInquiryPendingField = null;
  var lastAnnouncedMemoText = '';
  var lastAiActivityPingAt = 0;
  var AI_ACTIVITY_PING_INTERVAL_MS = 15000;
  var AI_HEALTH_POLL_INTERVAL_MS = 60000;
  var AI_HEALTH_REASON_MESSAGES = {
    session_missing: '로그인이 필요합니다. 다시 로그인해주세요.',
    idle: '세션이 만료되었습니다. 다시 로그인해주세요.',
    absolute: '장시간 사용하지 않아 세션이 만료되었습니다.',
    replaced: '다른 곳에서 로그인되어 종료되었습니다.',
    ai_server: 'AI 서버 응답이 지연되고 있습니다.',
    ai_unavailable: 'AI 서버에 일시적인 문제가 있습니다.',
  };
  var ORDER_INTENTS = { dispatch_order: true, proxy_order: true, daily_driver_order: true };
  var ORDER_INTENT_LABELS = {
    dispatch_order: '탁송 오더접수',
    proxy_order: '대리 오더접수',
    daily_driver_order: '일일기사 접수',
  };
  function isOrderIntent(intent) {
    return !!ORDER_INTENTS[String(intent || '')];
  }

  function updateOrderTypeBadge(intent) {
    var badge = document.getElementById('orderTypeBadge');
    if (!badge) return;
    var label = ORDER_INTENT_LABELS[intent];
    if (!label) { badge.style.display = 'none'; return; }
    badge.textContent = '(' + label + ')';
    badge.style.display = '';
  }

  function setAiConnectionStatus(state, detail) {
    if (!aiConnectionEl || !aiConnectionTextEl) return;
    aiConnectionEl.classList.remove('online', 'offline');
    aiConnectionEl.removeAttribute('title');
    if (state === 'online') {
      aiConnectionEl.classList.add('online');
      aiConnectionTextEl.textContent = 'AI 연결 정상';
      aiConnectionEl.title = 'AI 연결 정상';
      return;
    }
    if (state === 'offline') {
      aiConnectionEl.classList.add('offline');
      var reasonText = detail && detail.message ? detail.message : 'AI 연결 실패';
      aiConnectionTextEl.textContent = 'AI 연결 실패';
      aiConnectionEl.title = reasonText;
      aiConnectionEl.setAttribute('aria-label', 'AI 연결 실패: ' + reasonText);
      return;
    }
    aiConnectionTextEl.textContent = 'AI 연결 확인중';
    aiConnectionEl.title = 'AI 연결 확인중';
  }

  function touchAiActivity(force) {
    var now = Date.now();
    if (!force && now - lastAiActivityPingAt < AI_ACTIVITY_PING_INTERVAL_MS) return;
    lastAiActivityPingAt = now;
    fetch('/orders/ai-intake/activity', {
      method: 'POST',
      headers: { 'X-Requested-With': 'fetch' },
    }).catch(function () {});
  }

  function checkAiConnectionHealth() {
    if (!aiConnectionEl) return Promise.resolve(null);
    setAiConnectionStatus('checking');
    return fetch('/orders/ai-intake/health', {
      method: 'GET',
      headers: { 'X-Requested-With': 'fetch' },
    })
      .then(function (res) {
        return res.json().catch(function () { return { ok: false }; }).then(function (data) {
          var ok = !!(res.ok && data && data.ok);
          if (ok) {
            setAiConnectionStatus('online');
            return true;
          }
          var reason = data && data.reason ? String(data.reason) : 'ai_unavailable';
          var message = data && data.message ? String(data.message) : (AI_HEALTH_REASON_MESSAGES[reason] || AI_HEALTH_REASON_MESSAGES.ai_unavailable);
          setAiConnectionStatus('offline', { reason: reason, message: message });
          return ok;
        });
      })
      .catch(function () {
        setAiConnectionStatus('offline', { reason: 'ai_unavailable', message: AI_HEALTH_REASON_MESSAGES.ai_unavailable });
        return false;
      });
  }

  function fieldMetaFor(id) {
    for (var i = 0; i < REQUIRED_FIELDS.length; i++) if (REQUIRED_FIELDS[i].id === id) return REQUIRED_FIELDS[i];
    return null;
  }

  function appendTextWithAutoBold(container, text) {
    var raw = String(text == null ? '' : text);
    var re = /\*\*[^*\n]+\*\*|'[^'\n]+'|\d{1,3}(?:,\d{3})*원|\d+(?:\.\d+)?km/g;
    var last = 0;
    var match;
    while ((match = re.exec(raw)) !== null) {
      var index = match.index;
      if (index > last) {
        container.appendChild(document.createTextNode(raw.slice(last, index)));
      }
      var strong = document.createElement('strong');
      strong.textContent = match[0].indexOf('**') === 0 ? match[0].slice(2, -2) : match[0];
      container.appendChild(strong);
      last = index + match[0].length;
    }
    if (last < raw.length) {
      container.appendChild(document.createTextNode(raw.slice(last)));
    }
  }

  function parseKstDateTime(raw) {
    if (!raw) return null;
    if (raw instanceof Date) return raw;
    var s = String(raw).trim();
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?$/);
    if (!m) {
      var d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    }
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0);
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatBubbleTime(raw) {
    var d = parseKstDateTime(raw) || new Date();
    var hour = d.getHours();
    var minute = d.getMinutes();
    var ampm = hour < 12 ? '오전' : '오후';
    var hour12 = hour % 12 || 12;
    return ampm + ' ' + pad2(hour12) + ':' + pad2(minute);
  }

  function formatRecentDateTime(raw) {
    var d = parseKstDateTime(raw);
    if (!d) return '';
    return String(d.getMonth() + 1) + '.' + String(d.getDate());
  }

  function streamPlainText(container, text, onDone) {
    var raw = String(text == null ? '' : text);
    if (!raw) {
      if (typeof onDone === 'function') onDone();
      return;
    }
    var idx = 0;
    var step = Math.max(1, Math.ceil(raw.length / 120));
    (function tick() {
      idx = Math.min(raw.length, idx + step);
      container.textContent = raw.slice(0, idx);
      scrollMessagesToBottom();
      if (idx >= raw.length) {
        if (typeof onDone === 'function') onDone();
        return;
      }
      setTimeout(tick, 14);
    })();
  }

  // 시간 표시는 말풍선(배경색이 있는 박스) 안쪽이 아니라 바깥쪽에 붙인다 — 말풍선 div와 별개로
  // .ai-chat-row 래퍼에 형제 엘리먼트로 넣는다. user는 말풍선 왼쪽에, bot/agent는 말풍선 아래쪽에 둔다.
  function appendBubbleRow(bubbleDiv, who, timeText) {
    var row = document.createElement('div');
    row.className = 'ai-chat-row ' + (who === 'user' ? 'ai-row-user' : 'ai-row-start');
    var timeEl = document.createElement('span');
    timeEl.className = 'bubble-time';
    timeEl.textContent = timeText;
    if (who === 'user') {
      row.appendChild(timeEl);
      row.appendChild(bubbleDiv);
    } else {
      row.appendChild(bubbleDiv);
      row.appendChild(timeEl);
    }
    messages.appendChild(row);
    return row;
  }

  // isQuestion: 사용자에게 다음 답을 요구하는 말풍선(필수항목 질문/확인질문/후보선택 등)에만
  // true로 넘긴다 — 정보 전달용 응답과 구분되도록 배경색을 다르게(하늘색) 표시한다.
  function addBubble(text, who, createdAt, isQuestion) {
    var div = document.createElement('div');
    div.className = 'ai-chat-bubble ' + (who === 'user' ? 'ai-user' : (who === 'agent' ? 'ai-agent' : 'ai-bot'));
    if (who === 'bot' && isQuestion) div.className += ' ai-bot-question';
    var timeText = formatBubbleTime(createdAt);

    if (who === 'agent') {
      var label = document.createElement('span');
      label.className = 'bubble-label';
      label.textContent = '상담원';
      div.appendChild(label);
      var agentBody = document.createElement('div');
      agentBody.textContent = text;
      div.appendChild(agentBody);
    } else if (who === 'bot') {
      var botBody = document.createElement('div');
      var rawText = String(text == null ? '' : text);
      streamPlainText(botBody, rawText, function () {
        botBody.textContent = '';
        appendTextWithAutoBold(botBody, rawText);
        collapseChatInput();
        scrollMessagesToBottom();
      });
      div.appendChild(botBody);
    } else {
      var userText = document.createElement('span');
      userText.textContent = text;
      div.appendChild(userText);
    }
    appendBubbleRow(div, who, timeText);
    if (who !== 'user') collapseChatInput();
    scrollMessagesToBottom();
  }

  function ensureFareProgressLine() {
    if (fareProgressEl && fareProgressEl.parentNode) return fareProgressEl;
    var row = document.createElement('div');
    row.className = 'ai-chat-inline-status';
    var spinner = document.createElement('span');
    spinner.className = 'ai-chat-inline-spinner';
    var text = document.createElement('span');
    text.className = 'ai-chat-inline-status-text';
    row.appendChild(spinner);
    row.appendChild(text);
    messages.appendChild(row);
    scrollMessagesToBottom();
    fareProgressEl = row;
    return row;
  }

  function updateFareProgressLine(step, text) {
    var row = ensureFareProgressLine();
    var textEl = row.querySelector('.ai-chat-inline-status-text');
    if (textEl) textEl.textContent = step + '/4 ' + text;
    row.classList.remove('done');
    scrollMessagesToBottom();
  }

  function finishFareProgressLine(text) {
    if (!fareProgressEl || !fareProgressEl.parentNode) return;
    if (text) {
      var textEl = fareProgressEl.querySelector('.ai-chat-inline-status-text');
      if (textEl) textEl.textContent = text;
    }
    fareProgressEl.classList.add('done');
    setTimeout(function () {
      if (!fareProgressEl) return;
      if (fareProgressEl.parentNode) fareProgressEl.parentNode.removeChild(fareProgressEl);
      fareProgressEl = null;
    }, 1200);
  }

  function clearFareProgressLine() {
    if (!fareProgressEl) return;
    if (fareProgressEl.parentNode) fareProgressEl.parentNode.removeChild(fareProgressEl);
    fareProgressEl = null;
  }

  // 원문 검색이 실패해 Gemini 보정 검색어로 다시 찾은 주소를 확인해줄 때, 바뀐 이름만 굵게
  // 강조해서 보여준다 — innerHTML 대신 텍스트 노드 + <b> 엘리먼트를 직접 조립해서 사용자가
  // 입력한 값이 우연히 HTML 태그처럼 보여도 그대로 이스케이프 없이 삽입되는 일(XSS)이 없게 한다.
  function addAddressChangeBubble(label, oldName, newName) {
    var div = document.createElement('div');
    div.className = 'ai-chat-bubble ai-bot';
    var textWrap = document.createElement('div');
    textWrap.appendChild(document.createTextNode(label + '는 ' + oldName + ' → '));
    var b = document.createElement('b');
    b.textContent = newName;
    textWrap.appendChild(b);
    textWrap.appendChild(document.createTextNode('(으)로 확인했습니다.'));
    div.appendChild(textWrap);
    appendBubbleRow(div, 'bot', formatBubbleTime(null));
    collapseChatInput();
    scrollMessagesToBottom();
  }

  // 출발지/도착지 연락처를 물어보는 순간에만, 굳이 타이핑하지 않아도 되는 값(본인 연락처,
  // 출발지 연락처)을 "빠른 답장" 칩으로 보여준다 — 누르면 그 값을 그대로 답한 것처럼 처리한다.
  function updateQuickReplies() {
    if (!quickRepliesEl) return;
    quickRepliesEl.innerHTML = '';
    quickRepliesEl.style.display = 'none';
    if (phase !== 'collecting' || !pendingField) return;

    var suggestion = null;
    if (pendingField === 'origin_contact') {
      var orderForm = document.getElementById('orderForm');
      var myPhone = orderForm ? orderForm.dataset.myPhone : '';
      if (myPhone) suggestion = { label: '요청자(본인) 연락처와 동일 (' + myPhone + ')', value: myPhone };
    } else if (pendingField === 'destination_contact') {
      var originPhone = val('origin_contact');
      if (originPhone) suggestion = { label: '출발지 연락처와 동일 (' + originPhone + ')', value: originPhone };
    }
    if (!suggestion) return;

    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ai-quick-reply-chip';
    chip.textContent = '📱 ' + suggestion.label;
    chip.addEventListener('click', function () { applyQuickReplyPhone(suggestion.value); });
    quickRepliesEl.appendChild(chip);
    quickRepliesEl.style.display = '';
  }

  // pendingField를 바꾸는 모든 자리에서 이 함수를 통해서만 바꾼다 — 질문이 바뀔 때마다
  // 빠른 답장 칩도 항상 최신 상태로 다시 그려지게 하기 위함(따로따로 챙기면 누락되기 쉽다).
  function setPendingField(value) {
    pendingField = value;
    updateQuickReplies();
  }

  function applyQuickReplyPhone(phoneValue) {
    if (sendBtn.dataset.processing === '1' || phase !== 'collecting' || !pendingField) return;
    var field = fieldMetaFor(pendingField);
    if (!field) return;
    sendBtn.dataset.processing = '1';
    updateSendButton();
    quickRepliesEl.style.display = 'none';
    addBubble(phoneValue, 'user');
    document.getElementById(field.id).value = phoneValue;
    ensureSession()
      .then(function () { return logUserMessage(phoneValue); })
      .then(function () {
        return validatePhoneField(field.id, field.label).then(function () {
          var doneText = proceedAfterCollecting();
          return logBotMessage({ logText: doneText, needsAgent: false, requestedFeature: null });
        });
      })
      .finally(function () {
        delete sendBtn.dataset.processing;
        updateSendButton();
      });
  }

  // Gemini 분류 응답을 기다리는 동안(콜드스타트 등으로 몇 초~수십 초 걸릴 수 있음) 아무 반응이
  // 없으면 멈춘 것처럼 느껴져 새로고침/이탈하는 경우가 있었다 — 대기 중임을 즉시 알려주는 말풍선.
  // 실제 응답이 오면 제거한다.
  var thinkingBubbleEl = null;
  function showThinkingBubble() {
    hideThinkingBubble();
    thinkingBubbleEl = document.createElement('div');
    thinkingBubbleEl.className = 'ai-chat-bubble ai-bot ai-thinking';
    thinkingBubbleEl.textContent = '확인하고 있어요...';
    messages.appendChild(thinkingBubbleEl);
    scrollMessagesToBottom();
  }
  function hideThinkingBubble() {
    if (thinkingBubbleEl && thinkingBubbleEl.parentNode) thinkingBubbleEl.remove();
    thinkingBubbleEl = null;
  }

  function setField(id, value) {
    var el = document.getElementById(id);
    if (el && value) { el.value = value; el.disabled = false; }
  }

  // 예약 시간은 시/분 드롭다운(분은 10분 단위 6개)으로 입력받지만, Gemini가 자연어("오후 2시 15분")에서
  // 뽑아낸 값은 10분 단위가 아닐 수 있다 — 가장 가까운 10분 단위로 반올림해서 드롭다운과 항상 맞게 한다.
  function roundToTenMinutes(hhmm) {
    var parts = String(hhmm || '').split(':');
    var hour = parseInt(parts[0], 10);
    var minute = parseInt(parts[1], 10);
    if (isNaN(hour) || isNaN(minute)) return hhmm;
    minute = Math.round(minute / 10) * 10;
    if (minute >= 60) { minute = 0; hour = (hour + 1) % 24; }
    return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
  }

  // 챗봇이 reserved_time 히든 필드를 직접 채운 뒤(setField, restoreDraftState 등) 화면에 보이는
  // 시/분 드롭다운도 그 값을 따라가도록 맞춰준다 — 안 하면 히든 값과 화면이 서로 어긋나 보인다.
  function syncReservedTimeSelectsFromHidden() {
    var hidden = document.getElementById('reserved_time');
    var hourSelect = document.getElementById('reserved_time_hour');
    var minuteSelect = document.getElementById('reserved_time_minute');
    if (!hidden || !hourSelect || !minuteSelect || !hidden.value) return;
    var parts = hidden.value.split(':');
    if (parts[0]) hourSelect.value = parts[0];
    if (parts[1]) minuteSelect.value = parts[1];
  }

  function kindForAddressId(id) {
    if (id === 'origin_address') return 'origin';
    if (id === 'destination_address') return 'destination';
    return 'waypoint';
  }

  // "내일 오후 4시" 같은 상대적 표현 대신, 실제로 확정된 날짜(요일 포함)로 확인해준다.
  var WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
  function formatReservedDateTime(dateStr, timeStr) {
    if (!dateStr || !timeStr) return null;
    var dParts = dateStr.split('-');
    if (dParts.length !== 3) return null;
    var dt = new Date(Number(dParts[0]), Number(dParts[1]) - 1, Number(dParts[2]));
    if (isNaN(dt.getTime())) return null;
    var tParts = timeStr.split(':');
    var hour = Number(tParts[0]);
    var minute = Number(tParts[1] || 0);
    var ampm = hour < 12 ? '오전' : '오후';
    var hour12 = hour % 12 || 12;
    var minuteText = minute ? ' ' + minute + '분' : '';
    return Number(dParts[1]) + '월 ' + Number(dParts[2]) + '일 ' + WEEKDAY_KO[dt.getDay()] + '요일 ' + ampm + ' ' + hour12 + '시' + minuteText;
  }

  function detectReservationBasisFromText(text) {
    var raw = String(text || '');
    var hasPickup = /(픽업|출발)/.test(raw);
    var hasDelivery = /(도착요망|도착|인도)/.test(raw);
    if (hasPickup) return 'pickup';
    if (hasDelivery) return 'delivery';
    return null;
  }

  function isDeliveryReservationBasis() {
    var deliveryRadio = document.getElementById('reservation_basis_delivery');
    return !!(deliveryRadio && deliveryRadio.checked);
  }

  function applyReservationBasisByText(text) {
    var basis = detectReservationBasisFromText(text);
    if (!basis) return;
    var pickupRadio = document.getElementById('reservation_basis_pickup');
    var deliveryRadio = document.getElementById('reservation_basis_delivery');
    if (!pickupRadio || !deliveryRadio) return;
    var target = basis === 'delivery' ? deliveryRadio : pickupRadio;
    target.checked = true;
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function formatPickupExpectedTimeText() {
    var dateEl = document.getElementById('pickup_reserved_date');
    var timeEl = document.getElementById('pickup_reserved_time');
    var dateText = dateEl ? String(dateEl.value || '').trim() : '';
    var timeText = timeEl ? String(timeEl.value || '').trim() : '';
    if (!dateText || !timeText) return null;
    var hm = timeText.match(/^(\d{2}):(\d{2})$/);
    if (!hm) return null;
    var hour = Number(hm[1]);
    var minute = Number(hm[2]);
    var ampm = hour < 12 ? '오전' : '오후';
    var hour12 = hour % 12 || 12;
    return ampm + ' ' + hour12 + '시 ' + pad2(minute) + ' 분';
  }

  // 주소/상호 입력을 실제 카카오 검색으로 확정 — 성공하면 확인 말풍선, 실패하면 그 항목만 비우고 재요청 말풍선.
  // 검색어가 모호해서(예: "OO주차장") 결과가 갈리면 addBubble 없이 { ambiguous:true, ... }만 반환하고,
  // 실제 확인 질문은 호출부(handleOrderIntent)가 모든 필드 처리를 마친 뒤 한 번에 물어보게 한다.
  function validateAddressField(id, label) {
    // 나중에 값이 바뀌기 전에(카카오/Gemini가 필드를 실제 확정 주소로 덮어쓰기 전에) 사용자가
    // 처음 입력한 원문을 미리 잡아둔다 — "OOO 검색결과가 없습니다" 안내에 이 원문을 쓴다.
    var originalInput = (document.getElementById(id) || {}).value || '';
    var resolver = window.__aiIntakeResolveAddress;
    var shownNoResult = false;
    var shownRetryStart = false;
    var task = resolver ? resolver(id, kindForAddressId(id), function (status) {
      if (!status || typeof status !== 'object') return;
      if (status.type === 'no_result' && !shownNoResult) {
        shownNoResult = true;
        addBubble(originalInput + ' 검색결과가 없습니다.', 'bot');
      }
      if (status.type === 'retry_start' && !shownRetryStart) {
        shownRetryStart = true;
        if (status.correctedQuery) addBubble(status.correctedQuery + '로 다시 검색하겠습니다.', 'bot');
      }
      if (status.type === 'retry_attempt' && status.correctedQuery) {
        var attempt = Number(status.attempt || 0);
        var total = Number(status.total || 0);
        if (attempt > 0 && total > 0) {
          addBubble(status.correctedQuery + ' 검색을 시도합니다. (' + attempt + '/' + total + ')', 'bot');
        } else {
          addBubble(status.correctedQuery + ' 검색을 시도합니다.', 'bot');
        }
      }
    }) : Promise.resolve({ success: false });
    return task.then(function (r) {
      if (r && r.ambiguous) {
        return { success: false, ambiguous: true, fieldId: id, label: label, candidates: r.candidates };
      }
      // 원문 검색이 0건이라 Gemini에게 물어 재검색한 경우, 그 과정을 그대로 안내해준다.
      if (r && r.triedFallback) {
        if (!shownNoResult) addBubble(originalInput + ' 검색결과가 없습니다.', 'bot');
        if (r.correctedQuery && !shownRetryStart) addBubble(r.correctedQuery + '로 다시 검색하겠습니다.', 'bot');
      }
      if (r && r.success) {
        if (r.triedFallback && r.correctedQuery) {
          addAddressChangeBubble(label, originalInput, r.resolvedText);
        } else {
          addBubble(label + '는 \'' + r.resolvedText + '\'(으)로 확인했습니다.', 'bot');
        }
        noteProgress();
        return { success: true };
      }
      var el = document.getElementById(id);
      if (el) el.value = '';
      addBubble(label + '의 주소나 상호명 검색이 되지 않았습니다. 확인 후 다시 알려주세요.', 'bot');
      noteTrouble();
      return { success: false };
    });
  }

  // 전화번호 입력을 형식 검사 + 하이픈 포맷 — 유효하면 확인 말풍선, 아니면 그 항목만 비우고 재요청 말풍선.
  function validatePhoneField(id, label) {
    var el = document.getElementById(id);
    var formatter = window.__aiIntakeFormatPhone;
    var raw = el ? el.value : '';
    var r = formatter ? formatter(raw) : { formatted: raw, valid: false };
    if (r.valid) {
      if (el) el.value = r.formatted;
      addBubble(label + '는 ' + r.formatted + '(으)로 확인했습니다.', 'bot');
      noteProgress();
      return Promise.resolve(true);
    }
    if (el) el.value = '';
    addBubble(label + ' 형식이 올바르지 않습니다. 확인 후 다시 알려주세요.', 'bot');
    noteTrouble();
    return Promise.resolve(false);
  }

  // 차량번호판 형식 검증 — 일반 승용(2~3자리+한글1자+4자리) 및 지역명/영업용 구형 번호판(지역명 2자+2~3자리+한글1자+4자리)까지 허용.
  // 차량번호는 필수 항목이 아니라서(선택), 형식이 틀려도 다음 필수 질문 진행을 막지는 않는다 — 그 항목만 비우고 안내한다.
  // 번호판 규칙 자체가 향후 바뀔 수 있으니, 한 번 거부된 값과 동일한 값이 다시 들어오면
  // (사용자가 오타가 아니라고 확인해준 것으로 보고) 이번엔 그대로 등록한다.
  var VEHICLE_NUMBER_RE = /^(?:[가-힣]{2})?(?:\d{2}|\d{3})[가-힣]\d{4}$/;
  var lastRejectedVehicleNumber = {};
  function validateVehicleNumberField(id, label) {
    var el = document.getElementById(id);
    var raw = el ? el.value : '';
    var normalized = raw.replace(/\s+/g, '');
    var vehicleType = val('vehicle_type');
    var typeSuffix = vehicleType ? (' (' + vehicleType + ')') : '';
    if (VEHICLE_NUMBER_RE.test(normalized)) {
      delete lastRejectedVehicleNumber[id];
      if (el) el.value = normalized;
      addBubble(label + '는 ' + normalized + typeSuffix + '(으)로 확인했습니다.', 'bot');
      noteProgress();
      return Promise.resolve(true);
    }
    if (normalized && lastRejectedVehicleNumber[id] === normalized) {
      delete lastRejectedVehicleNumber[id];
      if (el) el.value = normalized;
      addBubble(label + '를 입력하신 대로 \'' + normalized + '\'' + typeSuffix + '(으)로 등록합니다.', 'bot');
      noteProgress();
      return Promise.resolve(true);
    }
    lastRejectedVehicleNumber[id] = normalized;
    noteTrouble();
    if (el) el.value = '';
    addBubble('잘못된 차량번호입니다. 확인 후 다시 입력해주세요.', 'bot');
    return Promise.resolve(false);
  }

  function getNextMissingField() {
    for (var i = 0; i < REQUIRED_FIELDS.length; i++) {
      var f = REQUIRED_FIELDS[i];
      // reserved_date/time은 폼 기본값(현재 시각)이 항상 미리 채워져 있어 값의 존재만으로는
      // 판단할 수 없다 — 챗봇이 실제로 확인해준 적이 있는지(reservedDateTimeConfirmed)로 본다.
      if (f.type === 'datetime') {
        if (!reservedDateTimeConfirmed) return f;
        continue;
      }
      // 차량번호도 마찬가지 이유(스킵하면 값이 계속 비어있는 게 정상)로 별도 플래그로 판단한다.
      if (f.type === 'vehicle') {
        if (!vehicleNumberResolved) return f;
        continue;
      }
      var el = document.getElementById(f.id);
      if (!el || !el.value.trim()) return f;
    }
    return null;
  }

  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }

  function isFareInquiryIntentText(text) {
    return /(요금|비용|견적|가격|운임)/.test(String(text || ''));
  }

  function hasCallIntakeSignalText(text) {
    var t = String(text || '');
    return /(예약해|예약해줘|예약|접수|신청|회수서류|서류회수|인수증|성능점검|고객서명|우편발송|판매탁송|탁송콜|콜접수)/.test(t);
  }

  function detectFareInquiryType(text) {
    var t = String(text || '');
    if (hasCallIntakeSignalText(t)) return null;
    if (/(일일\s*대리\s*기사|일일\s*대리|하루\s*대리|데일리\s*대리)/.test(t)) return 'daily_proxy';
    if (/(대리\s*요금|대리운전|대리\s*기사)/.test(t)) return 'proxy';
    if (/(탁송\s*요금|탁송)/.test(t)) return 'dispatch';
    return isFareInquiryIntentText(t) ? 'dispatch' : null;
  }

  function normalizePlaceName(v) {
    return String(v || '')
      .replace(/[?.!,]+$/g, '')
      .replace(/\s*(탁송|요금|비용|견적|가격|운임).*/g, '')
      .trim();
  }

  function extractFareInquiryRouteInfo(text) {
    var t = String(text || '').trim();
    if (!t) return { origin: '', destination: '', vehicleType: '' };

    var origin = null;
    var destination = null;
    var routePatterns = [
      /(.+?)에서\s+(.+?)까지/,
      /(.+?)에\s+(.+?)까지/,
      /(.+?)부터\s+(.+?)까지/,
      /(.+?)에서\s+(.+?)로/,
    ];
    for (var i = 0; i < routePatterns.length; i++) {
      var m = t.match(routePatterns[i]);
      if (!m) continue;
      origin = String(m[1] || '').trim();
      destination = String(m[2] || '').trim();
      break;
    }

    if (!origin || !destination) {
      var labeled = t.match(/출\s*[:：]\s*(.+?)\s+도\s*[:：]\s*(.+?)(?:\s|$)/);
      if (labeled) {
        origin = String(labeled[1] || '').trim();
        destination = String(labeled[2] || '').trim();
      }
    }

    origin = normalizePlaceName(origin);
    destination = normalizePlaceName(destination);

    if ((!origin || !destination) && !/에서|에|부터|까지|출\s*[:：]|도\s*[:：]/.test(t)) {
      var compact = t.match(/([가-힣A-Za-z0-9\s]+?)\s*(?:→|->|~|-)\s*([가-힣A-Za-z0-9\s]+)/);
      if (compact) {
        origin = normalizePlaceName(compact[1]);
        destination = normalizePlaceName(compact[2]);
      }
    }

    var vehicleMatch = t.match(/([가-힣A-Za-z0-9\-]{2,20})\s*차량/);
    var vehicleType = vehicleMatch ? String(vehicleMatch[1] || '').trim() : '';
    return {
      origin: origin || '',
      destination: destination || '',
      vehicleType: vehicleType,
    };
  }

  function clearFareInquiryDraft() {
    fareInquiryDraft = null;
    fareInquiryPendingField = null;
  }

  function askFareInquiryMissingField() {
    if (!fareInquiryDraft) return null;
    if (!fareInquiryDraft.origin) {
      fareInquiryPendingField = 'origin';
      return '탁송 요금 문의를 위해 출발지를 알려주세요?';
    }
    if (!fareInquiryDraft.destination) {
      fareInquiryPendingField = 'destination';
      return '탁송 요금 문의를 위해 도착지를 알려주세요?';
    }
    fareInquiryPendingField = null;
    return null;
  }

  function handleFareInquiryPendingReply(text) {
    if (!fareInquiryDraft || !fareInquiryPendingField) return false;
    var parsed = extractFareInquiryRouteInfo(text);
    if (parsed.origin && !fareInquiryDraft.origin) fareInquiryDraft.origin = parsed.origin;
    if (parsed.destination && !fareInquiryDraft.destination) fareInquiryDraft.destination = parsed.destination;
    if (parsed.vehicleType && !fareInquiryDraft.vehicleType) fareInquiryDraft.vehicleType = parsed.vehicleType;

    if (fareInquiryPendingField === 'origin' && !fareInquiryDraft.origin) {
      fareInquiryDraft.origin = normalizePlaceName(text);
    } else if (fareInquiryPendingField === 'destination' && !fareInquiryDraft.destination) {
      fareInquiryDraft.destination = normalizePlaceName(text);
    }

    var nextQ = askFareInquiryMissingField();
    if (nextQ) {
      addBubble(nextQ, 'bot', null, true);
      logBotMessage({ logText: nextQ, needsAgent: false, requestedFeature: null });
      return true;
    }

    var route = {
      origin: fareInquiryDraft.origin,
      destination: fareInquiryDraft.destination,
      vehicleType: fareInquiryDraft.vehicleType || '',
    };
    clearFareInquiryDraft();
    handleFareInquiryFlowFromText(route).then(function () { return null; });
    return true;
  }

  function isAdministrativeAreaName(name) {
    var q = String(name || '').trim();
    if (!q) return false;
    if (!/(시|군|구|읍|면|동)$/.test(q)) return false;
    return !/(로|길|번지|아파트|빌딩|타워|센터|역|공항|터미널|IC|휴게소|\d)/.test(q);
  }

  function waitForDistanceKm(timeoutMs) {
    var maxMs = Number(timeoutMs || 12000);
    var startedAt = Date.now();

    return new Promise(function (resolve) {
      (function check() {
        var km = parseRouteDistanceKm();
        if (Number.isFinite(km) && km > 0) {
          resolve(km);
          return;
        }
        if (Date.now() - startedAt >= maxMs) {
          resolve(null);
          return;
        }
        setTimeout(check, 250);
      })();
    });
  }

  function stageBotMessage(text) {
    addBubble(text, 'bot');
    return logBotMessage({ logText: text, needsAgent: false, requestedFeature: null });
  }

  function createInquiryRecord(payload) {
    return fetch('/inquiries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify(payload || {}),
    })
      .then(function (res) { return res.json().catch(function () { return {}; }); })
      .then(function (data) { return data && data.id ? Number(data.id) : null; })
      .catch(function () {
        var failText = '구간요금 조회 요청이 실패했습니다. 네트워크 상태를 확인한 뒤 다시 시도해주세요.';
        addBubble(failText, 'bot');
        if (opts.returnPayload) {
          return {
            text: failText,
            distanceKm: distanceKm,
            fare: null,
            resolvedOrigin: origin,
            resolvedDestination: destination,
            fareSource: 'error',
            fallbackUsed: false,
          };
        }
        return failText;
      });
  }

  function updateInquiryEstimate(inquiryId, payload) {
    if (!inquiryId) return Promise.resolve(false);
    return fetch('/inquiries/' + inquiryId + '/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify(payload || {}),
    })
      .then(function () { return true; })
      .catch(function () { return false; });
  }

  var lastFareGuideKey = null;
  var deferredFareGuideTimer = null;
  var deferredFareGuideNoticeShown = false;

  function clearDeferredFareGuideTimer() {
    if (deferredFareGuideTimer) {
      clearInterval(deferredFareGuideTimer);
      deferredFareGuideTimer = null;
    }
  }

  function scheduleDeferredFareGuide() {
    if (!val('origin_address') || !val('destination_address')) return;
    if (!deferredFareGuideNoticeShown) {
      deferredFareGuideNoticeShown = true;
      var waitingText = '경로탐색이 완료되는 즉시 요금을 안내해드릴게요.';
      addBubble(waitingText, 'bot');
      logBotMessage({ logText: waitingText, needsAgent: false, requestedFeature: null });
    }
    if (deferredFareGuideTimer) return;
    deferredFareGuideTimer = setInterval(function () {
      if (!val('origin_address') || !val('destination_address')) {
        clearDeferredFareGuideTimer();
        deferredFareGuideNoticeShown = false;
        return;
      }
      if (!isRouteDistanceFinal()) return;

      clearDeferredFareGuideTimer();
      announceFareGuideFromDb().then(function (fareGuideText) {
        if (!fareGuideText) {
          deferredFareGuideNoticeShown = false;
          return;
        }
        deferredFareGuideNoticeShown = false;
        logBotMessage({ logText: fareGuideText, needsAgent: false, requestedFeature: null });
      });
    }, 900);
  }

  function parseRouteDistanceKm() {
    var el = document.getElementById('routeTotalDistance');
    if (!el) return null;
    var text = String(el.textContent || '').trim();
    if (!text || text === '-') return null;
    var m = text.match(/([0-9]+(?:\.[0-9]+)?)\s*km/i);
    if (!m) return null;
    var km = Number(m[1]);
    return Number.isFinite(km) ? km : null;
  }

  // 총거리와 함께 계산되는 예상소요시간(order-form.js가 "1시간 20분"/"30분" 형식으로 채워둔 값)을
  // 요금 안내 문장에 그대로 붙여쓴다.
  function parseRouteDurationText() {
    var el = document.getElementById('routeTotalDuration');
    if (!el) return null;
    var text = String(el.textContent || '').trim();
    if (!text || text === '-') return null;
    return text;
  }

  // "예상요금은 약 X원이며, (거리 Ykm, 예상소요시간 Z)" 형태의 뒷부분(거리/소요시간)을 만든다.
  function buildFareDistanceDurationSuffix(distanceKm, vehicleText) {
    var durationText = parseRouteDurationText();
    if (durationText) return ' (거리 ' + distanceKm.toFixed(1) + 'km' + vehicleText + ', 예상소요시간 ' + durationText + ')';
    return ' (거리 ' + distanceKm.toFixed(1) + 'km' + vehicleText + ')';
  }

  function normalizeFareGuideText(text) {
    return String(text || '').replace(/^\s*요금문의\s*안내\s*:\s*/i, '').trim();
  }

  // refreshMapView()(order-form.js)는 직선거리로 먼저 즉시 표시한 뒤, 카카오모빌리티 실제 도로 경로
  // 응답이 오면 그 값으로 다시 덮어쓴다 — 이 최종 반영 시점을 기다리지 않고 요금을 조회하면 우측
  // 패널(최종 도로거리 기준)과 챗봇 안내(직선거리 기준) 금액이 서로 달라질 수 있다. order-form.js가
  // renderRouteSummary()에서 함께 남겨두는 전역 플래그로 최종 확정 여부를 판단한다(ai_intake.ejs에는
  // form.ejs의 routeDurationBasis 문구 엘리먼트가 없어 DOM 텍스트로는 판단할 수 없다).
  function isRouteDistanceFinal() {
    return window.__aiIntakeRouteFinal === true;
  }

  function waitForFinalRouteDistance(timeoutMs) {
    var maxMs = Number(timeoutMs || 12000);
    var startedAt = Date.now();
    return new Promise(function (resolve) {
      (function check() {
        var km = parseRouteDistanceKm();
        if (Number.isFinite(km) && km > 0 && isRouteDistanceFinal()) {
          resolve(km);
          return;
        }
        if (Date.now() - startedAt >= maxMs) {
          resolve(null);
          return;
        }
        setTimeout(check, 250);
      })();
    });
  }

  // 챗봇 입력으로 출발/도착지가 확정되면 현재 계산된 거리값을 기준으로 요금표 DB를 조회해 안내한다.
  // 같은 경로(지사+거리)에서 같은 안내를 반복 노출하지 않도록 key를 저장해 중복을 막는다.
  function announceFareGuideFromDb(options) {
    var opts = options || {};
    var origin = val('origin_address');
    var destination = val('destination_address');
    if (!origin || !destination) return Promise.resolve(null);

    return waitForFinalRouteDistance(20000).then(function (distanceKm) {
      if (!Number.isFinite(distanceKm) || distanceKm <= 0) return null;

      var branchId = val('branch_id');
      var vehicleType = val('vehicle_type') || opts.vehicleType || '';
      // 실시간 페리/도선 정보도 실제 경로 응답이 온 뒤에야 최종 확정되므로, 호출 시점 스냅샷 대신
      // 지금 이 시점의 전역 값을 다시 읽는다.
      var routeMeta = window.__aiIntakeRouteMeta || opts.routeMeta || null;

      var key = (branchId || 'fallback') + '|' + distanceKm.toFixed(1);
      // 이미 같은 경로로 안내한 적이 있으면(중복 방지) null이 아니라 false를 돌려준다 — 호출부가
      // "거리 계산이 아직 안 끝나서 대기 중"과 "이미 안내를 마쳤음"을 구분할 수 있어야, 이미
      // 요금을 알려준 뒤에 "경로탐색이 완료되는 즉시 안내드릴게요" 같은 잘못된 대기 안내가
      // 다시 뜨는 걸 막을 수 있다.
      if (key === lastFareGuideKey) return false;

      var qs = new URLSearchParams();
      if (branchId) qs.set('branch_id', branchId);
      qs.set('distance_km', distanceKm.toFixed(2));
      if (vehicleType) qs.set('vehicle_type', vehicleType);
      if (val('reserved_date')) qs.set('reserved_date', val('reserved_date'));
      if (routeMeta) {
        qs.set('has_ferry_leg', routeMeta.hasFerryLeg ? '1' : '0');
        qs.set('route_meta_json', JSON.stringify(routeMeta));
      }

      return fetch('/orders/fare-preview?' + qs.toString())
        .then(function (res) { return res.json(); })
        .then(function (data) {
          var role = String((document.getElementById('orderForm') || {}).dataset.myRole || '');
          if (data && data.representativeConfigMissing && role === 'admin') {
            addBubble('관리자 안내: 대표요금제 컬럼이 DB에 반영되지 않아, 일반 fallback 규칙으로 계산했습니다. 마이그레이션을 적용해주세요.', 'bot');
          }

          if (!data || !data.enabled) {
            var manualMsg = '등록된 법인/지사 구간요금이 없어 요금 자동 안내가 어렵습니다. 상담원이 확인 후 안내드리겠습니다.';
            addBubble(manualMsg, 'bot');
            lastFareGuideKey = key;
            if (opts.returnPayload) {
              return {
                text: manualMsg,
                distanceKm: distanceKm,
                fare: null,
                resolvedOrigin: origin,
                resolvedDestination: destination,
                fareSource: 'none',
                fallbackUsed: false,
              };
            }
            return manualMsg;
          }

          var baseFare = Number(data.baseFare || 0);
          var ferryFare = Number(data.ferryFare || 0);
          var totalFare = Number(data.totalFare || data.fare || 0);
          var amount = totalFare.toLocaleString('ko-KR');
          var adminAreaOnly = !!opts.adminAreaOnly;
          var vehicleText = opts.vehicleType ? (' (' + opts.vehicleType + ' 기준)') : '';
          var msg;
          if (data.ferryNeedVehicleType) {
            msg = '현재 경로 기준 구간요금은 약 ' + baseFare.toLocaleString('ko-KR') + '원입니다. 도선료 계산을 위해 차종을 알려주세요.';
          } else if (data.ferryApplied && ferryFare > 0) {
            msg = adminAreaOnly
              ? ('출발지 ' + origin + '에서 도착지 ' + destination + ' 기준으로 구간요금 ' + baseFare.toLocaleString('ko-KR') + '원 + 도선료 ' + ferryFare.toLocaleString('ko-KR') + '원 = 총 ' + amount + '원입니다.')
              : ('현재 경로 기준 예상요금은 구간요금 ' + baseFare.toLocaleString('ko-KR') + '원 + 도선료 ' + ferryFare.toLocaleString('ko-KR') + '원 = 총 ' + amount + '원이며,' + buildFareDistanceDurationSuffix(distanceKm, vehicleText));
          } else {
            msg = adminAreaOnly
              ? ('출발지 ' + origin + '에서 도착지 ' + destination + ' 기준으로 요금은 ' + amount + '원입니다.')
              : ('현재 경로 기준 예상요금은 약 ' + amount + '원이며,' + buildFareDistanceDurationSuffix(distanceKm, vehicleText));
          }

          if (data.fallbackUsed) {
            msg += ' 등록된 법인/지사 요금표가 없어 기본 구간 요금제를 참고했습니다.';
          }

          msg = normalizeFareGuideText(msg);
          addBubble(msg, 'bot');
          lastFareGuideKey = key;
          deferredFareGuideNoticeShown = false;
          clearDeferredFareGuideTimer();
          if (opts.returnPayload) {
            return {
              text: msg,
              distanceKm: distanceKm,
              fare: totalFare,
              totalFare: totalFare,
              baseFare: baseFare,
              ferryFare: ferryFare,
              resolvedOrigin: origin,
              resolvedDestination: destination,
              fareSource: data.fallbackUsed ? 'fallback_default' : 'branch',
              fallbackUsed: !!data.fallbackUsed,
            };
          }
          return msg;
        })
        .catch(function () { return null; });
    });
  }

  function handleFareInquiryFlowFromText(routeInfo) {
    var origin = routeInfo.origin;
    var destination = routeInfo.destination;
    var vehicleType = routeInfo.vehicleType || '';
    var adminAreaOnly = isAdministrativeAreaName(origin) && isAdministrativeAreaName(destination);
    var inquiryId = null;

    return createInquiryRecord({
      category: 'fare',
      inquiry_text: '탁송요금문의: ' + origin + ' -> ' + destination + (vehicleType ? (' / 차종: ' + vehicleType) : ''),
      origin_text: origin,
      destination_text: destination,
      vehicle_type: vehicleType || null,
      has_ferry_leg: false,
      ferry_legs_json: null,
      chat_session_id: sessionId || null,
      branch_id: val('branch_id') || null,
      requester_group_id: (document.querySelector('select[name="requester_group_id"]') || {}).value || null,
    })
      .then(function (id) { inquiryId = id; return true; })
      .then(function () { return stageBotMessage('탁송 요금 문의로 접수했습니다. 거리 계산 후 요금을 안내해드리겠습니다.'); })
      .then(function () {
        document.getElementById('origin_address').value = origin;
        updateFareProgressLine(1, '출발지 지명 검색 중입니다.');
        return true;
      })
      .then(function () { return validateAddressField('origin_address', '출발지 주소'); })
      .then(function (originResult) {
        if (originResult && originResult.ambiguous) {
          clearFareProgressLine();
          logBotMessage(startDisambiguation([originResult]));
          return { halted: true };
        }
        if (!originResult || !originResult.success) {
          clearFareProgressLine();
          return { halted: true };
        }

        document.getElementById('destination_address').value = destination;
        updateFareProgressLine(2, '도착지 지명 검색 중입니다.');
        return Promise.resolve()
          .then(function () { return validateAddressField('destination_address', '도착지 주소'); });
      })
      .then(function (destinationResult) {
        if (destinationResult && destinationResult.halted) return destinationResult;
        if (destinationResult && destinationResult.ambiguous) {
          clearFareProgressLine();
          logBotMessage(startDisambiguation([destinationResult]));
          return { halted: true };
        }
        if (!destinationResult || !destinationResult.success) {
          clearFareProgressLine();
          return { halted: true };
        }

        updateFareProgressLine(3, '경로 거리 계산 중입니다...');
        return Promise.resolve()
          .then(function () { return waitForFinalRouteDistance(20000); })
          .then(function (km) {
            if (!Number.isFinite(km) || km <= 0) {
              clearFareProgressLine();
              addBubble('거리 계산을 완료하지 못했습니다. 주소를 조금 더 상세히 입력해주시면 다시 계산해드리겠습니다.', 'bot');
              logBotMessage({
                logText: '거리 계산을 완료하지 못했습니다. 주소를 조금 더 상세히 입력해주시면 다시 계산해드리겠습니다.',
                needsAgent: false,
                requestedFeature: null,
              });
              return { halted: true };
            }

            var distanceDoneText = '거리 계산이 완료되었습니다. 예상 거리 ' + km.toFixed(1) + 'km 입니다.';
            addBubble(distanceDoneText, 'bot');
            logBotMessage({ logText: distanceDoneText, needsAgent: false, requestedFeature: null });

            updateFareProgressLine(4, '구간요금 조회 중입니다...');
            return Promise.resolve()
              .then(function () {
                return announceFareGuideFromDb({
                  adminAreaOnly: adminAreaOnly,
                  vehicleType: vehicleType,
                  routeMeta: window.__aiIntakeRouteMeta || null,
                  returnPayload: true,
                });
              })
              .then(function (fareResult) {
                if (!fareResult || !fareResult.text) {
                  clearFareProgressLine();
                  var failText = '구간요금 조회 중 오류가 발생했습니다. 잠시 후 다시 시도하거나 상담원에게 문의해주세요.';
                  addBubble(failText, 'bot');
                  logBotMessage({ logText: failText, needsAgent: false, requestedFeature: null });
                  return { halted: true, fareText: failText };
                }
                finishFareProgressLine('4/4 구간요금 조회 완료');
                if (fareResult && inquiryId) {
                  var routeMeta = window.__aiIntakeRouteMeta || null;
                  var ferryLegs = (routeMeta && Array.isArray(routeMeta.ferryLegs)) ? routeMeta.ferryLegs : [];
                  updateInquiryEstimate(inquiryId, {
                    resolved_origin: fareResult.resolvedOrigin || val('origin_address'),
                    resolved_destination: fareResult.resolvedDestination || val('destination_address'),
                    estimated_distance_km: fareResult.distanceKm,
                    estimated_fare: fareResult.totalFare || fareResult.fare,
                    estimated_ferry_fare: fareResult.ferryFare,
                    fare_source: fareResult.fareSource,
                    has_ferry_leg: !!(routeMeta && routeMeta.hasFerryLeg),
                    ferry_legs_json: ferryLegs.length ? JSON.stringify(ferryLegs) : null,
                  });
                }
                if (fareResult && fareResult.ferryNeedVehicleType) {
                  var askVehicleTypeText = '도선료 계산을 위해 차종을 알려주세요. 예: 카니발, 그랜저, 1톤';
                  addBubble(askVehicleTypeText, 'bot');
                  logBotMessage({ logText: askVehicleTypeText, needsAgent: false, requestedFeature: null });
                  return { halted: true, fareText: fareResult ? fareResult.text : null, needsVehicleType: true };
                }
                var routeMeta = window.__aiIntakeRouteMeta || null;
                if (routeMeta && routeMeta.hasFerryLeg) {
                  var ferryBadgeText = '배편 이용 가능성이 높습니다.';
                  addBubble(ferryBadgeText, 'bot');
                  logBotMessage({ logText: ferryBadgeText, needsAgent: false, requestedFeature: null });
                }
                if (routeMeta && Array.isArray(routeMeta.ferryLegs) && routeMeta.ferryLegs.length) {
                  var lines = ['선박 구간 정보가 확인되었습니다.'];
                  routeMeta.ferryLegs.forEach(function (leg, idx) {
                    var fromPort = (leg && leg.fromPort) ? String(leg.fromPort).trim() : '';
                    var toPort = (leg && leg.toPort) ? String(leg.toPort).trim() : '';
                    if (fromPort || toPort) {
                      lines.push((idx + 1) + ') 출발항: ' + (fromPort || '확인중') + ' / 도착항: ' + (toPort || '확인중'));
                    } else if (leg && leg.summary) {
                      lines.push((idx + 1) + ') ' + String(leg.summary));
                    }
                  });
                  var ferryText = lines.join('\n');
                  addBubble(ferryText, 'bot');
                  logBotMessage({ logText: ferryText, needsAgent: false, requestedFeature: null });
                }
                stageBotMessage('경유지가 있으신가요? 있으면 경유지 주소를 알려주시면 다시 경유지 포함 요금을 안내해 드릴께요');
                return { halted: false, fareText: fareResult ? fareResult.text : null };
              });
          });
      })
      .then(function () {
        return true;
      });
  }

  // 다른 메뉴로 이동했다 돌아왔을 때 대화 내용만이 아니라 "어디까지 입력했는지"도 이어가기 위한
  // 진행 상태 스냅샷 — 매 턴 끝에 logBotMessage를 통해 서버(chat_sessions.draft_json)에 저장하고,
  // 재방문 시 restoreDraftState()로 되살린다. 경유지(동적으로 추가되는 행)는 범위에서 제외했다 —
  // 흔치 않은 경우라 이번엔 필수 필드 + 차량번호 + 메모만 다룬다.
  var DRAFT_FIELD_IDS = [
    'reserved_date', 'reserved_time',
    'origin_address', 'origin_detail_address', 'origin_contact', 'vehicle_number', 'vehicle_type',
    'destination_address', 'destination_detail_address', 'destination_contact',
    'memo_customer',
  ];
  function buildDraftState() {
    var fields = {};
    DRAFT_FIELD_IDS.forEach(function (id) { fields[id] = val(id); });
    var confirmedSlots = ['origin', 'destination'].filter(function (slot) {
      var badge = document.getElementById(slot + 'ConfirmBadge');
      return badge && badge.classList.contains('visible');
    });
    return {
      phase: phase,
      pendingField: pendingField,
      modifyFieldMode: modifyFieldMode,
      lastModifiedFieldId: lastModifiedFieldId,
      fields: fields,
      confirmedSlots: confirmedSlots,
      reservedDateTimeConfirmed: reservedDateTimeConfirmed,
      vehicleNumberResolved: vehicleNumberResolved,
      additionalRequestResolved: additionalRequestResolved,
      confirmedOrderType: confirmedOrderType,
    };
  }
  function restoreDraftState(draft) {
    if (!draft) return;
    var fields = draft.fields || {};
    DRAFT_FIELD_IDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el && fields[id]) { el.value = fields[id]; el.disabled = false; }
    });
    syncReservedTimeSelectsFromHidden();
    (draft.confirmedSlots || []).forEach(function (slot) {
      var badge = document.getElementById(slot + 'ConfirmBadge');
      if (badge) badge.classList.add('visible');
    });
    reservedDateTimeConfirmed = !!draft.reservedDateTimeConfirmed;
    vehicleNumberResolved = !!draft.vehicleNumberResolved;
    additionalRequestResolved = !!draft.additionalRequestResolved;
    confirmedOrderType = draft.confirmedOrderType || null;
    updateOrderTypeBadge(confirmedOrderType);
    // choose_address_candidate(후보 목록을 저장하지 않음)와 offer_agent(제안 직전 상태를 저장하지
    // 않음)는 복원할 수 없다 — 어중간하게 그 단계로 복원하면 다음 답변을 처리하다 오류가 나므로
    // 안전하게 되돌린다. pendingField는 그대로 살아있어서(offer_agent 진입 시 지우지 않음) 대부분
    // 원래 묻던 질문으로 자연스럽게 이어진다.
    if (draft.phase && draft.phase !== 'choose_address_candidate' && draft.phase !== 'offer_agent') phase = draft.phase;
    pendingField = draft.pendingField || null;
    modifyFieldMode = !!draft.modifyFieldMode;
    lastModifiedFieldId = draft.lastModifiedFieldId || null;
    updateQuickReplies();
  }

  // 차량번호는 그 번호가 매겨진 지점(출발지 또는 해당 경유지) 바로 아래에 붙여서 보여준다 —
  // 목록 맨 끝에 몰아서 보여주면 어느 지점의 차량인지 헷갈리기 때문.
  function buildSummaryText() {
    var lines = [];
    lines.push('▪ 예약: ' + val('reserved_date') + ' ' + val('reserved_time'));
    lines.push('▪ 출발지: ' + val('origin_address') + (val('origin_detail_address') ? ' ' + val('origin_detail_address') : '') + ' (' + val('origin_contact') + ')');
    if (val('vehicle_number')) lines.push('▪ 차량번호: ' + val('vehicle_number'));
    if (val('vehicle_type')) lines.push('▪ 차종: ' + val('vehicle_type'));
    document.querySelectorAll('#waypointsWrap .waypoint-row').forEach(function (row) {
      var id = row.dataset.slot;
      var addr = val(id + '_address');
      if (!addr) return;
      var contact = val(id + '_contact');
      lines.push('▪ 경유지: ' + addr + (contact ? ' (' + contact + ')' : ''));
      var wpVehicle = val(id + '_vehicle_number');
      if (wpVehicle) lines.push('▪ 차량번호: ' + wpVehicle);
    });
    lines.push('▪ 도착지: ' + val('destination_address') + (val('destination_detail_address') ? ' ' + val('destination_detail_address') : '') + ' (' + val('destination_contact') + ')');
    if (val('memo_customer')) lines.push('▪ 메모: ' + val('memo_customer'));
    return lines.join('\n');
  }

  // 이번 턴에 새로 채워진 필드들의 검증이 모두 끝난 뒤 호출된다.
  // 아직 빈 필수 항목이 있으면 다음 질문으로, 전부 채워졌으면 요약 + 등록 확인 질문으로 넘어간다.
  function proceedAfterCollecting() {
    // 방금 검증 실패가 누적되어 상담원 연결을 이미 제안했다면(noteTrouble), 다음 질문을 또
    // 보여주지 않고 그 제안에 대한 답을 기다린다.
    if (phase === 'offer_agent') return null;
    // 이번 메시지에서 화남/답답함이 감지됐으면, 다음 필수 질문 대신 상담원 연결을 먼저 제안한다.
    if (maybeOfferForFrustration()) return null;
    var missing = getNextMissingField();
    if (missing) {
      setPendingField(missing.id);
      addBubble(missing.question, 'bot', null, true);
      return missing.question;
    }

    if (!additionalRequestResolved) {
      setPendingField('memo_customer');
      var extraQ = '추가 요청사항이 있으시면 알려주세요? 없으시면 \'없음\'이라고 답해주세요.';
      addBubble(extraQ, 'bot', null, true);
      return extraQ;
    }

    var prefix = '';
    if (modifyFieldMode) {
      var meta = fieldMetaFor(lastModifiedFieldId);
      // 예약일시는 날짜 입력칸 하나의 원시값("2026-07-28")만 그대로 보여주면 시간이 빠진 채
      // 어색하게 보이므로, 다른 필드처럼 저장된 값을 그대로 쓰지 않고 사람이 읽기 좋은 형식으로 합쳐 보여준다.
      var newVal = (meta && meta.type === 'datetime')
        ? (formatReservedDateTime(val('reserved_date'), val('reserved_time')) || val(lastModifiedFieldId))
        : val(lastModifiedFieldId);
      // meta.label(주소/연락처)은 항상 받침 없는 글자로 끝나 "를", 예외 상황의 '항목'만 받침이 있어 "을".
      var itemLabel = meta ? meta.label : '항목';
      var particle = meta ? '를' : '을';
      prefix = '요청하신 ' + itemLabel + particle + ' \'' + newVal + '\'(으)로 수정했습니다.';
      modifyFieldMode = false;
    }

    setPendingField(null);
    phase = 'confirming';
    var summary = buildSummaryText();
    var confirmQ = prefix ? '다시 접수내용을 등록해 드릴까요?' : '위 내용으로 등록해 드릴까요?';
    if (prefix) addBubble(prefix, 'bot');
    addBubble(summary, 'bot');
    addBubble(confirmQ, 'bot', null, true);
    return (prefix ? prefix + '\n' : '') + summary + '\n' + confirmQ;
  }

  // 오더접수 필드를 순서대로(동시가 아니라) 검증한다 — 주소 검색은 비동기라 순서를 지키지 않으면
  // 확인 말풍선이 뒤죽박죽 뜰 수 있어서, 하나씩 끝내고 다음으로 넘어가는 체인으로 만든다.
  // 각 태스크의 결과를 모아서 반환한다(모호한 주소가 있었는지 나중에 한 번에 확인하기 위함).
  function runValidationChain(tasks) {
    var results = [];
    return tasks.reduce(function (chain, task) {
      return chain.then(function () { return task(); }).then(function (r) { results.push(r); });
    }, Promise.resolve()).then(function () { return results; });
  }

  function candidateListText(d) {
    var lines = [d.label + ' 검색 결과가 여러 개라 확인이 필요합니다. 어느 곳이 맞을까요?'];
    d.candidates.forEach(function (c, i) { lines.push((i + 1) + ') ' + c.label); });
    return lines.join('\n');
  }

  // 이번 턴에 모호했던 주소들(검색 결과가 갈린 것들)을 하나씩 확인받는 단계로 넘어간다.
  function startDisambiguation(ambiguousList) {
    disambiguationQueue = ambiguousList.slice(1);
    pendingDisambiguation = ambiguousList[0];
    phase = 'choose_address_candidate';
    var q = candidateListText(pendingDisambiguation);
    addBubble(q, 'bot', null, true);
    return { logText: q, needsAgent: false, requestedFeature: null };
  }

  function handleOrderIntent(data, sourceText) {
    var dateTimeChanged = !!(data.reserved_date || data.reserved_time);
    // 오더유형(탁송/대리/일일기사)은 대화당 한 번만 판별해 알려준다 — 이미 확정된 뒤에는
    // 후속 메시지에서 intent가 다시 와도(예: 필드 하나씩 추가 입력) 재안내하지 않는다.
    var newOrderType = (isOrderIntent(data.intent) && !confirmedOrderType) ? data.intent : null;
    if (newOrderType) {
      confirmedOrderType = newOrderType;
      updateOrderTypeBadge(newOrderType);
    }

    setField('reserved_date', data.reserved_date);
    setField('reserved_time', data.reserved_time ? roundToTenMinutes(data.reserved_time) : data.reserved_time);
    syncReservedTimeSelectsFromHidden();
    if (dateTimeChanged) applyReservationBasisByText(sourceText);
    setField('memo_customer', data.memo_customer);
    setField('vehicle_type', data.vehicle_type || data.vehicleType || null);
    if (data.origin_detail_address) setField('origin_detail_address', data.origin_detail_address);
    if (data.destination_detail_address) setField('destination_detail_address', data.destination_detail_address);

    // 오더유형 안내(및 그와 함께 온 예약일시)와 요청사항 확인은 다른 필드들과 마찬가지로
    // runValidationChain에 태워서, 분석되는 순서대로 하나씩 말풍선이 나타나게 한다(한꺼번에 표시 X).
    var tasks = [];

    if (dateTimeChanged) {
      reservedDateTimeConfirmed = true;
      tasks.push(function () {
        var formattedDateTime = formatReservedDateTime(val('reserved_date'), val('reserved_time'));
        if (formattedDateTime) {
          // "도착" 문구는 예약 기준이 실제로 도착지 인도시간 기준(delivery)일 때만 쓴다 —
          // 메시지에 "출발/도착" 같은 기준 표현이 없어 detectReservationBasisFromText가 아무것도
          // 못 정했을 때(기본값 pickup 유지)까지 항상 "도착"으로 안내하면 잘못된 정보가 된다.
          var dtMsg;
          if (isDeliveryReservationBasis()) {
            var pickupExpected = formatPickupExpectedTimeText();
            dtMsg = pickupExpected
              ? ('예약일시는 **' + formattedDateTime + '** 도착이며\n출발지 픽업예상시간은 ' + pickupExpected + '입니다.')
              : ('예약일시는 **' + formattedDateTime + '** 도착이며\n출발지 픽업예상시간은 경로 확정 후 계산됩니다.');
          } else {
            dtMsg = '예약일시는 **' + formattedDateTime + '**(으)로 확인했습니다.';
          }
          if (newOrderType) dtMsg += '\n"' + ORDER_INTENT_LABELS[newOrderType] + '"로 확인되었습니다.';
          addBubble(dtMsg, 'bot');
        }
        return null;
      });
    } else if (newOrderType) {
      tasks.push(function () {
        addBubble('오더유형은 "' + ORDER_INTENT_LABELS[newOrderType] + '"로 확인되었습니다.', 'bot');
        return null;
      });
    }

    var resolvedMemo = val('memo_customer');
    if (resolvedMemo && resolvedMemo !== lastAnnouncedMemoText) {
      tasks.push(function () {
        additionalRequestResolved = true;
        lastAnnouncedMemoText = resolvedMemo;
        addBubble('요청사항은 \'' + resolvedMemo + '\'입니다.', 'bot');
        return null;
      });
    }

    if (data.origin_contact) {
      document.getElementById('origin_contact').value = data.origin_contact;
      tasks.push(function () { return validatePhoneField('origin_contact', '출발지 연락처'); });
    }
    if (data.origin_vehicle_number) {
      document.getElementById('vehicle_number').value = data.origin_vehicle_number;
      tasks.push(function () {
        return validateVehicleNumberField('vehicle_number', '차량번호').then(function (ok) {
          if (ok) vehicleNumberResolved = true;
          return ok;
        });
      });
    }
    if (data.destination_contact) {
      document.getElementById('destination_contact').value = data.destination_contact;
      tasks.push(function () { return validatePhoneField('destination_contact', '도착지 연락처'); });
    }

    if (data.origin_address) {
      document.getElementById('origin_address').value = data.origin_address;
      tasks.push(function () { return validateAddressField('origin_address', '출발지 주소'); });
    }

    (data.waypoints || []).forEach(function (wp) {
      if (addWaypointBtn) addWaypointBtn.click();
      var rows = document.querySelectorAll('#waypointsWrap .waypoint-row');
      var row = rows[rows.length - 1];
      if (!row) return;
      var id = row.dataset.slot;
      if (wp.address) {
        document.getElementById(id + '_address').value = wp.address;
        tasks.push(function () { return validateAddressField(id + '_address', '경유지 주소'); });
      }
      if (wp.contact) {
        document.getElementById(id + '_contact').value = wp.contact;
        tasks.push(function () { return validatePhoneField(id + '_contact', '경유지 연락처'); });
      }
      if (wp.vehicle_number) {
        document.getElementById(id + '_vehicle_number').value = wp.vehicle_number;
        tasks.push(function () { return validateVehicleNumberField(id + '_vehicle_number', '경유지 차량번호'); });
      }
    });

    if (data.destination_address) {
      document.getElementById('destination_address').value = data.destination_address;
      tasks.push(function () { return validateAddressField('destination_address', '도착지 주소'); });
    }

    // 질문에 답을 기다리고 있었는데 이 메시지에서 채울 수 있는 필드를 하나도 못 찾은 경우(예: 전혀
    // 관계없는 말, 알아볼 수 없는 텍스트) — 형식 오류처럼 명시적인 실패 말풍선이 뜨지 않아 다른
    // 검증 함수들의 noteTrouble()로는 잡히지 않으므로 여기서 직접 집계한다.
    if (!tasks.length && pendingField) noteTrouble();

    return runValidationChain(tasks).then(function (results) {
      var ambiguousList = results.filter(function (r) { return r && r.ambiguous; });
      if (ambiguousList.length) return startDisambiguation(ambiguousList);

      // 요금 안내(있으면)를 먼저 보여주고, 다음 질문은 그 뒤 마지막에 물어본다 — 질문이 다른
      // 응답 내용 사이에 끼어들어 순서가 뒤섞이지 않도록 한다.
      var farePromise = (val('origin_address') && val('destination_address'))
        ? announceFareGuideFromDb().then(function (fareGuideText) {
            if (fareGuideText === false) return; // 이미 같은 경로로 안내를 마쳤음 — 대기 안내 불필요
            if (fareGuideText) {
              logBotMessage({ logText: fareGuideText, needsAgent: false, requestedFeature: null });
              return;
            }
            scheduleDeferredFareGuide();
          })
        : Promise.resolve();

      return farePromise.then(function () {
        var doneText = proceedAfterCollecting();
        return { logText: doneText || null, needsAgent: false, requestedFeature: null };
      });
    });
  }

  // ---------------- 즐겨찾기(등록주소) 버튼으로 고른 주소 처리 ----------------
  // 직접 타이핑해서 답한 것과 똑같이(사용자 말풍선 + 확인 말풍선 + 다음 질문 진행) 처리한다.
  function applyFavoriteAddress(fieldId, label, f) {
    addBubble(f.label + ' (' + f.address + ')', 'user');
    document.getElementById(fieldId).value = f.address;
    validateAddressField(fieldId, label).then(function (r) {
      if (r && r.ambiguous) {
        logBotMessage(startDisambiguation([r]));
        return;
      }
      var doneText = proceedAfterCollecting();
      logBotMessage({ logText: doneText, needsAgent: false, requestedFeature: null });
    });
  }

  // 챗봇에는 경유지를 물어보는 전용 질문이 없다 — 출발지/도착지를 이미 다 물어본 뒤(또는 그 사이)
  // 즐겨찾기 버튼을 누르면, Gemini가 문장에서 경유지를 추출했을 때와 같은 방식으로 새 경유지 행을
  // 만들어 채운다(오더 등록 화면의 "+ 경유지 추가" 버튼을 그대로 클릭하는 것과 동일).
  function addFavoriteAsWaypoint(f) {
    if (!addWaypointBtn) return;
    addWaypointBtn.click();
    var rows = document.querySelectorAll('#waypointsWrap .waypoint-row');
    var row = rows[rows.length - 1];
    if (!row) return;
    applyFavoriteAddress(row.dataset.slot + '_address', '경유지 주소', f);
  }

  // 지금 챗봇이 기다리는 항목이 출발지/도착지 주소면 그 항목의 답으로 쓰고, 아니라면(예: 두 주소가
  // 이미 다 채워진 뒤) 경유지로 추가한다.
  function handleFavoriteSelected(f) {
    ensureSession().then(function () {
      // 대화 시작 직후처럼 pendingField가 아직 없으면(어떤 질문에도 아직 답한 적이 없으면) 지금
      // 실제로 비어있는 다음 필수 항목을 기준으로 판단한다 — 텍스트로 답할 때의 기본 힌트 처리와 동일한 이유.
      var effectiveField = pendingField || (getNextMissingField() || {}).id || null;
      var meta = fieldMetaFor(effectiveField);
      if (phase === 'collecting' && meta && meta.type === 'address') {
        applyFavoriteAddress(effectiveField, meta.label, f);
        return;
      }
      addFavoriteAsWaypoint(f);
    });
  }

  function handleFaqIntent(data) {
    if (!data.matches || data.matches.length === 0) {
      var noneText = '죄송합니다, 관련된 답변을 찾지 못했습니다. 다른 표현으로 다시 질문해주시거나 상담원에게 문의해주세요.';
      addBubble(noneText, 'bot');
      return { logText: noneText, needsAgent: false, requestedFeature: null };
    }
    var texts = data.matches.map(function (m) {
      var t = '[' + m.category + '] ' + m.answer;
      addBubble(t, 'bot');
      return t;
    });
    return { logText: texts.join('\n'), needsAgent: false, requestedFeature: null };
  }

  // 상담원 접속 여부에 따라 문구가 달라지므로(온라인/오프라인), 서버가 최종 문구를 정해서
  // /bot-message 응답으로 돌려주면 그때 말풍선을 붙인다 — 여기서는 미리 addBubble하지 않는다.
  function handleUnsupportedIntent(data) {
    return { logText: null, needsAgent: true, requestedFeature: data.requestedFeature || null };
  }

  // ---------------- 최종 확인("등록해 드릴까요?") 응답 처리 ----------------
  // "어"/"네" 같은 한 글자짜리 긍정어는 단독 답변일 때만(예: "됐어요"의 일부처럼 오탐하지 않도록) 인정한다.
  function isAffirmative(t) {
    var s = t.trim();
    if (/^(네|넵|예|응|어|그래|맞아요?|맞습니다|좋아요?|괜찮아요?|확인했어요?|오케이|ok|yes)[.!~\s]*$/i.test(s)) return true;
    return /(등록\s*(해|할|하)|그대로\s*(등록|진행)|맞습니다|맞아요)/i.test(s)
      && !/(아니|아뇨|안\s?돼|수정|틀려|잘못)/i.test(s);
  }
  function isNegative(t) {
    return /(아니|아뇨|안\s?돼|수정|바꿔|틀려|잘못|다시\s?(할|알려|확인))/i.test(t);
  }

  // 확인/수정 단계에서도 "상담원 연결해줘" 같은 요청은 예/아니오나 필드 수정으로 잘못 해석하지 않고
  // 그대로 상담원 호출로 넘긴다 — 이 단계들은 로컬 키워드 판단만 하고 Gemini 분류를 거치지 않아서
  // 별도로 감지해줘야 한다.
  function isAgentRequest(t) {
    return /상담원|상담사/.test(t);
  }

  // 차량번호/추가요청사항/확인/수정선택/후보선택 응답은 속도를 위해 로컬 키워드만으로 처리하고
  // Gemini를 거치지 않는다 — 그래서 서버가 판단하는 seemsFrustrated가 이 경로들에는 적용되지
  // 않는다. 서버 프롬프트의 판단 기준과 같은 취지로 여기서도 가볍게 화남/답답함을 감지한다.
  var FRUSTRATION_RE = /(짜증|답답|화나요?|화났|열받|빡치|미치겠|몇\s*번을?\s*(말|알려)|몇\s*번째\s*(말|알려)|왜\s*이렇게\s*오래|너무\s*오래\s*걸|말이\s*안\s*통해|씨[발팔]|시[발팔]|당장\s*(해|처리)|빨리\s*좀|[!?]{3,})/i;
  function looksFrustrated(t) {
    return FRUSTRATION_RE.test(t);
  }

  // "collecting" 단계(첫 메시지/오더접수 진행 중)에서만 쓰는 추가 가드 — 이 단계의 메시지는
  // 오더접수 본문일 수도 있어서, 전화번호나 출/도/경 라벨처럼 오더접수 신호가 함께 있으면
  // 메모 등에 "상담원"이라는 말이 우연히 섞였을 가능성이 높다고 보고 빠른 경로를 타지 않는다
  // (예: "상담원 통해 예약했어요, 출: ..." 같은 메모가 포함된 진짜 오더접수 메시지가 그냥
  // 상담원 호출로 잘못 처리되는 걸 막기 위함). confirm/수정/후보선택 단계는 답변이 짧고
  // 구조화돼 있어 이 위험이 훨씬 낮으므로 그쪽은 그대로 isAgentRequest만 사용한다.
  function looksLikeOrderIntake(t) {
    return /\d{2,3}[-\s]?\d{3,4}[-\s]?\d{4}/.test(t) || /(^|[\n\s])(출발|출:|출\s|도착|도:|도\s|경유|경:|경\d)/.test(t);
  }

  function escalateToAgent(requestedFeature) {
    // 상담원에게 넘어가면 그 이전에 뭘 묻고 있었는지(수정 대상 필드, 주소 후보 선택 등)는 전부
    // 무효가 된다 — 안 지우면 나중에 봇으로 되돌아왔을 때 그 낡은 상태를 기준으로 다음 메시지를
    // 잘못 해석할 수 있다(예: 이미 끝난 필드 수정 질문에 대한 답으로 오인).
    phase = 'collecting';
    setPendingField(null);
    modifyFieldMode = false;
    lastModifiedFieldId = null;
    pendingDisambiguation = null;
    disambiguationQueue = [];
    troubleStreak = 0;
    preOfferState = null;
    // 봇으로 되돌아왔다가 다시 상담원을 요청하는 경우, 이전 대기 안내를 "이미 봤다"고 착각해
    // 이번 새 요청에 대한 안내를 건너뛰지 않도록 초기화한다.
    lastWaitingStatusShown = null;
    logBotMessage({ logText: null, needsAgent: true, requestedFeature: requestedFeature }).then(function (finalText) {
      if (finalText) addBubble(finalText, 'bot');
    });
  }

  // ---------------- 상담원 연결 먼저 제안하기 ----------------
  // 검증 실패/못 알아들음이 TROUBLE_STREAK_LIMIT회 연속되면(noteTrouble) 또는 사용자 메시지에서
  // 화남/답답함이 감지되면(seemsFrustrated) 즉시 연결하는 대신 먼저 "상담원 연결을 해드릴까요?"라고
  // 물어보고, 답변에 따라 연결하거나 원래 하던 질문으로 돌아간다.
  function noteTrouble() {
    troubleStreak += 1;
    if (troubleStreak >= TROUBLE_STREAK_LIMIT) {
      troubleStreak = 0;
      offerAgentConnection();
      return true;
    }
    return false;
  }
  function noteProgress() { troubleStreak = 0; }

  function offerAgentConnection() {
    if (phase === 'offer_agent') return; // 이미 물어본 상태면 중복으로 다시 묻지 않는다
    preOfferState = {
      phase: phase,
      pendingField: pendingField,
      pendingDisambiguation: pendingDisambiguation,
      disambiguationQueue: disambiguationQueue.slice(),
    };
    phase = 'offer_agent';
    var q = '더 빠른 처리를 위해 상담원 연결을 해드릴까요?';
    addBubble(q, 'bot', null, true);
    logBotMessage({ logText: q, needsAgent: false, requestedFeature: null });
  }

  // pendingFrustrationOffer가 서 있으면(이번 메시지에서 화남/답답함 감지) 소비하고 제안을 띄운다.
  // 각 intent 처리(필드 확인, FAQ 답변 등)가 끝난 뒤에 호출해야 그 응답 다음에 자연스럽게 이어진다.
  function maybeOfferForFrustration() {
    if (!pendingFrustrationOffer) return false;
    pendingFrustrationOffer = false;
    offerAgentConnection();
    return true;
  }

  function handleOfferAgentPhase(text) {
    if (isAffirmative(text) || isAgentRequest(text)) {
      preOfferState = null;
      escalateToAgent('상담원 연결');
      return;
    }
    if (isNegative(text) || /^(괜찮|계속|아니)/i.test(text.trim())) {
      var resumed = preOfferState || { phase: 'collecting', pendingField: null, pendingDisambiguation: null, disambiguationQueue: [] };
      preOfferState = null;
      phase = resumed.phase;
      pendingField = resumed.pendingField;
      updateQuickReplies();
      pendingDisambiguation = resumed.pendingDisambiguation;
      disambiguationQueue = resumed.disambiguationQueue || [];

      var backText = '네, 계속 진행하겠습니다.';
      addBubble(backText, 'bot');
      var followUp = null;
      if (phase === 'collecting') {
        var meta = fieldMetaFor(pendingField);
        followUp = meta ? meta.question
          : pendingField === 'memo_customer' ? '추가 요청사항이 있으시면 알려주세요? 없으시면 \'없음\'이라고 답해주세요.'
          : null;
      } else if (phase === 'confirming') {
        followUp = '위 내용으로 등록해 드릴까요?';
      } else if (phase === 'choose_field') {
        followUp = CHOOSE_FIELD_CLARIFY;
      } else if (phase === 'choose_address_candidate' && pendingDisambiguation) {
        followUp = candidateListText(pendingDisambiguation);
      }
      if (followUp) addBubble(followUp, 'bot', null, true);
      logBotMessage({ logText: backText + (followUp ? '\n' + followUp : ''), needsAgent: false, requestedFeature: null });
      return;
    }
    var clarify = '상담원 연결이 필요하시면 "네", 계속 진행하시려면 "아니요"라고 답해주세요.';
    addBubble(clarify, 'bot');
    logBotMessage({ logText: clarify, needsAgent: false, requestedFeature: null });
  }

  // ---------------- "차량번호를 알려주세요" 응답 처리 ----------------
  // 다른 필드 정보(전화번호, 출/도/경 라벨)가 섞여 있으면 사용자가 다음 항목까지 한 번에 알려준
  // 것일 수 있으므로 여기서 처리하지 않고 기존 Gemini 분류 경로로 넘긴다(false 반환).
  // 그 외의 경우는 전부 여기서 끝내고 다음 질문으로 진행한다(true 반환).
  function handleVehicleNumberPendingReply(text) {
    if (isAgentRequest(text)) { escalateToAgent('상담원 연결'); return true; }
    if (looksFrustrated(text)) { offerAgentConnection(); return true; }
    if (looksLikeOrderIntake(text)) return false;

    var trimmed = text.trim();
    if (VEHICLE_NUMBER_SKIP_RE.test(trimmed)) {
      vehicleNumberFailCount = 0;
      vehicleNumberResolved = true;
      document.getElementById('vehicle_number').value = '';
      addBubble('차량번호는 출발지에서 다시 확인하겠습니다.', 'bot');
      noteProgress();
      var skipDoneText = proceedAfterCollecting();
      logBotMessage({ logText: skipDoneText, needsAgent: false, requestedFeature: null });
      return true;
    }

    var normalized = trimmed.replace(/\s+/g, '');
    if (VEHICLE_NUMBER_RE.test(normalized)) {
      vehicleNumberFailCount = 0;
      vehicleNumberResolved = true;
      document.getElementById('vehicle_number').value = normalized;
      addBubble('차량번호는 ' + normalized + '(으)로 확인했습니다.', 'bot');
      noteProgress();
      var okDoneText = proceedAfterCollecting();
      logBotMessage({ logText: okDoneText, needsAgent: false, requestedFeature: null });
      return true;
    }

    vehicleNumberFailCount += 1;
    if (vehicleNumberFailCount >= VEHICLE_NUMBER_MAX_ATTEMPTS) {
      vehicleNumberFailCount = 0;
      vehicleNumberResolved = true;
      document.getElementById('vehicle_number').value = '';
      var failText = '차량번호 형식이 잘못되어 등록이 되지 않았습니다.\n주문서 작성 후 요청사항에 차량 관련 내용을 작성해주세요.';
      addBubble(failText, 'bot');
      noteTrouble();
      var giveUpDoneText = proceedAfterCollecting();
      logBotMessage({ logText: giveUpDoneText ? (failText + '\n' + giveUpDoneText) : failText, needsAgent: false, requestedFeature: null });
      return true;
    }

    var retryText = '잘못된 차량번호입니다. 확인 후 다시 입력해주세요.';
    addBubble(retryText, 'bot');
    noteTrouble();
    logBotMessage({ logText: retryText, needsAgent: false, requestedFeature: null });
    return true;
  }

  // ---------------- "추가 요청사항이 있으시면 알려주세요" 응답 처리 ----------------
  function handleAdditionalRequestPendingReply(text) {
    if (isAgentRequest(text)) { escalateToAgent('상담원 연결'); return; }
    if (looksFrustrated(text)) { offerAgentConnection(); return; }

    var trimmed = text.trim();
    if (ADDITIONAL_REQUEST_NONE_RE.test(trimmed)) {
      document.getElementById('memo_customer').value = '';
      lastAnnouncedMemoText = '';
    } else {
      document.getElementById('memo_customer').value = trimmed;
      lastAnnouncedMemoText = trimmed;
      addBubble('요청사항을 \'' + trimmed + '\'(으)로 확인했습니다.', 'bot');
    }
    additionalRequestResolved = true;
    var doneText = proceedAfterCollecting();
    logBotMessage({ logText: doneText, needsAgent: false, requestedFeature: null });
  }

  // 등록 후에도 AI 챗봇 화면에 머물러야 하므로(실제 폼 submit은 오더 상세 페이지로 이동시켜버림)
  // fetch로 같은 폼 데이터를 보내고, 서버는 X-Requested-With 헤더를 보고 리다이렉트 대신 JSON을 응답한다.
  function submitOrderForm() {
    var form = document.getElementById('orderForm');
    if (!form) return;
    var params = new URLSearchParams(new FormData(form));
    fetch(form.action, {
      method: 'POST',
      headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    })
      .then(function (res) {
        // 서버가 항상 JSON으로 에러를 내려주도록 고쳤지만, 혹시 그 경로를 벗어난 예외적인 응답이
        // 와도 "JSON이 아니다"라는 파싱 에러가 실제 에러 대신 노출되는 일이 없도록 안전하게 처리한다.
        if (!res.ok) {
          return res.json()
            .catch(function () { return {}; })
            .then(function (data) { throw new Error(data.error || '등록에 실패했습니다. (서버 응답 코드: ' + res.status + ')'); });
        }
        return res.json();
      })
      .then(function (data) {
        var okText = data.oid + ' 오더가 정상적으로 등록되었습니다. 새 오더 접수를 준비할게요.';
        addBubble(okText, 'bot');
        // 이 세션은 완료된 것으로 닫는다 — 안 그러면 새로고침 후 세션 복원 기능이 방금 끝난
        // 오더의 phase/필드 값을 그대로 되살려서 새 오더 접수를 방해하게 된다.
        logBotMessage({ logText: okText, needsAgent: false, requestedFeature: null, closeSession: true });
        setTimeout(function () { window.location.href = '/orders/ai-intake'; }, 2000);
      })
      .catch(function (err) {
        var failText = '오더 등록에 실패했습니다. (' + err.message + ') 다시 확인 후 시도해주세요.';
        addBubble(failText, 'bot');
        logBotMessage({ logText: failText, needsAgent: false, requestedFeature: null });
        phase = 'confirming';
      });
  }

  function precheckOrderForm() {
    var form = document.getElementById('orderForm');
    if (!form) return Promise.resolve({ ok: false, error: '오더 등록 폼을 찾을 수 없습니다.' });
    var params = new URLSearchParams(new FormData(form));
    return fetch('/orders/ai-intake/submit-precheck', {
      method: 'POST',
      headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    })
      .then(function (res) {
        if (res.status === 404) {
          // 배포 전파 지연/캐시로 precheck 라우트가 아직 없는 서버를 만났을 때,
          // 등록 자체를 막지 않고 기존 최종 등록 검증으로 폴백한다.
          return { ok: true, skipped: true };
        }
        var contentType = String(res.headers.get('content-type') || '').toLowerCase();
        var isJson = contentType.indexOf('application/json') >= 0;
        if (!isJson) {
          if (res.status === 401 || res.redirected) {
            return { ok: false, error: '로그인 세션이 만료되었습니다. 다시 로그인해주세요.' };
          }
          return { ok: false, error: '등록 가능 여부 확인 응답 형식이 올바르지 않습니다. (HTTP ' + res.status + ')' };
        }
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (res.ok && data && data.ok) return { ok: true };
          if (res.status === 401) {
            return { ok: false, error: (data && (data.error || data.message)) || '로그인 세션이 만료되었습니다. 다시 로그인해주세요.' };
          }
          return { ok: false, error: (data && (data.error || data.message)) || ('등록 가능 여부를 확인하지 못했습니다. (HTTP ' + res.status + ')') };
        });
      })
      .catch(function () {
        return { ok: false, error: '등록 가능 여부를 확인하지 못했습니다. 네트워크 상태를 확인해주세요.' };
      });
  }

  // 로컬 키워드로 판단이 애매할 때 쓰는 폴백 — 확인/수정/후보선택 단계 각각에서 방금 무엇을 물었는지와
  // 사용자의 답변을 Gemini에게 보내 분류받는다. 실패하면 'unclear'로 처리해 기존 안내 문구로 대체한다.
  function classifyPhaseReplyFallback(text, phaseName, candidateLabels) {
    return fetch('/orders/ai-intake/classify-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, phase: phaseName, candidates: candidateLabels || [] }),
    })
      .then(function (res) { return res.json(); })
      .catch(function () { return { action: 'unclear' }; });
  }

  function startModifyFlow() {
    noteProgress();
    phase = 'choose_field';
    var q = '어느 부분을 수정해드릴까요?';
    addBubble(q, 'bot', null, true);
    logBotMessage({ logText: q, needsAgent: false, requestedFeature: null });
  }

  function confirmAndSubmit() {
    noteProgress();
    precheckOrderForm().then(function (result) {
      if (!result.ok) {
        var failText = '오더 등록에 실패했습니다. (' + result.error + ') 다시 확인 후 시도해주세요.';
        addBubble(failText, 'bot');
        logBotMessage({ logText: failText, needsAgent: false, requestedFeature: null });
        phase = 'confirming';
        return;
      }

      var okText = '접수를 등록하겠습니다.';
      addBubble(okText, 'bot');
      logBotMessage({ logText: okText, needsAgent: false, requestedFeature: null });
      setTimeout(submitOrderForm, 400);
    });
  }

  function handleConfirmingPhase(text) {
    if (isAgentRequest(text)) {
      escalateToAgent('상담원 연결');
      return null;
    }
    if (looksFrustrated(text)) { offerAgentConnection(); return null; }
    if (isNegative(text)) { startModifyFlow(); return null; }
    if (isAffirmative(text)) { confirmAndSubmit(); return null; }

    // 로컬 키워드로 뭔지 못 알아들었을 때만 Gemini에게 물어본다(흔한 "네"/"아니요"는 여기까지 안 옴).
    return classifyPhaseReplyFallback(text, 'confirming').then(function (result) {
      if (result.action === 'agent') { escalateToAgent('상담원 연결'); return; }
      if (result.action === 'no') { startModifyFlow(); return; }
      if (result.action === 'yes') { confirmAndSubmit(); return; }
      if (noteTrouble()) return;
      var clarify = '등록해 드릴까요, 아니면 수정해 드릴까요?';
      addBubble(clarify, 'bot');
      logBotMessage({ logText: clarify, needsAgent: false, requestedFeature: null });
    });
  }

  // ---------------- "어느 부분을 수정해드릴까요?" 응답 처리 ----------------
  function matchFieldKeyword(text) {
    for (var i = 0; i < FIELD_KEYWORDS.length; i++) {
      if (FIELD_KEYWORDS[i].re.test(text)) return fieldMetaFor(FIELD_KEYWORDS[i].id);
    }
    return null;
  }

  var CHOOSE_FIELD_CLARIFY = '출발지 주소 / 출발지 연락처 / 차량번호 / 예약일시 / 도착지 주소 / 도착지 연락처 중 어느 항목을 수정할지 말씀해주세요?';

  function applyFieldChoice(field, text) {
    noteProgress();
    lastModifiedFieldId = field.id;
    modifyFieldMode = true;

    // 연락처 항목이고 문장 안에 전화번호가 바로 보이면(예: "연락처를 010-9999-1234로 바꿔줘") 한 번에 처리한다.
    if (field.type === 'phone') {
      var phoneMatch = text.match(/0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}/);
      if (phoneMatch) {
        document.getElementById(field.id).value = phoneMatch[0];
        phase = 'collecting';
        return validatePhoneField(field.id, field.label).then(function () {
          var doneText = proceedAfterCollecting();
          logBotMessage({ logText: doneText, needsAgent: false, requestedFeature: null });
        });
      }
    }

    if (field.id === 'vehicle_number') vehicleNumberFailCount = 0;
    phase = 'collecting';
    setPendingField(field.id);

    function askAgain() {
      var q = field.label + '를 다시 알려주세요?' + (
        field.type === 'phone' ? ' (예: 010-1234-5678)'
          : field.type === 'datetime' ? ' (예: 내일 오후 3시 / 00일 00시)'
          : field.type === 'vehicle' ? ' (출발지 도착 후 확인 가능하면 "다음" 또는 "없어"라고 답해주셔도 됩니다)'
          : ''
      );
      addBubble(q, 'bot', null, true);
      logBotMessage({ logText: q, needsAgent: false, requestedFeature: null });
    }

    // 주소/차량번호/예약일시도 "출발지는 알파동타워"처럼 새 값이 같은 문장에 이미 와 있는 경우가
    // 흔한데, 전화번호와 달리 무조건 다시 물어보고 있었다 — Gemini 추출을 한 번 시도해서 값을
    // 찾으면 바로 적용하고, 못 찾을 때만(예: "출발지" 한 마디만 온 경우) 재입력을 요청한다.
    if (field.type === 'address' || field.type === 'vehicle' || field.type === 'datetime') {
      showThinkingBubble();
      return fetch('/orders/ai-intake/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify({ text: text, pendingField: field.id }),
      })
        .then(function (res) { return res.json().catch(function () { return {}; }); })
        .then(function (data) {
          hideThinkingBubble();
          var hasOrderIntent = data && isOrderIntent(data.intent);
          var hasValue = hasOrderIntent && (
            field.id === 'reserved_date' ? !!(data.reserved_date || data.reserved_time)
              : field.id === 'vehicle_number' ? !!data.origin_vehicle_number
              : !!data[field.id]
          );
          if (!hasValue) { askAgain(); return; }
          return handleOrderIntent(data, text).then(function (result) { logBotMessage(result); });
        })
        .catch(function () { hideThinkingBubble(); askAgain(); });
    }

    askAgain();
    return null;
  }

  function handleChooseFieldPhase(text) {
    if (isAgentRequest(text)) {
      escalateToAgent('상담원 연결');
      return null;
    }
    if (looksFrustrated(text)) { offerAgentConnection(); return null; }
    var field = matchFieldKeyword(text);
    if (field) return applyFieldChoice(field, text);

    // 로컬 키워드로 항목을 못 찾았을 때만 Gemini에게 물어본다 — "수정할 거 없어" 같은 예상 못 한
    // 표현도 여기서 잡아낸다(action: 'none'이면 사실 수정할 게 없다는 뜻이므로 그냥 다시 확인 질문으로 돌아간다).
    return classifyPhaseReplyFallback(text, 'choose_field').then(function (result) {
      if (result.action === 'agent') { escalateToAgent('상담원 연결'); return; }
      if (result.action === 'field' && result.field) {
        var meta = fieldMetaFor(result.field);
        if (meta) return applyFieldChoice(meta, text);
      }
      if (result.action === 'none') {
        noteProgress();
        var doneText = proceedAfterCollecting();
        logBotMessage({ logText: doneText, needsAgent: false, requestedFeature: null });
        return;
      }
      if (noteTrouble()) return;
      addBubble(CHOOSE_FIELD_CLARIFY, 'bot', null, true);
      logBotMessage({ logText: CHOOSE_FIELD_CLARIFY, needsAgent: false, requestedFeature: null });
    });
  }

  // ---------------- "어느 곳이 맞을까요? 1)/2)" 응답 처리 ----------------
  function matchCandidateChoice(text, candidates) {
    var t = text.trim();
    if (/^1\s*(번|\.|\))?$/.test(t) || /^첫/.test(t)) return candidates[0];
    if (/^2\s*(번|\.|\))?$/.test(t) || /^(둘|두\s?번)/.test(t)) return candidates[1];
    for (var i = 0; i < candidates.length; i++) {
      if (t.length >= 2 && candidates[i].label && candidates[i].label.indexOf(t) !== -1) return candidates[i];
    }
    return null;
  }

  function applyDisambiguationChoice(chosen) {
    noteProgress();
    var d = pendingDisambiguation;
    var applyFn = window.__aiIntakeApplyCandidate;
    var resolvedText = applyFn ? applyFn(d.fieldId, kindForAddressId(d.fieldId), chosen.result) : chosen.label;
    addBubble(d.label + '는 \'' + resolvedText + '\'(으)로 확인했습니다.', 'bot');

    if (disambiguationQueue.length) {
      pendingDisambiguation = disambiguationQueue.shift();
      var nextQ = candidateListText(pendingDisambiguation);
      addBubble(nextQ, 'bot', null, true);
      logBotMessage({ logText: nextQ, needsAgent: false, requestedFeature: null });
      return;
    }

    pendingDisambiguation = null;
    phase = 'collecting';
    var doneText = proceedAfterCollecting();
    logBotMessage({ logText: doneText, needsAgent: false, requestedFeature: null });
  }

  function handleDisambiguationPhase(text) {
    if (isAgentRequest(text)) {
      escalateToAgent('상담원 연결'); // 이전 후보선택 상태 초기화는 escalateToAgent가 담당
      return null;
    }
    if (looksFrustrated(text)) { offerAgentConnection(); return null; }
    var d = pendingDisambiguation;
    var chosen = matchCandidateChoice(text, d.candidates);
    if (chosen) { applyDisambiguationChoice(chosen); return null; }

    // 로컬로 "1"/"2"/이름 일부를 못 찾았을 때만 Gemini에게 물어본다.
    var candidateLabels = d.candidates.map(function (c) { return c.label; });
    return classifyPhaseReplyFallback(text, 'choose_address_candidate', candidateLabels).then(function (result) {
      if (result.action === 'agent') { escalateToAgent('상담원 연결'); return; }
      if (result.action === 'choice1') { applyDisambiguationChoice(d.candidates[0]); return; }
      if (result.action === 'choice2') { applyDisambiguationChoice(d.candidates[1]); return; }
      if (noteTrouble()) return;
      var clarify = '1번 또는 2번으로 답해주세요.';
      addBubble(clarify, 'bot');
      logBotMessage({ logText: clarify, needsAgent: false, requestedFeature: null });
    });
  }

  function ensureSession() {
    if (sessionId) return Promise.resolve(sessionId);
    return fetch('/chat/session', { method: 'POST' })
      .then(function (res) { return res.json(); })
      .then(function (data) { sessionId = data.sessionId; startStreaming(); return sessionId; })
      .catch(function () { return null; });
  }

  function logUserMessage(text) {
    if (!sessionId) return Promise.resolve(sessionStatus);
    return fetch('/chat/' + sessionId + '/user-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) { sessionStatus = data.status || sessionStatus; return sessionStatus; })
      .catch(function () { return sessionStatus; });
  }

  function logBotMessage(result) {
    if (!sessionId) return Promise.resolve(null);
    return fetch('/chat/' + sessionId + '/bot-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: result.logText, needsAgent: result.needsAgent, requestedFeature: result.requestedFeature,
        draftState: buildDraftState(), closeSession: !!result.closeSession,
      }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) { if (data.status) sessionStatus = data.status; return data.message || null; })
      .catch(function () { return null; });
  }

  // 서버에서 온 메시지를 id 기준으로 중복 없이 반영한다(재연결 시 보충분과 실시간 수신분이 겹칠 수 있어서).
  // user/bot 메시지는 이 페이지 자체의 요청/응답 흐름으로 이미 그려지므로 여기서는 무시하고,
  // agent(상담원 답장)와 system(예: "상담원이 접속했습니다" 같은 서버발 알림)만 새로 그린다.
  function applyIncomingMessages(list) {
    (list || []).forEach(function (m) {
      if (!m || m.id <= lastPolledId) return;
      lastPolledId = m.id;
      if (m.sender === 'agent') addBubble(m.message, 'agent');
      else if (m.sender === 'system') addBubble(m.message, 'bot');
    });
  }

  function catchUpMessages() {
    if (!sessionId) return;
    fetch('/chat/' + sessionId + '/messages?since=' + lastPolledId)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.status) sessionStatus = data.status;
        applyIncomingMessages(data.messages);
      })
      .catch(function () {});
  }

  // 다른 메뉴로 이동했다 돌아와도 대화가 이어지도록, 서버가 (로그인 세션만으로 판단해) 내려준
  // 아직 닫히지 않은 기존 세션이 있으면 그 대화 내용과 오더접수 진행 상태(입력된 필드/phase 등,
  // buildDraftState/restoreDraftState)를 함께 복원한다. localStorage 등 클라이언트 저장소는 쓰지
  // 않는다 — 시크릿모드/캐시 삭제/다른 탭에서도 로그인만 되어 있으면 항상 동작한다.
  function restoreExistingSession(existing) {
    sessionId = existing.id;
    sessionStatus = existing.status;
    // 화면에는 항상 "오더접수 내용을 붙여넣거나..." 안내 말풍선이 서버 렌더링 시점에 이미 하나
    // 박혀 있는데(빈 대화 첫 진입을 위한 것), 복원할 이전 대화가 있으면 그 안내 위에 그냥
    // 이어붙이기만 해서 매번 재진입할 때마다 안내 문구가 또 나오는 것처럼 보였다 — 실제 대화를
    // 복원하는 경우엔 이 안내를 지우고 시작한다.
    if (existing.messages && existing.messages.length > 0) messages.innerHTML = '';
    (existing.messages || []).forEach(function (m) {
      if (m.id > lastPolledId) lastPolledId = m.id;
      if (m.sender === 'agent') addBubble(m.message, 'agent', m.created_at);
      else if (m.sender === 'user') addBubble(m.message, 'user', m.created_at);
      else addBubble(m.message, 'bot', m.created_at); // 'bot' | 'system'
    });
    restoreDraftState(existing.draft);
    startStreaming();
  }

  // Supabase Realtime Broadcast를 서버가 SSE로 중계한 것을 받는다(Supabase 키는 브라우저에 없음).
  // EventSource는 끊기면 브라우저가 알아서 재연결하는데, onopen 시점마다 유실 구간을 보충 조회한다.
  function startStreaming() {
    if (!sessionId || !window.EventSource) return;
    var es = new EventSource('/chat/' + sessionId + '/stream');
    es.onopen = catchUpMessages;
    es.onmessage = function (e) {
      try { applyIncomingMessages([JSON.parse(e.data)]); } catch (err) { /* noop */ }
    };
  }

  function updateSendButton() {
    sendBtn.disabled = !textarea.value.trim() || sendBtn.dataset.processing === '1';
  }

  function extractAndProcess() {
    var text = textarea.value.trim();
    if (!text || sendBtn.disabled) return;
    addBubble(text, 'user');
    touchAiActivity(true);
    textarea.value = '';
    collapseChatInput();
    sendBtn.dataset.processing = '1';
    updateSendButton();

    ensureSession()
      .then(function () { return logUserMessage(text); })
      .then(function (status) {
        if (status === 'needs_agent' || status === 'agent_active') {
          // 상담원 세션에서는 봇을 다시 호출하지 않는다. 상담원이 이미 응대 중(agent_active)이면
          // 고객이 메시지를 보낼 때마다 별도 안내 없이 그대로 전달만 한다(이미 서버에 저장돼
          // 상담원이 볼 수 있음) — 매번 "대화 중입니다" 안내가 반복되는 게 불필요하다는 피드백 반영.
          // 아직 상담원이 붙지 않은 needs_agent 상태에서는, 이 상태로 처음 넘어온 메시지에서만
          // 접수 안내를 보여주고 이후 반복해서 보여주지 않는다.
          if (status === 'needs_agent' && lastWaitingStatusShown !== status) {
            lastWaitingStatusShown = status;
            var waitingText = '상담원 연결 요청이 접수되었습니다. 상담원이 확인 후 답변드리겠습니다.';
            addBubble(waitingText, 'bot');
            logBotMessage({ logText: waitingText, needsAgent: false, requestedFeature: null });
          }
          return null;
        }
        // 이 세 분기와 아래 "상담원 연결" 빠른 경로는 전부 비동기(Gemini 폴백 분류/서버 호출)일 수
        // 있으므로, 여기서 전송 버튼을 미리 활성화하지 않는다 — 실제로 여기서 미리 풀어줬다가
        // 아직 이 턴의 처리(예: 폴백 분류 왕복)가 안 끝난 상태에서 사용자가 다음 메시지를 보내
        // 두 턴이 겹쳐 상태(phase 등)가 꼬일 수 있었다. 버튼은 이 체인이 완전히 끝나는 지점
        // (아래 다음 .then 맨 앞)에서 한 번만 풀어준다.
        if (phase === 'offer_agent') { handleOfferAgentPhase(text); return null; }
        if (phase === 'confirming') return handleConfirmingPhase(text);
        if (phase === 'choose_field') return handleChooseFieldPhase(text);
        if (phase === 'choose_address_candidate') return handleDisambiguationPhase(text);
        if (phase === 'collecting' && pendingField === 'memo_customer') {
          handleAdditionalRequestPendingReply(text);
          return null;
        }
        if (phase === 'collecting' && pendingField === 'vehicle_number' && handleVehicleNumberPendingReply(text)) {
          return null;
        }
        if (handleFareInquiryPendingReply(text)) return null;
        // 명시적인 "상담원 연결" 요청은 Gemini 분류를 거치지 않고 바로 처리한다 — 이 요청만큼은
        // 콜드스타트/응답지연으로 고객이 기다리다 이탈해서 에스컬레이션 자체가 무산되는 일이 없어야 한다.
        // 단, 전화번호나 출/도/경 라벨 같은 오더접수 신호가 함께 있으면(예: 메모에 "상담원"이 우연히
        // 섞인 진짜 오더접수 메시지) 빠른 경로를 타지 않고 정상적으로 Gemini 분류로 넘긴다.
        if (isAgentRequest(text) && !looksLikeOrderIntake(text)) {
          return logBotMessage(handleUnsupportedIntent({ requestedFeature: '상담원 연결' })).then(function (finalText) {
            if (finalText) addBubble(finalText, 'bot');
          });
        }

        var fareType = detectFareInquiryType(text);
        if (fareType) {
          if (fareType !== 'dispatch') {
            var notReadyText = fareType === 'proxy'
              ? '대리요금 문의는 현재 설계 준비 중입니다. 우선 탁송 요금 문의를 원하시면 출발지와 도착지를 알려주세요.'
              : '일일대리기사 요금 문의는 현재 설계 준비 중입니다. 우선 탁송 요금 문의를 원하시면 출발지와 도착지를 알려주세요.';
            addBubble(notReadyText, 'bot');
            logBotMessage({ logText: notReadyText, needsAgent: false, requestedFeature: null });
            return null;
          }

          var fareParsed = extractFareInquiryRouteInfo(text);
          fareInquiryDraft = {
            type: 'dispatch',
            origin: fareParsed.origin || '',
            destination: fareParsed.destination || '',
            vehicleType: fareParsed.vehicleType || '',
          };

          var needQuestion = askFareInquiryMissingField();
          if (needQuestion) {
            addBubble('탁송 요금 문의로 접수했습니다. 필수 정보를 확인하겠습니다.', 'bot');
            addBubble(needQuestion, 'bot', null, true);
            logBotMessage({ logText: '탁송 요금 문의로 접수했습니다. 필수 정보를 확인하겠습니다.\n' + needQuestion, needsAgent: false, requestedFeature: null });
            return null;
          }

          clearFareInquiryDraft();
          return handleFareInquiryFlowFromText(fareParsed).then(function () { return null; });
        }

        showThinkingBubble();
        // pendingField가 아직 없으면(대화 첫 메시지, 또는 앞서 faq/unsupported로 잘못 새서 한 번도
        // 못 정해진 경우) 힌트 없이 보내는 대신, 지금 실제로 비어있는 다음 필수 항목을 힌트로 대신
        // 채워 보낸다 — 라벨 없는 단답(지명 하나, 전화번호 하나 등)이 엉뚱한 의도로 분류되는 걸 줄인다.
        var hintField = pendingField || (getNextMissingField() || {}).id || null;
        return fetch('/orders/ai-intake/parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
          body: JSON.stringify({ text: text, pendingField: hintField }),
        }).then(function (res) {
          // 서버가 X-Requested-With: fetch 요청에는 항상 JSON으로 에러를 내려주지만,
          // 혹시 모를 예외 상황에서도 "JSON이 아니다"라는 파싱 에러가 실제 에러 대신
          // 노출되는 일이 없도록 안전하게 처리한다.
          return res.json().catch(function () {
            return { error: '서버 응답을 읽는 중 문제가 발생했습니다. (상태 코드: ' + res.status + ')' };
          });
        });
      })
      .then(function (data) {
        hideThinkingBubble();
        delete sendBtn.dataset.processing;
        updateSendButton();
        if (!data) return;
        if (typeof data.intent === 'string' || data.error) checkAiConnectionHealth();
        if (data.error) { addBubble('처리 실패: ' + data.error, 'bot'); return; }
        // 이번 메시지에서 화남/답답함이 감지됐으면, 지금 처리할 내용은 평소대로 처리하되 다음 필수
        // 질문 대신 상담원 연결을 먼저 제안하도록 표시해둔다(maybeOfferForFrustration이 소비한다).
        if (data.seemsFrustrated) pendingFrustrationOffer = true;

        // Gemini는 "형식이 안 맞는 연락처"를 그냥 필드를 비운 채로 돌려준다(값을 몰라서가 아니라 못 알아봐서).
        // 지금 막 연락처를 물어본 상태이고 답변이 숫자/기호로만 되어 있으면(=전화번호를 시도한 것으로 보이면)
        // Gemini의 판단과 무관하게 직접 형식을 검사해서 이유를 알려준다.
        var pendingMeta = fieldMetaFor(pendingField);
        var pendingWasFilled = pendingMeta && isOrderIntent(data.intent) && data[pendingField];
        if (pendingMeta && pendingMeta.type === 'phone' && !pendingWasFilled && /^[\d\-\s()]{2,}$/.test(text)) {
          document.getElementById(pendingField).value = text;
          validatePhoneField(pendingField, pendingMeta.label).then(function () {
            var doneText = proceedAfterCollecting();
            logBotMessage({ logText: doneText, needsAgent: false, requestedFeature: null });
          });
          return;
        }

        if (data.intent === 'greeting') {
          addBubble(data.message, 'bot');
          logBotMessage({ logText: data.message, needsAgent: false, requestedFeature: null });
          maybeOfferForFrustration();
          return;
        }
        if (data.intent === 'unsupported') {
          // 이미 상담원 연결로 넘어가는 경로라(needsAgent:true) 화남 감지로 또 물어볼 필요가 없다.
          pendingFrustrationOffer = false;
          // 상담원 접속 여부에 따른 최종 문구를 서버가 정하므로, 응답을 받은 뒤에 말풍선을 붙인다.
          logBotMessage(handleUnsupportedIntent(data)).then(function (finalText) {
            if (finalText) addBubble(finalText, 'bot');
          });
          return;
        }
        if (data.intent === 'faq') {
          logBotMessage(handleFaqIntent(data));
          maybeOfferForFrustration();
          return;
        }
        handleOrderIntent(data, text).then(function (result) { logBotMessage(result); });
      })
      .catch(function (err) {
        hideThinkingBubble();
        delete sendBtn.dataset.processing;
        updateSendButton();
        // 이전에는 원인과 무관하게 항상 같은 문구만 보여줘서, 실제로 무엇이 실패했는지
        // 나중에 재현/진단할 방법이 없었다 — 에러 메시지를 함께 보여준다.
        var detail = err && err.message ? ' (' + err.message + ')' : '';
        addBubble('처리 중 오류가 발생했습니다.' + detail + ' 다시 시도해주세요.', 'bot');
      });
  }

  sendBtn.addEventListener('click', extractAndProcess);

  var favoriteBtn = document.getElementById('aiFavoriteBtn');
  if (favoriteBtn) {
    favoriteBtn.addEventListener('click', function () {
      if (sendBtn.dataset.processing === '1' || phase !== 'collecting') return;
      var opener = window.__aiIntakeOpenFavoriteModal;
      if (!opener) return;
      opener(pendingField, handleFavoriteSelected);
    });
  }
  textarea.addEventListener('compositionstart', function () {
    isComposing = true;
  });
  textarea.addEventListener('compositionend', function () {
    isComposing = false;
    if (submitAfterCompositionEnd) {
      submitAfterCompositionEnd = false;
      extractAndProcess();
    }
  });
  textarea.addEventListener('input', function () {
    autoResizeChatInput();
    updateSendButton();
    touchAiActivity(false);
  });
  textarea.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      // 한글 IME 조합 중 Enter는 먼저 조합 확정에 사용된다.
      // 이때 즉시 전송하면 마지막 글자가 입력창에 남을 수 있어 조합 종료 후 전송한다.
      if (e.isComposing || isComposing || e.keyCode === 229) {
        e.preventDefault();
        submitAfterCompositionEnd = true;
        return;
      }
      e.preventDefault();
      extractAndProcess();
    }
  });
  collapseChatInput();
  updateSendButton();
  checkAiConnectionHealth();
  setInterval(checkAiConnectionHealth, AI_HEALTH_POLL_INTERVAL_MS);

  // ---------- 햄버거 메뉴(새 채팅 / 검색 / 최근 항목) ----------
  (function wireChatHistoryMenu() {
    var menuBtn = document.getElementById('aiChatMenuBtn');
    var menuPanel = document.getElementById('aiChatMenuPanel');
    var newChatBtn = document.getElementById('aiNewChatBtn');
    var searchToggleBtn = document.getElementById('aiChatSearchToggleBtn');
    var searchRow = document.getElementById('aiChatSearchRow');
    var searchInput = document.getElementById('aiChatSearchInput');
    var recentList = document.getElementById('aiChatRecentList');
    if (!menuBtn || !menuPanel || !recentList) return;

    var loadedOnce = false;
    var loading = false;
    var hasMore = true;
    var cursor = null; // 다음 페이지 조회 시 이 id보다 작은 것만(오래된 순으로 더 불러오기)
    var searchQuery = '';
    var searchDebounceTimer = null;

    function closeMenuPanel() {
      menuPanel.style.display = 'none';
      menuBtn.setAttribute('aria-expanded', 'false');
    }
    function openMenuPanel() {
      menuPanel.style.display = 'flex';
      menuBtn.setAttribute('aria-expanded', 'true');
      if (!loadedOnce) loadRecentSessions(true);
    }

    function renderRecentItem(s) {
      var btn = document.createElement('div');
      btn.className = 'ai-chat-recent-item' + (String(s.id) === String(sessionId) ? ' active' : '');
      btn.setAttribute('role', 'button');
      btn.setAttribute('tabindex', '0');
      var summary = document.createElement('span');
      summary.className = 'ai-chat-recent-summary';
      summary.textContent = s.summary;
      summary.title = s.summary;

      var meta = document.createElement('span');
      meta.className = 'ai-chat-recent-meta';

      var dt = document.createElement('span');
      dt.className = 'ai-chat-recent-date';
      dt.textContent = formatRecentDateTime(s.updatedAt);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'ai-chat-recent-delete';
      del.textContent = '×';
      del.title = '삭제';
      del.setAttribute('aria-label', '삭제');
      del.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        // 실제로는 DB에서 지우지 않고 이 사용자 화면(최근 목록)에서만 숨긴다(user_hidden_at) —
        // 문구는 사용자에게 익숙한 "삭제"로 보여주되 동작은 그대로 소프트 삭제를 유지한다.
        if (!window.confirm('이 항목을 삭제하시겠습니까?')) return;
        del.disabled = true;
        fetch('/orders/ai-intake/sessions/' + encodeURIComponent(s.id) + '/delete', {
          method: 'POST',
          headers: { 'X-Requested-With': 'fetch' },
        })
          .then(function (res) {
            return res.text().then(function (raw) {
              var data = {};
              try { data = raw ? JSON.parse(raw) : {}; } catch (e) { /* 서버가 JSON이 아닌 응답(플랫폼 타임아웃 등)을 준 경우 */ }
              if (!res.ok) {
                // 원인을 알 수 없는 일반 문구 대신, 실제 상태 코드/응답을 함께 보여준다 — 다음에
                // 같은 문제가 재현되면 무엇이 실패했는지 바로 알 수 있어야 한다.
                var detail = (data && data.error) || (raw ? raw.slice(0, 200) : ('상태 코드 ' + res.status));
                throw new Error(detail);
              }
              return data;
            });
          })
          .then(function () {
            if (String(s.id) === String(sessionId)) {
              window.location.href = '/orders/ai-intake';
              return;
            }
            loadRecentSessions(true);
          })
          .catch(function (err) {
            del.disabled = false;
            alert('삭제에 실패했습니다: ' + (err && err.message ? err.message : '알 수 없는 오류'));
          });
      });

      meta.appendChild(dt);
      meta.appendChild(del);

      btn.appendChild(summary);
      btn.appendChild(meta);
      btn.title = s.summary;
      btn.addEventListener('click', function () {
        window.location.href = '/orders/ai-intake?session=' + encodeURIComponent(s.id);
      });
      btn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          window.location.href = '/orders/ai-intake?session=' + encodeURIComponent(s.id);
        }
      });
      return btn;
    }

    // 검색어를 계속 고쳐 타이핑하면 이전 요청이 응답하기 전에 새 요청이 나갈 수 있는데,
    // 네트워크 지연으로 이전(오래된 검색어) 응답이 나중에 도착하면 방금 친 검색어 결과를
    // 덮어써 버려 "검색이 안 먹히는 것처럼" 보이는 문제가 있었다 — 요청마다 순번을 매겨
    // 가장 최신 요청의 응답만 반영한다.
    var requestSeq = 0;
    function loadRecentSessions(reset) {
      if (reset) {
        cursor = null; hasMore = true; recentList.innerHTML = '';
      } else if (loading || !hasMore) {
        return;
      }
      loading = true;
      loadedOnce = true;
      var mySeq = ++requestSeq;
      var loadingEl = document.createElement('div');
      loadingEl.className = 'ai-chat-recent-loading';
      loadingEl.textContent = '불러오는 중...';
      recentList.appendChild(loadingEl);

      var params = new URLSearchParams();
      if (cursor) params.set('before', cursor);
      if (searchQuery) params.set('q', searchQuery);

      fetch('/orders/ai-intake/sessions?' + params.toString())
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (mySeq !== requestSeq) return; // 이미 더 최신 요청이 나간 뒤라 이 응답은 버린다
          loadingEl.remove();
          var sessions = (data && data.sessions) || [];
          hasMore = !!(data && data.hasMore);
          if (reset && sessions.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'ai-chat-recent-empty';
            empty.textContent = '대화 내역이 없습니다.';
            recentList.appendChild(empty);
          }
          sessions.forEach(function (s) {
            recentList.appendChild(renderRecentItem(s));
            cursor = s.id;
          });
        })
        .catch(function () { if (mySeq === requestSeq) loadingEl.remove(); })
        .finally(function () { if (mySeq === requestSeq) loading = false; });
    }

    menuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (menuPanel.style.display === 'none') openMenuPanel(); else closeMenuPanel();
    });
    document.addEventListener('click', function (e) {
      if (menuPanel.style.display !== 'none' && !menuPanel.contains(e.target) && e.target !== menuBtn) closeMenuPanel();
    });

    if (newChatBtn) {
      newChatBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        newChatBtn.disabled = true;
        var closePromise = sessionId
          ? fetch('/chat/' + sessionId + '/bot-message', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ closeSession: true }),
            }).catch(function () {})
          : Promise.resolve();
        closePromise.then(function () { window.location.href = '/orders/ai-intake'; });
      });
    }

    if (searchToggleBtn && searchRow && searchInput) {
      searchToggleBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var showing = searchRow.style.display !== 'none';
        searchRow.style.display = showing ? 'none' : 'block';
        if (!showing) searchInput.focus();
      });
      searchInput.addEventListener('click', function (e) { e.stopPropagation(); });
      searchInput.addEventListener('input', function () {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(function () {
          searchQuery = searchInput.value.trim();
          loadRecentSessions(true);
        }, 300);
      });
    }

    recentList.addEventListener('click', function (e) { e.stopPropagation(); });
    recentList.addEventListener('scroll', function () {
      if (recentList.scrollTop + recentList.clientHeight >= recentList.scrollHeight - 40) loadRecentSessions(false);
    });
  })();

  if (window.__aiIntakeExistingSession) restoreExistingSession(window.__aiIntakeExistingSession);
})();
