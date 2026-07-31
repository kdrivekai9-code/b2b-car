// 상담관리 카드뷰: 세션 목록은 가볍게 유지하고, 선택한 세션만 메시지를 지연 로딩한다.
(function () {
  var layoutEl = document.querySelector('.chat-admin-layout');
  var cardButtons = Array.prototype.slice.call(document.querySelectorAll('.session-card-item'));
  var messagesEl = document.getElementById('cardSessionMessages');
  var viewerHead = document.getElementById('cardViewerHead');
  var viewerActions = document.getElementById('cardViewerActions');
  var loadOlderBtn = document.getElementById('loadOlderMessagesBtn');
  var openDetailLink = document.getElementById('openSessionDetailLink');
  var assignSelfBtn = document.getElementById('assignSelfBtn');
  var deleteForm = document.getElementById('cardDeleteForm');
  var deleteBtn = document.getElementById('cardDeleteBtn');
  var replyForm = document.getElementById('cardReplyForm');
  var replyText = document.getElementById('cardReplyText');
  var replySendBtn = document.getElementById('cardReplySendBtn');
  var replyError = document.getElementById('cardReplyError');
  var orderForm = document.getElementById('cardOrderForm');
  var orderSessionIdInput = document.getElementById('card_chat_session_id');
  var orderReservedDate = document.getElementById('card_reserved_date');
  var orderReservedDateYear = document.getElementById('card_reserved_date_year');
  var orderReservedDateMonth = document.getElementById('card_reserved_date_month');
  var orderReservedDateDay = document.getElementById('card_reserved_date_day');
  var orderReservedTime = document.getElementById('card_reserved_time');
  var orderReservedTimeHour = document.getElementById('card_reserved_time_hour');
  var orderReservedTimeMinute = document.getElementById('card_reserved_time_minute');
  var orderReservationBasisPickup = document.getElementById('card_reservation_basis_pickup');
  var orderReservationBasisDelivery = document.getElementById('card_reservation_basis_delivery');
  var orderPickupReservedDate = document.getElementById('card_pickup_reserved_date');
  var orderPickupReservedTime = document.getElementById('card_pickup_reserved_time');
  var orderReservationDateTimeLabel = document.getElementById('card_reservation_datetime_label');
  var orderPickupPreviewBlock = document.getElementById('card_pickup_preview_block');
  var orderPickupPreviewValue = document.getElementById('card_pickup_preview_value');
  var orderDeliveryRouteFormula = document.getElementById('card_delivery_route_formula');
  var orderOriginAddress = document.getElementById('card_origin_address');
  var orderOriginDetailAddress = document.getElementById('card_origin_detail_address');
  var orderOriginContact = document.getElementById('card_origin_contact');
  var orderVehicleType = document.getElementById('card_vehicle_type');
  var orderVehicleNumber = document.getElementById('card_vehicle_number');
  var orderDestinationAddress = document.getElementById('card_destination_address');
  var orderDestinationDetailAddress = document.getElementById('card_destination_detail_address');
  var orderDestinationContact = document.getElementById('card_destination_contact');
  var orderBranchId = document.getElementById('card_branch_id');
  var orderRequesterGroupId = document.getElementById('card_requester_group_id');
  var orderPaymentMethodId = document.getElementById('card_payment_method_id');
  var orderFareAmount = document.getElementById('card_fare_amount');
  var orderMemoCustomer = document.getElementById('card_memo_customer');
  var orderTransition = document.getElementById('card_chat_session_transition');
  var orderWaypointsWrap = document.getElementById('cardWaypointsWrap');
  var addOrderWaypointBtn = document.getElementById('cardAddWaypointBtn');
  var orderAddressSearchButtons = Array.prototype.slice.call(document.querySelectorAll('.card-addr-search-btn'));
  if (!layoutEl || !messagesEl || !viewerHead || !viewerActions || !loadOlderBtn || !openDetailLink || !assignSelfBtn || !deleteForm || !deleteBtn || !replyForm || !replyText || !replySendBtn || !replyError) return;

  var hasOrderPane = !!(orderForm && orderSessionIdInput && orderReservedDate && orderReservedDateYear && orderReservedDateMonth && orderReservedDateDay && orderReservedTime && orderReservedTimeHour && orderReservedTimeMinute && orderOriginAddress && orderOriginContact && orderVehicleType && orderDestinationAddress && orderDestinationContact && orderBranchId && orderWaypointsWrap && addOrderWaypointBtn);

  var currentUserId = String(layoutEl.dataset.currentUserId || '');
  var currentUserName = String(layoutEl.dataset.currentUserName || '');

  var selectedSessionId = null;
  var oldestMessageId = null;
  var hasMoreOlder = false;
  var stream = null;
  var isSendingReply = false;
  var selectedSessionStatus = null;
  var selectedAssignedAgentId = '';
  var selectedAssignedAgentName = '';
  var isAssigningSelf = false;
  var knownMessageIds = {};
  var senderLabel = { user: '고객', bot: 'AI', agent: '상담원', system: '시스템' };
  var senderClass = { user: 'ai-user', bot: 'ai-bot', agent: 'ai-agent', system: 'ai-bot' };
  var DELIVERY_BUFFER_SECONDS = 30 * 60;
  var DELIVERY_RESERVATION_MEMO_PREFIX = '**도착지 예약**:';
  var cardRouteDurationSec = null;

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatChatTime(raw) {
    var m = String(raw || '').match(/(\d{1,2}):(\d{2})/);
    if (!m) return '';
    var h = Number(m[1]);
    var mm = m[2];
    var ampm = h < 12 ? '오전' : '오후';
    var h12 = h % 12 || 12;
    return ampm + ' ' + h12 + ':' + mm;
  }

  function formatDuration(seconds) {
    var totalMin = Math.round(Number(seconds || 0) / 60);
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    return h > 0 ? (h + '시간 ' + m + '분') : (m + '분');
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function setInputCoord(input, result) {
    if (!input || !result) return;
    input.dataset.lat = result.lat;
    input.dataset.lon = result.lon;
  }

  function clearInputCoord(input) {
    if (!input) return;
    delete input.dataset.lat;
    delete input.dataset.lon;
  }

  function coordStringFromInput(input) {
    if (!input || !input.dataset.lat || !input.dataset.lon) return '';
    return input.dataset.lon + ',' + input.dataset.lat;
  }

  function parseCardDisplayedDateTime() {
    var dateValue = String(orderReservedDate && orderReservedDate.value || '').trim();
    var timeValue = String(orderReservedTime && orderReservedTime.value || '').trim();
    var d = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    var t = timeValue.match(/^(\d{2}):(\d{2})$/);
    if (!d || !t) return null;
    return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), 0, 0);
  }

  function formatLocalDateTime(dt) {
    if (!dt || isNaN(dt.getTime())) return '-';
    return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate()) + ' ' + pad2(dt.getHours()) + ':' + pad2(dt.getMinutes());
  }

  function roundDateToNearestTenMinutes(dt) {
    if (!dt || isNaN(dt.getTime())) return dt;
    var roundedMs = Math.round(dt.getTime() / 600000) * 600000;
    return new Date(roundedMs);
  }

  function formatDeliveryReservationMemoDateTime(dt) {
    if (!dt || isNaN(dt.getTime())) return '';
    return dt.getFullYear() + '년 ' + pad2(dt.getMonth() + 1) + '월 ' + pad2(dt.getDate()) + ' 일 ' + pad2(dt.getHours()) + '시 ' + pad2(dt.getMinutes()) + ' 분 도착요망';
  }

  function syncCardDeliveryReservationMemo() {
    if (!orderMemoCustomer) return;
    var hasMemo = String(orderMemoCustomer.value || '').trim().length > 0;
    var rawLines = hasMemo ? String(orderMemoCustomer.value).split(/\r?\n/) : [];
    var keptLines = rawLines.filter(function (line) {
      return String(line || '').trim().indexOf(DELIVERY_RESERVATION_MEMO_PREFIX) !== 0;
    });

    if (isDeliveryBasis()) {
      var deliveryDateTime = parseCardDisplayedDateTime();
      var memoDateTime = formatDeliveryReservationMemoDateTime(deliveryDateTime);
      if (memoDateTime) keptLines.push(DELIVERY_RESERVATION_MEMO_PREFIX + ' ' + memoDateTime);
    }

    orderMemoCustomer.value = keptLines.join('\n').replace(/^\n+|\n+$/g, '');
  }

  function isDeliveryBasis() {
    return !!(orderReservationBasisDelivery && orderReservationBasisDelivery.checked);
  }

  function setCardPickupHidden(dt) {
    if (!orderPickupReservedDate || !orderPickupReservedTime) return;
    if (!dt || isNaN(dt.getTime())) {
      orderPickupReservedDate.value = '';
      orderPickupReservedTime.value = '';
      return;
    }
    orderPickupReservedDate.value = dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
    orderPickupReservedTime.value = pad2(dt.getHours()) + ':' + pad2(dt.getMinutes());
  }

  function syncCardReservationPreview() {
    if (!hasOrderPane) return;
    var deliveryBasis = isDeliveryBasis();
    if (!deliveryBasis) {
      if (orderPickupPreviewBlock) orderPickupPreviewBlock.style.display = 'none';
      setCardPickupHidden(parseCardDisplayedDateTime());
      if (orderDeliveryRouteFormula) orderDeliveryRouteFormula.textContent = '(경로탐색 : -)';
      syncCardDeliveryReservationMemo();
      return;
    }
    if (orderPickupPreviewBlock) orderPickupPreviewBlock.style.display = '';
    var deliveryDateTime = parseCardDisplayedDateTime();
    if (!deliveryDateTime || !Number.isFinite(cardRouteDurationSec) || cardRouteDurationSec <= 0) {
      setCardPickupHidden(null);
      if (orderPickupPreviewValue) orderPickupPreviewValue.textContent = '경로 확정 후 자동 계산';
      if (orderDeliveryRouteFormula) orderDeliveryRouteFormula.textContent = '(경로탐색 : 경로 확정 후 자동 계산)';
      syncCardDeliveryReservationMemo();
      return;
    }
    var pickupDateTime = new Date(deliveryDateTime.getTime() - ((cardRouteDurationSec + DELIVERY_BUFFER_SECONDS) * 1000));
    pickupDateTime = roundDateToNearestTenMinutes(pickupDateTime);
    setCardPickupHidden(pickupDateTime);
    if (orderPickupPreviewValue) orderPickupPreviewValue.textContent = formatLocalDateTime(pickupDateTime);
    if (orderDeliveryRouteFormula) orderDeliveryRouteFormula.textContent = '(경로탐색 : ' + formatDuration(cardRouteDurationSec) + ' +30분여유)';
    syncCardDeliveryReservationMemo();
  }

  function readStateText(message) {
    if (!message) return '';
    if (message.sender === 'user') return message.read_by_agent_at ? '읽음' : '미읽음';
    if (message.sender === 'agent') return message.read_by_user_at ? '읽음' : '미읽음';
    return '';
  }

  function setReplyError(text) {
    if (!text) {
      replyError.textContent = '';
      replyError.style.display = 'none';
      return;
    }
    replyError.textContent = text;
    replyError.style.display = '';
  }

  function setSelectedCard(sessionId) {
    cardButtons.forEach(function (btn) {
      if (String(btn.dataset.sessionId) === String(sessionId)) btn.classList.add('active');
      else btn.classList.remove('active');
    });
  }

  function selectedCardButton() {
    if (!selectedSessionId) return null;
    for (var i = 0; i < cardButtons.length; i++) {
      if (String(cardButtons[i].dataset.sessionId) === String(selectedSessionId)) return cardButtons[i];
    }
    return null;
  }

  function applyAssignedAgentToCard(card, id, name) {
    if (!card) return;
    card.dataset.assignedAgentId = id || '';
    card.dataset.assignedAgentName = name || '';
    var metas = card.querySelectorAll('.session-card-meta');
    if (!metas || !metas.length) return;
    var assignMeta = metas[metas.length - 1];
    assignMeta.textContent = '담당: ' + (name || '미지정');
  }

  // DB에는 "질문 말풍선"이라는 별도 플래그가 없으므로, AI 챗봇 쪽 관례(질문 문구는 항상 "?"로
  // 끝남)를 그대로 휴리스틱으로 써서 봇 질문 말풍선에도 같은 파란 배경(.ai-bot-question)을 준다.
  function isQuestionBubble(message) {
    return message.sender === 'bot' && /\?\s*$/.test(String(message.message || '').trim());
  }

  function messageBubbleHtml(message) {
    var who = senderClass[message.sender] || 'ai-bot';
    var label = senderLabel[message.sender] || message.sender;
    var time = formatChatTime(message.created_at);
    var readText = readStateText(message);
    var readClass = readText === '미읽음' ? ' unread' : '';
    var bubbleClass = 'ai-chat-bubble ' + who + (isQuestionBubble(message) ? ' ai-bot-question' : '');
    var footerHtml = (time || readText)
      ? '<div class="bubble-footer">'
        + (time ? ('<div class="bubble-time">' + escapeHtml(time) + '</div>') : '')
        + (readText ? ('<div class="bubble-read' + readClass + '">' + readText + '</div>') : '')
        + '</div>'
      : '';
    return '<div class="ai-chat-item ' + who + '" data-id="' + message.id + '">'
      + '<div class="' + bubbleClass + '">'
      + '<span class="bubble-label">' + escapeHtml(label) + '</span>'
      + escapeHtml(message.message || '')
      + '</div>'
      + footerHtml
      + '</div>';
  }

  function rememberMessage(message) {
    if (!message || !message.id) return false;
    if (knownMessageIds[message.id]) return false;
    knownMessageIds[message.id] = 1;
    return true;
  }

  function resetViewerMeta() {
    knownMessageIds = {};
    oldestMessageId = null;
    hasMoreOlder = false;
    loadOlderBtn.disabled = true;
    loadOlderBtn.style.display = 'none';
  }

  function updateReplyAvailability() {
    if (!selectedSessionId) {
      replyForm.style.display = 'none';
      replyText.disabled = true;
      replySendBtn.disabled = true;
      assignSelfBtn.disabled = true;
      setReplyError('');
      return;
    }
    replyForm.style.display = '';
    assignSelfBtn.disabled = isAssigningSelf;
    assignSelfBtn.textContent = (selectedAssignedAgentId && currentUserId && selectedAssignedAgentId === currentUserId)
      ? '내가 담당중'
      : '내가 담당하기';

    var hasOtherAssignee = selectedAssignedAgentId && currentUserId && selectedAssignedAgentId !== currentUserId;
    if (hasOtherAssignee) {
      replyText.value = '';
      replyText.disabled = true;
      replySendBtn.disabled = true;
      replyText.placeholder = '담당 상담원만 고객에게 응답할 수 있습니다.';
      setReplyError('현재 담당자: ' + (selectedAssignedAgentName || '다른 상담원') + ' · 담당자 변경 후 응답해주세요.');
      return;
    }

    var closed = selectedSessionStatus === 'closed';
    if (closed) {
      replyText.value = '';
      replyText.disabled = true;
      replySendBtn.disabled = true;
      assignSelfBtn.disabled = true;
      replyText.placeholder = '종료된 상담은 이 화면에서 전송할 수 없습니다. 상세 페이지에서 상태를 확인해주세요.';
      setReplyError('');
      return;
    }
    replyText.disabled = false;
    replySendBtn.disabled = isSendingReply || !replyText.value.trim();
    replyText.placeholder = '상담원으로 답변을 입력하세요... (Enter 전송 / Shift+Enter 줄바꿈)';
  }

  function normalizePhoneInput(input) {
    var digits = String(input.value || '').replace(/\D/g, '').slice(0, 11);
    if (!digits) { input.value = ''; return; }
    if (digits.length === 8) { input.value = digits.slice(0, 4) + '-' + digits.slice(4); return; }
    if (digits.indexOf('02') === 0) {
      if (digits.length <= 5) { input.value = digits.slice(0, 2) + '-' + digits.slice(2); return; }
      if (digits.length <= 9) { input.value = digits.slice(0, 2) + '-' + digits.slice(2, 5) + '-' + digits.slice(5); return; }
      input.value = digits.slice(0, 2) + '-' + digits.slice(2, 6) + '-' + digits.slice(6, 10);
      return;
    }
    if (digits.length <= 6) { input.value = digits.slice(0, 3) + '-' + digits.slice(3); return; }
    if (digits.length <= 10) { input.value = digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6); return; }
    input.value = digits.slice(0, 3) + '-' + digits.slice(3, 7) + '-' + digits.slice(7, 11);
  }

  function geocode(query) {
    return fetch('/kakao/search?q=' + encodeURIComponent(query))
      .then(function (res) { return res.json(); })
      .then(function (data) { return data.documents || []; })
      .catch(function () { return []; });
  }

  function mainAddressOf(result) {
    return result.road_address || result.jibun_address || '';
  }

  function resultLabel(result) {
    if (result.type === 'place') {
      var addr = mainAddressOf(result);
      return result.place_name + (addr ? ' · ' + addr : '');
    }
    var main = mainAddressOf(result);
    var sub = (result.road_address && result.jibun_address && result.road_address !== result.jibun_address) ? result.jibun_address : null;
    return main + (sub ? ' (' + sub + ')' : '');
  }

  function renderAddressResults(resultsEl, inputEl, results) {
    if (!resultsEl || !inputEl) return;
    if (!results.length) {
      resultsEl.innerHTML = '<div class="addr-result-item muted">검색 결과가 없습니다.</div>';
      return;
    }
    resultsEl.innerHTML = '';
    results.slice(0, 5).forEach(function (r) {
      var item = document.createElement('div');
      item.className = 'addr-result-item';
      item.textContent = resultLabel(r);
      item.addEventListener('click', function () {
        inputEl.value = mainAddressOf(r);
        setInputCoord(inputEl, r);
        resultsEl.innerHTML = '';
        refreshCardRouteEstimate();
      });
      resultsEl.appendChild(item);
    });
  }

  function searchAddressFor(inputEl, resultsEl) {
    if (!inputEl || !resultsEl) return;
    var q = String(inputEl.value || '').trim();
    if (q.length < 2) {
      resultsEl.innerHTML = '<div class="addr-result-item muted">두 글자 이상 입력해주세요.</div>';
      return;
    }
    resultsEl.innerHTML = '<div class="addr-result-item muted">검색 중...</div>';
    geocode(q).then(function (results) {
      if (String(inputEl.value || '').trim() !== q) return;
      renderAddressResults(resultsEl, inputEl, results);
    });
  }

  function createWaypointRow(waypoint) {
    if (!hasOrderPane) return null;
    var row = document.createElement('div');
    row.className = 'chat-waypoint-item';
    row.innerHTML = ''
      + '<div class="chat-waypoint-address-col">'
      + '  <div class="addr-input-row">'
      + '    <input type="text" name="waypoints[]" data-waypoint-address="1" placeholder="경유지 주소">'
      + '    <button type="button" class="btn small secondary card-addr-search-btn" data-waypoint-search="1">🔍 검색</button>'
      + '  </div>'
      + '  <div class="addr-results"></div>'
      + '</div>'
      + '<input type="text" name="waypoint_contacts[]" placeholder="경유지 연락처 (선택)">'
      + '<input type="text" name="waypoint_vehicle_numbers[]" placeholder="경유지 차량번호 (선택)">'
      + '<input type="hidden" name="waypoint_details[]" value="">'
      + '<button type="button" class="btn small secondary chat-waypoint-remove">삭제</button>';

    var addrInput = row.querySelector('input[data-waypoint-address="1"]');
    var searchBtn = row.querySelector('[data-waypoint-search="1"]');
    var results = row.querySelector('.addr-results');
    var contactInput = row.querySelector('input[name="waypoint_contacts[]"]');
    var removeBtn = row.querySelector('.chat-waypoint-remove');

    if (waypoint && waypoint.address) addrInput.value = waypoint.address;
    if (waypoint && waypoint.contact) contactInput.value = waypoint.contact;

    searchBtn.addEventListener('click', function () {
      searchAddressFor(addrInput, results);
    });
    addrInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      searchBtn.click();
    });
    addrInput.addEventListener('input', function () {
      clearInputCoord(addrInput);
      refreshCardRouteEstimate();
    });
    contactInput.addEventListener('input', function () {
      normalizePhoneInput(contactInput);
    });
    removeBtn.addEventListener('click', function () {
      row.remove();
      refreshCardRouteEstimate();
    });

    return row;
  }

  function clearWaypoints() {
    if (!hasOrderPane) return;
    orderWaypointsWrap.innerHTML = '';
  }

  function setReservedTimeSelectors(timeValue) {
    if (!hasOrderPane) return;
    var raw = String(timeValue || '').trim();
    var match = raw.match(/^(\d{1,2}):(\d{2})/);
    if (!match) return;
    var hh = String(Number(match[1])).padStart(2, '0');
    var mm = match[2];
    if (orderReservedTimeHour.querySelector('option[value="' + hh + '"]')) orderReservedTimeHour.value = hh;
    if (orderReservedTimeMinute.querySelector('option[value="' + mm + '"]')) orderReservedTimeMinute.value = mm;
  }

  function setReservedDateSelectors(dateValue) {
    if (!hasOrderPane) return;
    var raw = String(dateValue || '').trim();
    var match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return;
    var yy = match[1];
    var mm = match[2];
    var dd = match[3];
    if (orderReservedDateYear.querySelector('option[value="' + yy + '"]')) orderReservedDateYear.value = yy;
    if (orderReservedDateMonth.querySelector('option[value="' + mm + '"]')) orderReservedDateMonth.value = mm;
    if (orderReservedDateDay.querySelector('option[value="' + dd + '"]')) orderReservedDateDay.value = dd;
  }

  function getLastDayOfMonth(year, month) {
    var y = Number(year);
    var m = Number(month);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return 31;
    return new Date(y, m, 0).getDate();
  }

  function normalizeReservedDateDay() {
    if (!hasOrderPane) return;
    var lastDay = getLastDayOfMonth(orderReservedDateYear.value, orderReservedDateMonth.value);
    var selectedDay = Number(orderReservedDateDay.value || 1);
    if (!Number.isFinite(selectedDay) || selectedDay < 1) selectedDay = 1;
    if (selectedDay > lastDay) orderReservedDateDay.value = pad2(lastDay);
  }

  function syncReservedDateField() {
    if (!hasOrderPane) return;
    normalizeReservedDateDay();
    orderReservedDate.value = orderReservedDateYear.value + '-' + orderReservedDateMonth.value + '-' + orderReservedDateDay.value;
  }

  function syncReservedTimeField() {
    if (!hasOrderPane) return;
    orderReservedTime.value = orderReservedTimeHour.value + ':' + orderReservedTimeMinute.value;
  }

  function buildCardDepartureTimeParam() {
    var dt = parseCardDisplayedDateTime();
    if (!dt || isNaN(dt.getTime())) return '';
    return dt.getFullYear() + pad2(dt.getMonth() + 1) + pad2(dt.getDate()) + pad2(dt.getHours()) + pad2(dt.getMinutes());
  }

  function resolveInputCoordIfNeeded(input) {
    if (!input || !String(input.value || '').trim()) return Promise.resolve();
    if (coordStringFromInput(input)) return Promise.resolve();
    return geocode(String(input.value || '').trim()).then(function (results) {
      if (results && results[0]) setInputCoord(input, results[0]);
    }).catch(function () { return null; });
  }

  function refreshCardRouteEstimate() {
    if (!hasOrderPane) return Promise.resolve();
    var waypointInputs = Array.prototype.slice.call(orderWaypointsWrap.querySelectorAll('input[data-waypoint-address="1"]')).filter(function (input) {
      return String(input.value || '').trim();
    });
    return Promise.all([resolveInputCoordIfNeeded(orderOriginAddress), resolveInputCoordIfNeeded(orderDestinationAddress)].concat(waypointInputs.map(resolveInputCoordIfNeeded)))
      .then(function () {
        var origin = coordStringFromInput(orderOriginAddress);
        var destination = coordStringFromInput(orderDestinationAddress);
        if (!origin || !destination) {
          cardRouteDurationSec = null;
          syncCardReservationPreview();
          return null;
        }
        var params = new URLSearchParams();
        params.set('origin', origin);
        params.set('destination', destination);
        params.set('priority', 'RECOMMEND');
        var waypointCoords = waypointInputs.length ? waypointInputs.map(coordStringFromInput).filter(Boolean) : [];
        // 강원/경남/경북/부산/울산 출발 + 제주 도착 건은 삼천포신항 경유로 경로탐색을 강제한다 —
        // order-form.js의 shouldForceSamcheonpoRoute()/SAMCHEONPO_PORT_LATLNG와 반드시 같이 맞춰야 한다.
        if (/(강원|경상남도|경남|경상북도|경북|부산|울산)/.test(orderOriginAddress.value || '') && /제주/.test(orderDestinationAddress.value || '')) {
          waypointCoords = ['128.088376812689,34.9269695307662'].concat(waypointCoords);
        }
        if (waypointCoords.length) params.set('waypoints', waypointCoords.join('|'));
        var departureTime = buildCardDepartureTimeParam();
        if (departureTime) params.set('departure_time', departureTime);
        return fetch('/kakao/directions?' + params.toString())
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (data) {
            cardRouteDurationSec = data && Number.isFinite(data.totalDuration) ? data.totalDuration : null;
            syncCardReservationPreview();
            return data;
          })
          .catch(function () {
            cardRouteDurationSec = null;
            syncCardReservationPreview();
            return null;
          });
      });
  }

  function fillOrderForm(payload) {
    if (!hasOrderPane) return;
    var order = (payload && payload.intakeOrder) ? payload.intakeOrder : {};
    orderSessionIdInput.value = String((payload && payload.sessionId) || selectedSessionId || '');
    orderReservedDate.value = order.reserved_date || orderReservedDate.value || '';
    setReservedDateSelectors(orderReservedDate.value);
    syncReservedDateField();
    orderReservedTime.value = order.reserved_time || orderReservedTime.value || '';
    setReservedTimeSelectors(orderReservedTime.value);
    syncReservedTimeField();
    orderOriginAddress.value = order.origin_address || '';
    clearInputCoord(orderOriginAddress);
    orderOriginDetailAddress.value = order.origin_detail_address || '';
    orderOriginContact.value = order.origin_contact || '';
    orderVehicleType.value = order.vehicle_type || '';
    orderVehicleNumber.value = order.vehicle_number || '';
    orderDestinationAddress.value = order.destination_address || '';
    clearInputCoord(orderDestinationAddress);
    orderDestinationDetailAddress.value = order.destination_detail_address || '';
    orderDestinationContact.value = order.destination_contact || '';
    orderBranchId.value = order.branch_id || '';
    orderRequesterGroupId.value = order.requester_group_id || '';
    orderPaymentMethodId.value = order.payment_method_id || '';
    orderFareAmount.value = order.fare_amount || '';
    orderMemoCustomer.value = order.memo_customer || '';
    orderTransition.value = 'agent_active';

    if (orderReservationBasisPickup && orderReservationBasisDelivery) {
      var isDelivery = order.reservation_basis === 'delivery';
      orderReservationBasisPickup.checked = !isDelivery;
      orderReservationBasisDelivery.checked = isDelivery;
      (isDelivery ? orderReservationBasisDelivery : orderReservationBasisPickup)
        .dispatchEvent(new Event('change', { bubbles: true }));
    }

    clearWaypoints();
    var waypoints = Array.isArray(order.waypoints) ? order.waypoints : [];
    waypoints.forEach(function (wp) {
      var row = createWaypointRow(wp);
      if (row) orderWaypointsWrap.appendChild(row);
    });
    refreshCardRouteEstimate();
  }

  function loadIntakeOrder(sessionId) {
    if (!hasOrderPane || !sessionId) return;
    orderSessionIdInput.value = String(sessionId);
    fetch('/chat/sessions/' + sessionId + '/intake-order')
      .then(function (res) {
        if (!res.ok) throw new Error('접수 초안 로딩 실패');
        return res.json();
      })
      .then(fillOrderForm)
      .catch(function () {
        fillOrderForm({ sessionId: sessionId, intakeOrder: {} });
      });
  }

  function renderHeadFromCard(card) {
    var feature = card.dataset.requestedFeature || '-';
    var user = card.dataset.userName || '-';
    var role = card.dataset.userRole || '-';
    var phone = card.dataset.userPhone || '';
    var statusBadge = card.dataset.statusBadge || 'gray';
    var statusLabel = card.dataset.statusLabel || card.dataset.sessionStatus || '-';
    var updatedAt = card.dataset.updatedAt || '-';
    var assignedName = card.dataset.assignedAgentName || '미지정';

    viewerHead.innerHTML = ''
      + '<h2>상담 #' + escapeHtml(card.dataset.sessionId) + ' · ' + escapeHtml(user) + '</h2>'
      + '<p class="page-sub">'
      + '<span class="badge ' + escapeHtml(statusBadge) + '">' + escapeHtml(statusLabel) + '</span>'
      + ' <span style="margin-left:8px;">' + escapeHtml(role + (phone ? (' · ' + phone) : '')) + '</span>'
      + ' <span style="margin-left:8px;">요청 기능: ' + escapeHtml(feature) + '</span>'
      + ' <span style="margin-left:8px;">담당자: ' + escapeHtml(assignedName) + '</span>'
      + ' <span style="margin-left:8px;">업데이트: ' + escapeHtml(updatedAt) + '</span>'
      + '</p>';
  }

  function setMessages(messages, options) {
    options = options || {};
    if (options.replace) messagesEl.innerHTML = '';
    if (!messages || !messages.length) {
      if (options.replace) messagesEl.innerHTML = '<div class="empty">아직 메시지가 없습니다.</div>';
      return;
    }

    var html = [];
    messages.forEach(function (m) {
      if (!rememberMessage(m)) return;
      html.push(messageBubbleHtml(m));
    });

    if (!html.length) return;
    if (options.prepend) messagesEl.insertAdjacentHTML('afterbegin', html.join(''));
    else messagesEl.insertAdjacentHTML('beforeend', html.join(''));

    if (!options.preserveScrollBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    oldestMessageId = Number(messagesEl.querySelector('.ai-chat-item') && messagesEl.querySelector('.ai-chat-item').dataset.id) || oldestMessageId;
  }

  function closeStream() {
    if (stream) {
      stream.close();
      stream = null;
    }
  }

  // 상대(고객 또는 다른 탭의 상담원)가 방금 읽었다는 신호 — 이미 그려진 말풍선의 배지를
  // 새로고침 없이 그 자리에서 미읽음->읽음으로 바꾼다.
  function markBubblesRead(bubbleClass) {
    var spans = messagesEl.querySelectorAll('.ai-chat-item.' + bubbleClass + ' .bubble-read.unread');
    spans.forEach(function (span) {
      span.textContent = '읽음';
      span.classList.remove('unread');
    });
  }

  function openStream(sessionId) {
    closeStream();
    if (!window.EventSource) return;
    stream = new EventSource('/chat/sessions/' + sessionId + '/stream');
    stream.onmessage = function (e) {
      try {
        var payload = JSON.parse(e.data);
        if (payload && payload.type === 'read_receipt') {
          markBubblesRead(payload.reader === 'agent' ? 'ai-user' : 'ai-agent');
          return;
        }
        if (!payload || !payload.id) return;
        if (!rememberMessage(payload)) return;
        messagesEl.insertAdjacentHTML('beforeend', messageBubbleHtml(payload));
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } catch (err) {
        // noop
      }
    };
  }

  function fetchMessages(sessionId, options) {
    options = options || {};
    var params = new URLSearchParams();
    params.set('limit', options.limit || 30);
    if (options.beforeId) params.set('beforeId', options.beforeId);
    var controller = window.AbortController ? new AbortController() : null;
    var timeoutId = setTimeout(function () {
      if (controller) controller.abort();
    }, 5000);
    var req = fetch('/chat/sessions/' + sessionId + '/messages?' + params.toString(), controller ? { signal: controller.signal } : undefined)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
    return req.finally(function () { clearTimeout(timeoutId); });
  }

  function updateLoadOlderButton() {
    loadOlderBtn.style.display = selectedSessionId ? '' : 'none';
    loadOlderBtn.disabled = !hasMoreOlder;
  }

  function loadSession(card) {
    var sessionId = card.dataset.sessionId;
    // 이미 선택된 세션을 다시 클릭하면(특히 첫 카드는 페이지 진입 시 자동 로드됨) 동일 세션에
    // 대한 메시지 fetch가 중복 실행된다. 두 응답이 겹치면 dedup 가드(knownMessageIds) 때문에
    // 두 번째 렌더링이 "이미 처리된 메시지"로 취급되어 대화창/대화 이력이 텅 비어버리는 버그가 있었다.
    if (sessionId && sessionId === selectedSessionId) return;
    selectedSessionStatus = card.dataset.sessionStatus || null;
    selectedAssignedAgentId = String(card.dataset.assignedAgentId || '');
    selectedAssignedAgentName = String(card.dataset.assignedAgentName || '');
    selectedSessionId = sessionId;
    setSelectedCard(sessionId);
    renderHeadFromCard(card);
    resetViewerMeta();
    messagesEl.innerHTML = '<div class="empty">대화를 불러오는 중...</div>';
    viewerActions.style.display = '';
    openDetailLink.href = '/chat/sessions/' + sessionId;
    deleteForm.action = '/chat/sessions/' + sessionId + '/delete';
    loadIntakeOrder(sessionId);

    fetchMessages(sessionId, { limit: 30 }).then(function (data) {
      if (selectedSessionId !== sessionId) return;
      messagesEl.innerHTML = '';
      setMessages(data.messages || [], { replace: true });
      if (data && data.status) selectedSessionStatus = data.status;
      hasMoreOlder = !!data.hasMore;
      updateLoadOlderButton();
      renderHeadFromCard(card);
      updateReplyAvailability();
      openStream(sessionId);
    }).catch(function () {
      if (selectedSessionId !== sessionId) return;
      messagesEl.innerHTML = '<div class="empty">메시지 로딩이 지연되거나 실패했습니다. 카드를 다시 클릭해 재시도해주세요.</div>';
      hasMoreOlder = false;
      viewerActions.style.display = 'none';
      updateLoadOlderButton();
      updateReplyAvailability();
    });
  }

  function sendAgentReply() {
    if (!selectedSessionId || isSendingReply) return;
    var text = replyText.value.trim();
    if (!text) {
      updateReplyAvailability();
      return;
    }

    isSendingReply = true;
    setReplyError('');
    updateReplyAvailability();

    fetch('/chat/sessions/' + selectedSessionId + '/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ text: text }),
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return { error: '메시지 전송에 실패했습니다. 잠시 후 다시 시도해주세요.' }; }).then(function (err) {
            var e = new Error(err.error || '메시지 전송에 실패했습니다. 잠시 후 다시 시도해주세요.');
            e.code = res.status;
            throw e;
          });
        }
        return res.json();
      })
      .then(function (data) {
        selectedSessionStatus = (data && data.status) || 'agent_active';
        selectedAssignedAgentId = currentUserId;
        selectedAssignedAgentName = currentUserName;
        var card = selectedCardButton();
        applyAssignedAgentToCard(card, selectedAssignedAgentId, selectedAssignedAgentName);
        if (card) renderHeadFromCard(card);
        replyText.value = '';
      })
      .catch(function (err) {
        setReplyError((err && err.message) || '메시지 전송에 실패했습니다. 잠시 후 다시 시도해주세요.');
      })
      .finally(function () {
        isSendingReply = false;
        updateReplyAvailability();
      });
  }

  function assignSelf() {
    if (!selectedSessionId || isAssigningSelf) return;
    isAssigningSelf = true;
    setReplyError('');
    updateReplyAvailability();

    fetch('/chat/sessions/' + selectedSessionId + '/assign-self', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return { error: '담당자 지정에 실패했습니다.' }; }).then(function (err) {
            var e = new Error(err.error || '담당자 지정에 실패했습니다.');
            throw e;
          });
        }
        return res.json();
      })
      .then(function (data) {
        selectedAssignedAgentId = String((data && data.assignedAgentId) || currentUserId);
        selectedAssignedAgentName = (data && data.assignedAgentName) || currentUserName;
        var card = selectedCardButton();
        applyAssignedAgentToCard(card, selectedAssignedAgentId, selectedAssignedAgentName);
        if (card) renderHeadFromCard(card);
      })
      .catch(function (err) {
        setReplyError((err && err.message) || '담당자 지정에 실패했습니다. 잠시 후 다시 시도해주세요.');
      })
      .finally(function () {
        isAssigningSelf = false;
        updateReplyAvailability();
      });
  }

  loadOlderBtn.addEventListener('click', function () {
    if (!selectedSessionId || !hasMoreOlder || !oldestMessageId) return;
    loadOlderBtn.disabled = true;
    fetchMessages(selectedSessionId, { limit: 30, beforeId: oldestMessageId }).then(function (data) {
      if (!data.messages || !data.messages.length) {
        hasMoreOlder = false;
        updateLoadOlderButton();
        return;
      }
      setMessages(data.messages, { prepend: true, preserveScrollBottom: true });
      hasMoreOlder = !!data.hasMore;
      updateLoadOlderButton();
    }).catch(function () {
      loadOlderBtn.disabled = false;
    });
  });

  cardButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      loadSession(btn);
    });
  });

  if (hasOrderPane) {
    orderAddressSearchButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var targetId = btn.getAttribute('data-target');
        if (targetId) {
          var input = document.getElementById(targetId);
          var results = document.getElementById(targetId + '_results');
          searchAddressFor(input, results);
          return;
        }
        if (btn.getAttribute('data-waypoint-search') === '1') {
          var row = btn.closest('.chat-waypoint-item');
          if (!row) return;
          var wpInput = row.querySelector('input[data-waypoint-address="1"]');
          var wpResults = row.querySelector('.addr-results');
          searchAddressFor(wpInput, wpResults);
        }
      });
    });

    [orderOriginAddress, orderDestinationAddress].forEach(function (input) {
      input.addEventListener('input', function () {
        clearInputCoord(input);
        refreshCardRouteEstimate();
      });
      input.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var targetId = input.id;
        var results = document.getElementById(targetId + '_results');
        searchAddressFor(input, results);
      });
    });

    [orderOriginContact, orderDestinationContact].forEach(function (input) {
      input.addEventListener('input', function () { normalizePhoneInput(input); });
    });

    [orderReservedTimeHour, orderReservedTimeMinute].forEach(function (select) {
      select.addEventListener('change', function () {
        syncReservedTimeField();
        refreshCardRouteEstimate();
      });
    });
    [orderReservedDateYear, orderReservedDateMonth, orderReservedDateDay].forEach(function (select) {
      select.addEventListener('change', function () {
        syncReservedDateField();
        refreshCardRouteEstimate();
      });
    });
    if (orderReservedDate) {
      orderReservedDate.addEventListener('change', refreshCardRouteEstimate);
    }
    if (orderReservationBasisPickup) orderReservationBasisPickup.addEventListener('change', syncCardReservationPreview);
    if (orderReservationBasisDelivery) orderReservationBasisDelivery.addEventListener('change', syncCardReservationPreview);
    setReservedDateSelectors(orderReservedDate.value);
    syncReservedDateField();
    setReservedTimeSelectors(orderReservedTime.value);
    syncReservedTimeField();
    syncCardReservationPreview();

    addOrderWaypointBtn.addEventListener('click', function () {
      var row = createWaypointRow();
      if (row) orderWaypointsWrap.appendChild(row);
      refreshCardRouteEstimate();
    });

    orderForm.addEventListener('submit', function (e) {
      if (!selectedSessionId) {
        e.preventDefault();
        alert('먼저 왼쪽에서 상담 세션을 선택해주세요.');
        return;
      }
      syncReservedDateField();
      syncCardReservationPreview();
      if (isDeliveryBasis() && (!orderPickupReservedDate.value || !orderPickupReservedTime.value)) {
        e.preventDefault();
        alert('도착지 인도시간 기준은 경로가 확정되어야 출발지 픽업일시를 계산할 수 있습니다. 주소를 확인한 뒤 다시 시도해주세요.');
        return;
      }
      orderSessionIdInput.value = String(selectedSessionId);
    });
  }

  if (cardButtons.length) loadSession(cardButtons[0]);
  else {
    if (hasOrderPane) orderSessionIdInput.value = '';
    updateReplyAvailability();
  }

  replyText.addEventListener('input', function () {
    if (replyError.style.display !== 'none') setReplyError('');
    updateReplyAvailability();
  });
  replyText.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAgentReply();
    }
  });
  replyForm.addEventListener('submit', function (e) {
    e.preventDefault();
    sendAgentReply();
  });
  assignSelfBtn.addEventListener('click', assignSelf);

  {
    var refreshBtn = null;

    function showRefreshButton() {
      if (refreshBtn) return;
      refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.className = 'btn';
      refreshBtn.textContent = '새 상담 업데이트 보기';
      refreshBtn.style.position = 'fixed';
      refreshBtn.style.right = '20px';
      refreshBtn.style.bottom = '20px';
      refreshBtn.style.zIndex = '1000';
      refreshBtn.addEventListener('click', function () { location.reload(); });
      document.body.appendChild(refreshBtn);
    }

    // 별도 SSE 연결을 새로 열지 않고, 헤더에서 이미 상시 유지 중인 agent-presence 연결이
    // 상담 목록이 바뀔 때마다 쏘아주는 이벤트를 그대로 재사용한다(연결 수를 늘리지 않기 위함 —
    // 카드뷰는 이미 선택된 세션의 메시지 스트림 연결을 별도로 하나 더 열고 있어서, 여기서까지
    // 중복 연결을 열면 로컬 개발환경의 브라우저 호스트당 동시연결 제한에 더 쉽게 걸렸다).
    window.addEventListener('agent-needs-count', function (e) {
      if (e.detail && e.detail.initial) return;
      showRefreshButton();
    });
  }

  window.addEventListener('beforeunload', closeStream);
})();
