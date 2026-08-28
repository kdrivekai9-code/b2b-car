// 오더 등록 화면 보조 스크립트
// - 연락처 자동 복사/자동 하이픈 포맷팅 + 유효성 검사
// - 다중 경유지 동적 추가/삭제
// - 등록주소(즐겨찾기) 팝업: 선택/추가/수정/삭제
// - 주소·상호명 검색(카카오 로컬 API, 서버 프록시 경유) + 상세주소 입력 + 지도 미리보기
(function () {
  var form = document.getElementById('orderForm');
  var myPhone = form ? form.dataset.myPhone : '';
  var DELIVERY_BUFFER_SECONDS = 30 * 60;

  // ---------- 예약 시간 시/분 드롭다운(10분 단위) → 실제 제출 필드(reserved_time) 동기화 ----------
  // 이 페이지에 해당 드롭다운이 없으면(예: 다른 화면) 조용히 건너뛴다.
  (function wireReservedTimeSelects() {
    var hourSelect = document.getElementById('reserved_time_hour');
    var minuteSelect = document.getElementById('reserved_time_minute');
    var hiddenInput = document.getElementById('reserved_time');
    if (!hourSelect || !minuteSelect || !hiddenInput) return;
    function sync() {
      hiddenInput.value = hourSelect.value + ':' + minuteSelect.value;
    }
    hourSelect.addEventListener('change', sync);
    minuteSelect.addEventListener('change', sync);
    sync();
  })();

  // ---------- 예약 날짜 연/월/일 드롭다운 → 실제 제출 필드(reserved_date) 동기화 ----------
  var reservedDateYearSelect = document.getElementById('reserved_date_year');
  var reservedDateMonthSelect = document.getElementById('reserved_date_month');
  var reservedDateDaySelect = document.getElementById('reserved_date_day');
  var reservedDateHiddenInput = document.getElementById('reserved_date');

  function getLastDayOfMonth(year, month) {
    var y = Number(year);
    var m = Number(month);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return 31;
    return new Date(y, m, 0).getDate();
  }

  function normalizeReservedDateDay() {
    if (!reservedDateYearSelect || !reservedDateMonthSelect || !reservedDateDaySelect) return;
    var lastDay = getLastDayOfMonth(reservedDateYearSelect.value, reservedDateMonthSelect.value);
    var selectedDay = Number(reservedDateDaySelect.value || 1);
    if (!Number.isFinite(selectedDay) || selectedDay < 1) selectedDay = 1;
    if (selectedDay > lastDay) reservedDateDaySelect.value = pad2(lastDay);
  }

  function syncReservedDateField() {
    if (!reservedDateYearSelect || !reservedDateMonthSelect || !reservedDateDaySelect || !reservedDateHiddenInput) return;
    reservedDateHiddenInput.value = String(reservedDateYearSelect.value || '').trim()
      + '-' + String(reservedDateMonthSelect.value || '').trim()
      + '-' + String(reservedDateDaySelect.value || '').trim();
  }

  (function wireReservedDateSelects() {
    if (!reservedDateYearSelect || !reservedDateMonthSelect || !reservedDateDaySelect || !reservedDateHiddenInput) return;
    reservedDateYearSelect.addEventListener('change', function () {
      normalizeReservedDateDay();
      syncReservedDateField();
    });
    reservedDateMonthSelect.addEventListener('change', function () {
      normalizeReservedDateDay();
      syncReservedDateField();
    });
    reservedDateDaySelect.addEventListener('change', syncReservedDateField);
    normalizeReservedDateDay();
    syncReservedDateField();
  })();

  var reservationBasisImmediate = document.getElementById('reservation_basis_immediate');
  var reservationBasisPickup = document.getElementById('reservation_basis_pickup');
  var reservationBasisDelivery = document.getElementById('reservation_basis_delivery');
  var pickupReservedDateInput = document.getElementById('pickup_reserved_date');
  var pickupReservedTimeInput = document.getElementById('pickup_reserved_time');
  var reservationDateTimeLabel = document.getElementById('reservationDateTimeLabel');
  var pickupPreviewBlock = document.getElementById('pickupPreviewBlock');
  var pickupPreviewValue = document.getElementById('pickupPreviewValue');
  var deliveryRouteFormulaPreview = document.getElementById('deliveryRouteFormulaPreview');
  var routeDurationFormulaHeader = document.getElementById('routeDurationFormulaHeader');
  var memoCustomerInput = form ? form.querySelector('textarea[name="memo_customer"]') : null;
  var currentRouteDurationSec = null;
  var DELIVERY_RESERVATION_MEMO_PREFIX = '일시:';

  function isDeliveryReservationBasis() {
    return !!(reservationBasisDelivery && reservationBasisDelivery.checked);
  }

  function isImmediateReservationBasis() {
    return !!(reservationBasisImmediate && reservationBasisImmediate.checked);
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function parseDateTimeValue(dateValue, timeValue) {
    var d = String(dateValue || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    var t = String(timeValue || '').trim().match(/^(\d{2}):(\d{2})$/);
    if (!d || !t) return null;
    return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), 0, 0);
  }

  function parseVisibleReservedDateTime() {
    var dateInput = document.querySelector('input[name="reserved_date"]');
    var timeInput = document.getElementById('reserved_time');
    return parseDateTimeValue(dateInput && dateInput.value, timeInput && timeInput.value);
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
    return pad2(dt.getMonth() + 1) + '/' + pad2(dt.getDate()) + ' ' + pad2(dt.getHours()) + '시' + pad2(dt.getMinutes()) + '분 도착요망';
  }

  function syncDeliveryReservationMemo() {
    if (!memoCustomerInput) return;
    var hasMemo = String(memoCustomerInput.value || '').trim().length > 0;
    var rawLines = hasMemo ? String(memoCustomerInput.value).split(/\r?\n/) : [];
    var keptLines = rawLines.filter(function (line) {
      return String(line || '').trim().indexOf(DELIVERY_RESERVATION_MEMO_PREFIX) !== 0;
    });

    if (isDeliveryReservationBasis()) {
      var deliveryDateTime = parseVisibleReservedDateTime();
      var memoDateTime = formatDeliveryReservationMemoDateTime(deliveryDateTime);
      if (memoDateTime) keptLines.push(DELIVERY_RESERVATION_MEMO_PREFIX + ' ' + memoDateTime);
    }

    memoCustomerInput.value = keptLines.join('\n').replace(/^\n+|\n+$/g, '');
  }

  function setPickupHiddenFields(dt) {
    if (!pickupReservedDateInput || !pickupReservedTimeInput) return;
    if (!dt || isNaN(dt.getTime())) {
      pickupReservedDateInput.value = '';
      pickupReservedTimeInput.value = '';
      return;
    }
    pickupReservedDateInput.value = dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
    pickupReservedTimeInput.value = pad2(dt.getHours()) + ':' + pad2(dt.getMinutes());
  }

  function setRouteFormulaText(text) {
    if (deliveryRouteFormulaPreview) deliveryRouteFormulaPreview.textContent = text;
    if (routeDurationFormulaHeader) routeDurationFormulaHeader.textContent = text ? ('· ' + text) : '';
  }

  // 예약 날짜/시간 드롭다운(연/월/일/시/분)과 숨은 필드를 주어진 시각으로 맞춘다.
  function applyDateTimeToReservedDateTimeSelects(dt) {
    if (reservedDateYearSelect) reservedDateYearSelect.value = String(dt.getFullYear());
    if (reservedDateMonthSelect) reservedDateMonthSelect.value = pad2(dt.getMonth() + 1);
    if (reservedDateDaySelect) reservedDateDaySelect.value = pad2(dt.getDate());
    var hourSelect = document.getElementById('reserved_time_hour');
    var minuteSelect = document.getElementById('reserved_time_minute');
    if (hourSelect) hourSelect.value = pad2(dt.getHours());
    if (minuteSelect) minuteSelect.value = pad2(dt.getMinutes());
    syncReservedDateField();
    var timeHidden = document.getElementById('reserved_time');
    if (timeHidden && hourSelect && minuteSelect) timeHidden.value = hourSelect.value + ':' + minuteSelect.value;
  }

  // "즉시" 기준 선택 시 예약 날짜/시간 드롭다운을 현재 시각(10분 단위 반올림)으로 맞추고
  // 편집을 막는다 — 실제 제출 시각까지 최대한 가깝게 유지하려고 제출 직전(submit 핸들러)에도
  // 다시 호출된다.
  function applyNowToReservedDateTimeSelects() {
    var now = roundDateToNearestTenMinutes(new Date());
    applyDateTimeToReservedDateTimeSelects(now);
    return now;
  }

  function setReservedDateTimeSelectsDisabled(disabled) {
    [reservedDateYearSelect, reservedDateMonthSelect, reservedDateDaySelect,
      document.getElementById('reserved_time_hour'), document.getElementById('reserved_time_minute')]
      .forEach(function (el) { if (el) el.disabled = disabled; });
  }

  // 직전 호출 때의 기준 — "방금 도착지 인도시간 기준에서 벗어났다"를 판단하는 데만 쓴다.
  var previousReservationBasis = null;

  function syncReservationBasisPreview() {
    var immediateBasis = isImmediateReservationBasis();
    var deliveryBasis = !immediateBasis && isDeliveryReservationBasis();
    var currentBasis = immediateBasis ? 'immediate' : (deliveryBasis ? 'delivery' : 'pickup');
    var justLeftDeliveryForPickup = previousReservationBasis === 'delivery' && currentBasis === 'pickup';
    previousReservationBasis = currentBasis;

    setReservedDateTimeSelectsDisabled(immediateBasis);
    if (immediateBasis) {
      var nowDt = applyNowToReservedDateTimeSelects();
      if (pickupPreviewBlock) pickupPreviewBlock.style.display = 'none';
      setPickupHiddenFields(nowDt);
      setRouteFormulaText('');
      syncDeliveryReservationMemo();
      return;
    }

    if (!deliveryBasis) {
      // 도착지 인도시간 기준에서 막 픽업시간 기준으로 바꾼 경우, 화면에 남아있는 시각은
      // 고객이 말한 "인도 요청 시각"이지 픽업 시각이 아니다 — 그대로 두면 인도 시각을
      // 픽업 시각으로 오인해 등록하게 된다(실사용 지적). 직전에 계산해둔 픽업 시각(아직
      // 안 지워짐 — 아래 setPickupHiddenFields가 이번 호출에서 덮어쓰기 전)이 있으면
      // 화면에 그대로 반영해준다.
      if (justLeftDeliveryForPickup && pickupReservedDateInput && pickupReservedTimeInput) {
        var convertedDt = parseDateTimeValue(pickupReservedDateInput.value, pickupReservedTimeInput.value);
        if (convertedDt) applyDateTimeToReservedDateTimeSelects(convertedDt);
      }
      if (pickupPreviewBlock) pickupPreviewBlock.style.display = 'none';
      setPickupHiddenFields(parseVisibleReservedDateTime());
      setRouteFormulaText('');
      syncDeliveryReservationMemo();
      return;
    }

    if (pickupPreviewBlock) pickupPreviewBlock.style.display = '';
    var deliveryDateTime = parseVisibleReservedDateTime();
    if (!deliveryDateTime || !Number.isFinite(currentRouteDurationSec) || currentRouteDurationSec <= 0) {
      setPickupHiddenFields(null);
      if (pickupPreviewValue) pickupPreviewValue.textContent = '경로 확정 후 자동 계산';
      setRouteFormulaText('(경로탐색 : 경로 확정 후 자동 계산)');
      syncDeliveryReservationMemo();
      return;
    }

    var pickupDateTime = new Date(deliveryDateTime.getTime() - ((currentRouteDurationSec + DELIVERY_BUFFER_SECONDS) * 1000));
    pickupDateTime = roundDateToNearestTenMinutes(pickupDateTime);
    setPickupHiddenFields(pickupDateTime);
    if (pickupPreviewValue) pickupPreviewValue.textContent = formatLocalDateTime(pickupDateTime);
    setRouteFormulaText('(경로탐색 : ' + formatDuration(currentRouteDurationSec) + ' +30분여유)');
    syncDeliveryReservationMemo();
    // AI 챗봇 화면(ai-intake.js)이 "경로 확정 후 계산됩니다"로 마무리한 확인 메시지의 후속
    // 안내를 여기서 트리거한다 — 이 페이지가 아니면(오더 등록/상담관리 화면) 정의돼 있지 않다.
    if (window.__aiIntakeOnPickupTimeResolved) window.__aiIntakeOnPickupTimeResolved();
  }

  // ---------- 연락처 자동 하이픈 포맷팅 + 유효성 검사 ----------
  function formatPhoneDigits(digits) {
    if (digits.length === 8) return digits.slice(0, 4) + '-' + digits.slice(4);
    if (digits.indexOf('02') === 0) {
      if (digits.length <= 2) return digits;
      if (digits.length <= 5) return digits.slice(0, 2) + '-' + digits.slice(2);
      if (digits.length <= 9) return digits.slice(0, 2) + '-' + digits.slice(2, 5) + '-' + digits.slice(5);
      return digits.slice(0, 2) + '-' + digits.slice(2, 6) + '-' + digits.slice(6, 10);
    }
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return digits.slice(0, 3) + '-' + digits.slice(3);
    if (digits.length <= 10) return digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6);
    return digits.slice(0, 3) + '-' + digits.slice(3, 7) + '-' + digits.slice(7, 11);
  }
  function isValidPhone(formatted) {
    if (!formatted) return true;
    // 010/011/016/017/018/019(휴대폰)는 가운데 자리가 반드시 4자리여야 함 — 3자리는 지역번호 유선전화 형식이라 섞이면 안 됨.
    if (/^01[016789]-/.test(formatted)) return /^01[016789]-\d{4}-\d{4}$/.test(formatted);
    return /^(0\d{1,2}-\d{3,4}-\d{4}|\d{4}-\d{4})$/.test(formatted);
  }
  function wirePhoneInput(input) {
    input.addEventListener('input', function () {
      var digits = input.value.replace(/\D/g, '').slice(0, 11);
      input.value = formatPhoneDigits(digits);
    });
    input.addEventListener('blur', function () {
      if (input.value && !isValidPhone(input.value)) {
        alert('올바른 연락처 형식이 아닙니다. 다시 확인해주세요.\n예: 010-1234-5678');
      }
    });
  }
  document.querySelectorAll('.phone-input').forEach(wirePhoneInput);

  // ---------- 연락처 자동 복사 ----------
  var originContact = document.getElementById('origin_contact');
  var destContact = document.getElementById('destination_contact');
  var sameAsMyPhone = document.getElementById('sameAsMyPhone');
  var sameAsOriginContact = document.getElementById('sameAsOriginContact');

  if (sameAsMyPhone) {
    sameAsMyPhone.addEventListener('change', function () {
      if (sameAsMyPhone.checked) { originContact.value = myPhone; originContact.readOnly = true; }
      else { originContact.readOnly = false; }
    });
  }
  if (sameAsOriginContact) {
    sameAsOriginContact.addEventListener('change', syncDestContact);
    originContact.addEventListener('input', syncDestContact);
  }
  function syncDestContact() {
    if (sameAsOriginContact.checked) { destContact.value = originContact.value; destContact.readOnly = true; }
    else { destContact.readOnly = false; }
  }

  // ---------- 경유지 동적 추가/삭제 ----------
  var waypointsWrap = document.getElementById('waypointsWrap');
  var addWaypointBtn = document.getElementById('addWaypointBtn');
  var waypointSeq = 0;

  function addWaypointRow() {
    waypointSeq += 1;
    var id = 'waypoint_' + waypointSeq;
    var row = document.createElement('div');
    row.className = 'field full waypoint-row';
    var extendedFields = window.__waypointExtended
      ? '<div class="row" style="margin-top:8px;">' +
        '<div class="field"><label>경유지 연락처</label><input type="text" class="phone-input" id="' + id + '_contact" name="waypoint_contacts[]" placeholder="010-0000-0000"></div>' +
        '<div class="field"><label>경유지 차량번호 (선택)</label><input type="text" id="' + id + '_vehicle_number" name="waypoint_vehicle_numbers[]" placeholder="예: 12가3456"></div>' +
        '</div>'
      : '';
    // 이 경유지에서 "다른 날" 다시 출발하는 경우에만 채운다. 값이 있고 출발일과 다르면 서버가
    // 오더를 구간별로 나눠 접수한다(lib/orderSplit.js) — 같은 날 이어서 도는 평범한 경유는
    // 비워두면 지금처럼 한 건으로 등록된다. 두 화면(오더등록·AI 챗봇) 모두 필요해서 확장
    // 필드와 달리 항상 보여준다.
    var scheduleFields =
      '<div class="row waypoint-schedule" style="margin-top:8px;">' +
      '<div class="field"><label>경유지 출발일 (다른 날일 때만)</label>' +
      '<input type="date" id="' + id + '_reserved_date" name="waypoint_reserved_dates[]"></div>' +
      '<div class="field"><label>경유지 출발시각</label>' +
      '<input type="time" id="' + id + '_reserved_time" name="waypoint_reserved_times[]" step="600"></div>' +
      '</div>';
    // 지도보기를 어떻게 배치할지는 화면마다 다르다 — #destLegendRow(경로 미리보기의 출발/도착
    // 목록)가 있는 화면(예: 오더 등록)은 기존처럼 그 목록에 경유 행을 추가하고, 없는 화면(AI
    // 챗봇 — 목록을 없애고 각 입력칸 옆에 지도보기 버튼을 바로 붙이기로 바꿨다)은 주소 입력줄에
    // 인라인 버튼을 넣는다.
    var destLegendRow = document.getElementById('destLegendRow');
    var hasLegend = !!destLegendRow;
    row.innerHTML =
      '<label>경유지 주소 <span class="confirm-badge" id="' + id + 'ConfirmBadge">✓ 지도확정</span>' +
      '<span class="confirm-badge" id="' + id + 'CoordBadge">✓ 좌표</span></label>' +
      '<input type="hidden" id="' + id + '_lat" name="waypoint_lats[]">' +
      '<input type="hidden" id="' + id + '_lon" name="waypoint_lons[]">' +
      '<div class="addr-input-row">' +
      '<input type="text" class="addr-input" id="' + id + '_address" name="waypoints[]" placeholder="경유지 주소">' +
      '<button type="button" class="btn small secondary addr-search-btn" data-target="' + id + '_address">🔍 검색</button>' +
      (hasLegend ? '' : '<button type="button" class="btn small secondary map-view-btn" data-slot="' + id + '" title="지도보기">지도보기</button>') +
      '<button type="button" class="btn small secondary remove-waypoint-btn">삭제</button>' +
      '</div>' +
      '<div id="' + id + '_address_results" class="addr-results"></div>' +
      '<input type="text" class="addr-detail-input" id="' + id + '_detail_address" name="waypoint_details[]" placeholder="상세주소 입력 (건물명, 동/호수)" disabled>' +
      extendedFields + scheduleFields;
    row.dataset.slot = id;
    waypointsWrap.appendChild(row);
    row.querySelectorAll('.phone-input').forEach(wirePhoneInput);

    var legendRow = null;
    if (hasLegend) {
      legendRow = document.createElement('div');
      legendRow.className = 'map-legend-row';
      legendRow.dataset.slot = id;
      legendRow.innerHTML =
        '<span class="dot waypoint"></span><b>경유</b>' +
        '<span id="' + id + 'Preview" class="map-legend-addr">주소를 입력하세요</span>' +
        '<button type="button" class="btn small secondary map-view-btn" data-slot="' + id + '">지도보기</button>';
      destLegendRow.parentNode.insertBefore(legendRow, destLegendRow);
      wireMapViewBtn(legendRow.querySelector('.map-view-btn'));
    } else {
      var inlineMapBtn = row.querySelector('.map-view-btn');
      if (inlineMapBtn) wireMapViewBtn(inlineMapBtn);
    }

    var input = row.querySelector('input.addr-input');
    row.querySelector('.remove-waypoint-btn').addEventListener('click', function () {
      removeMarker(id);
      row.remove();
      if (legendRow) legendRow.remove();
    });
    wireAddressField(id, 'waypoint');
  }
  if (addWaypointBtn) addWaypointBtn.addEventListener('click', addWaypointRow);

  // 운영시간 검증 실패 등으로 폼이 재렌더링된 경우 입력했던 경유지를 복원
  if (window.__prefillWaypoints && window.__prefillWaypoints.length) {
    window.__prefillWaypoints.forEach(function (addr) {
      addWaypointRow();
      var rows = waypointsWrap.querySelectorAll('.waypoint-row input.addr-input');
      rows[rows.length - 1].value = addr;
    });
  }

  // ---------- 지사 선택 시 결제수단 목록 동적 갱신(관리자) ----------
  var branchSelect = document.getElementById('branch_id');
  var paymentSelect = document.getElementById('payment_method_id');
  var lastRouteKm = null;
  if (branchSelect && paymentSelect) {
    branchSelect.addEventListener('change', function () {
      if (!branchSelect.value) return;
      fetch('/branches/' + branchSelect.value + '/payment-methods.json')
        .then(function (res) { return res.json(); })
        .then(function (methods) {
          var current = paymentSelect.value;
          paymentSelect.innerHTML = '<option value="">선택 안 함</option>';
          methods.forEach(function (m) {
            var opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.name;
            if (String(m.id) === current || (!current && m.is_default)) opt.selected = true;
            paymentSelect.appendChild(opt);
          });
        })
        .catch(function () {});
      updateFarePreview(lastRouteKm);
    });
  }

  // ---------- 등록주소(즐겨찾기) 팝업 ----------
  var regAddrTarget = null;
  // AI 챗봇이 열었을 때만 채워짐 — 채팅 입력창 옆 즐겨찾기 버튼으로 열면, 고른 항목을 폼 입력에
  // 조용히 채우는 대신 이 콜백으로 넘겨서 챗봇 쪽이 직접 입력한 것처럼(확인 말풍선 + 다음 질문
  // 진행까지) 처리하게 한다. 일반 오더 등록 화면(폼 필드의 "등록주소" 버튼)에서는 계속 비워둔다.
  var regAddrSelectCallback = null;
  var regAddrModal = document.getElementById('registeredAddrModal');
  var regAddrList = document.getElementById('registeredAddrList');
  var regAddrManage = document.getElementById('registeredAddrManage');
  var regAddrManageList = document.getElementById('registeredAddrManageList');

  function detailIdFor(mainId) { return mainId.replace('_address', '_detail_address'); }

  function useAddress(f) {
    closeRegAddrModal();
    if (regAddrSelectCallback) {
      var cb = regAddrSelectCallback;
      regAddrSelectCallback = null;
      cb(f);
      return;
    }
    var mainInput = document.getElementById(regAddrTarget);
    var detailInput = document.getElementById(detailIdFor(regAddrTarget));
    mainInput.value = f.address;
    if (detailInput) { detailInput.disabled = false; detailInput.style.display = ''; }
    mainInput.dispatchEvent(new Event('blur'));
  }

  function renderRegAddrList() {
    var favorites = window.__favorites || [];
    regAddrList.innerHTML = favorites.length ? '' : '<p class="page-sub">등록된 주소가 없습니다.</p>';
    favorites.forEach(function (f) {
      var item = document.createElement('div');
      item.className = 'registered-address-item';
      var main = document.createElement('div');
      main.className = 'addr-main';
      main.innerHTML = '<b></b><span></span>';
      main.querySelector('b').textContent = f.label;
      main.querySelector('span').textContent = f.address;
      main.addEventListener('click', function () { useAddress(f); });
      item.appendChild(main);
      regAddrList.appendChild(item);
    });
    renderRegAddrManageList();
  }

  function renderRegAddrManageList() {
    var favorites = window.__favorites || [];
    regAddrManageList.innerHTML = '';
    favorites.forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'registered-address-item';
      row.innerHTML = '<div class="addr-main"><b></b><span></span></div><div class="addr-actions"><button type="button" data-act="edit">수정</button><button type="button" data-act="delete">삭제</button></div>';
      row.querySelector('b').textContent = f.label;
      row.querySelector('span').textContent = f.address;
      row.querySelector('[data-act=edit]').addEventListener('click', function () {
        var newLabel = prompt('이름', f.label);
        if (newLabel === null) return;
        var newAddress = prompt('주소', f.address);
        if (newAddress === null) return;
        fetch('/favorites/' + f.id, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: newLabel, address: newAddress }),
        }).then(refreshFavorites);
      });
      row.querySelector('[data-act=delete]').addEventListener('click', function () {
        if (!confirm('삭제하시겠습니까?')) return;
        fetch('/favorites/' + f.id + '/delete', { method: 'POST' }).then(refreshFavorites);
      });
      regAddrManageList.appendChild(row);
    });
  }

  function refreshFavorites() {
    return fetch('/favorites').then(function (res) { return res.json(); }).then(function (data) {
      window.__favorites = data.favorites || [];
      renderRegAddrList();
    });
  }

  // onSelect를 넘기면(챗봇 즐겨찾기 버튼 전용) 고른 항목을 폼에 채우는 대신 그 콜백으로 넘긴다.
  function openRegAddrModal(targetId, onSelect) {
    regAddrTarget = targetId;
    regAddrSelectCallback = onSelect || null;
    regAddrModal.style.display = 'flex';
    renderRegAddrList();
  }
  function closeRegAddrModal() { regAddrModal.style.display = 'none'; }

  document.querySelectorAll('.registered-addr-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { openRegAddrModal(btn.dataset.target); });
  });
  // AI 챗봇 화면에서 채팅 입력창 옆 즐겨찾기 버튼이 이 함수를 호출한다.
  window.__aiIntakeOpenFavoriteModal = openRegAddrModal;
  var regAddrCloseBtn = document.getElementById('registeredAddrClose');
  if (regAddrCloseBtn) regAddrCloseBtn.addEventListener('click', closeRegAddrModal);
  var regAddrManageToggle = document.getElementById('registeredAddrManageToggle');
  if (regAddrManageToggle) {
    regAddrManageToggle.addEventListener('click', function () {
      var opening = regAddrManage.style.display === 'none';
      regAddrManage.style.display = opening ? '' : 'none';
      if (opening) {
        var mainInput = document.getElementById(regAddrTarget);
        var addrField = document.getElementById('regAddrNewAddress');
        if (mainInput && mainInput.value && !addrField.value) addrField.value = mainInput.value;
      }
    });
  }
  var regAddrAddBtn = document.getElementById('regAddrAddBtn');
  if (regAddrAddBtn) {
    regAddrAddBtn.addEventListener('click', function () {
      var label = document.getElementById('regAddrNewLabel').value.trim();
      var address = document.getElementById('regAddrNewAddress').value.trim();
      if (!label || !address) { alert('이름과 주소를 입력하세요.'); return; }
      fetch('/favorites', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label, address: address }),
      }).then(function () {
        document.getElementById('regAddrNewLabel').value = '';
        document.getElementById('regAddrNewAddress').value = '';
        return refreshFavorites();
      });
    });
  }

  // ---------- 주소 검색 공통 헬퍼 (지도 유무와 무관하게 항상 사용 가능해야 함) ----------
  var MIN_ADDRESS_QUERY_LENGTH = 3;
  var ADDRESS_RESULT_LIMIT = 3;

  // meta에는 원문 검색이 실패해서 Gemini 보정으로 재검색했는지 여부(triedFallback)와
  // 그 결과 실제로 성공한 대체 검색어(correctedQuery)가 담겨 온다 — AI 챗봇이 재검색 상황을
  // 안내 말풍선으로 보여줄 때 쓴다(일반 오더 등록 화면의 수동 검색에서는 쓰지 않는다).
  function geocode(query, onDone) {
    geocodeWithMode(query, 'fallback', onDone);
  }

  function geocodeWithMode(query, mode, onDone) {
    var qs = new URLSearchParams({ q: query });
    if (mode) qs.set('mode', mode);
    fetch('/kakao/search?' + qs.toString())
      .then(function (res) { return res.json(); })
      .then(function (data) { onDone(data.documents || [], data); })
      .catch(function () { onDone([], null); });
  }

  // 콜마너 오더접수 연동에 필요한 좌표/시도/시구군/동 — 출발지/도착지 확정 시 hidden input에
  // 채워서 폼 제출에 포함시킨다(경유지는 콜마너 viaList 연동 대상이 아니라 채우지 않음).
  // 채팅 응답 체감속도를 위해 이 fetch 자체는 fire-and-forget으로 두되(각 확인 말풍선을
  // 지연시키지 않음), 반환하는 Promise를 pendingRegionResolutions에 모아뒀다가 실제 오더
  // "제출" 직전(ai-intake.js의 window.__aiIntakeWaitPendingRegions)에만 전부 기다린다 —
  // 그래야 hidden input이 빈 채로(콜마너 연동 실패) 제출되는 일이 없으면서도, 대화 중간
  // 매 메시지가 이 API 응답을 기다리느라 느려지지 않는다.
  var pendingRegionResolutions = [];
  function resolveRegionAndFill(slot, kind, lat, lon) {
    var latInput = document.getElementById(slot + '_lat');
    var lonInput = document.getElementById(slot + '_lon');
    if (latInput) latInput.value = lat;
    if (lonInput) lonInput.value = lon;
    updateGeoBadges(slot);
    // 행정구역은 콜마너 오더접수가 요구하는 출발지/도착지만 조회한다(경유지는 viaList 미연동).
    if (kind !== 'origin' && kind !== 'destination') return Promise.resolve();
    var promise = fetch('/kakao/region?lat=' + lat + '&lng=' + lon)
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (region) {
        if (!region) return;
        var sidoInput = document.getElementById(slot + '_sido');
        var sigugunInput = document.getElementById(slot + '_sigugun');
        var dongInput = document.getElementById(slot + '_dong');
        if (sidoInput) sidoInput.value = region.sido || '';
        if (sigugunInput) sigugunInput.value = region.sigugun || '';
        if (dongInput) dongInput.value = region.dong || '';
        updateGeoBadges(slot);
      })
      .catch(function () {});
    pendingRegionResolutions.push(promise);
    return promise;
  }

  // 주소가 지워지거나 확정이 풀리면 좌표/행정구역도 함께 비운다 — 안 그러면 예전 주소의 좌표가
  // hidden input에 남아 배지는 켜져 있는데 실제로는 다른 주소가 제출되는 상태가 된다.
  function clearGeoFields(slot) {
    ['_lat', '_lon', '_sido', '_sigugun', '_dong'].forEach(function (suffix) {
      var el = document.getElementById(slot + suffix);
      if (el) el.value = '';
    });
    updateGeoBadges(slot);
  }

  // 오더 등록 직전(precheck/제출 시작 시)에 호출 — 그때까지 안 끝난 좌표/행정구역 조회를
  // 전부 기다린 뒤 큐를 비운다. 개별 주소 확인 시점이 아니라 여기서만 기다리므로 대화
  // 진행 자체는 각 API 응답을 기다리지 않고 바로바로 이어진다.
  window.__aiIntakeWaitPendingRegions = function () {
    var all = Promise.all(pendingRegionResolutions);
    pendingRegionResolutions = [];
    return all;
  };

  function mainAddressOf(r) { return r.road_address || r.jibun_address || ''; }
  function resultLabel(r) {
    if (r.type === 'place') {
      var addr = mainAddressOf(r);
      return r.place_name + (addr ? ' · ' + addr : '');
    }
    var main = mainAddressOf(r);
    var sub = (r.road_address && r.jibun_address && r.road_address !== r.jibun_address) ? r.jibun_address : null;
    return main + (sub ? ' (' + sub + ')' : '');
  }

  // 등록주소 관리 팝업의 "새 주소 등록" 입력창 검색 (지도 마커 없이 주소만 채움)
  var regAddrNewAddrInput = document.getElementById('regAddrNewAddress');
  var regAddrNewAddrResults = document.getElementById('regAddrNewAddress_results');
  var regAddrNewAddrSearchBtn = document.querySelector('.addr-search-btn[data-target="regAddrNewAddress"]');
  if (regAddrNewAddrInput && regAddrNewAddrSearchBtn) {
    regAddrNewAddrSearchBtn.addEventListener('click', function () {
      var q = regAddrNewAddrInput.value.trim();
      if (!q) return;
      regAddrNewAddrResults.innerHTML = '<div class="addr-result-item muted">검색 중...</div>';
      geocode(q, function (results) {
        if (!results.length) { regAddrNewAddrResults.innerHTML = '<div class="addr-result-item muted">검색 결과가 없습니다.</div>'; return; }
        regAddrNewAddrResults.innerHTML = '';
        results.forEach(function (r) {
          var item = document.createElement('div');
          item.className = 'addr-result-item';
          item.textContent = resultLabel(r);
          item.addEventListener('click', function () {
            regAddrNewAddrInput.value = mainAddressOf(r);
            var labelInput = document.getElementById('regAddrNewLabel');
            if (r.type === 'place' && labelInput && !labelInput.value) labelInput.value = r.place_name;
            regAddrNewAddrResults.innerHTML = '';
          });
          regAddrNewAddrResults.appendChild(item);
        });
      });
    });
    regAddrNewAddrInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); regAddrNewAddrSearchBtn.click(); }
    });
  }

  // ---------- 직접 입력 토글 ----------
  document.querySelectorAll('.direct-input-toggle').forEach(function (chk) {
    chk.addEventListener('change', function () {
      var wrap = chk.closest('.field');
      var searchBtn = wrap.querySelector('.addr-search-btn');
      if (searchBtn) searchBtn.style.display = chk.checked ? 'none' : '';
      var results = wrap.querySelector('.addr-results');
      if (results) results.innerHTML = '';
      var input = document.getElementById(chk.dataset.target);
      input.dataset.skipGeocode = chk.checked ? '1' : '0';
      var detailInput = document.getElementById(detailIdFor(chk.dataset.target));
      if (chk.checked && detailInput) { detailInput.disabled = false; detailInput.style.display = ''; }
    });
  });

  if (typeof kakao === 'undefined' || !kakao.maps) return; // 카카오맵 SDK 로드 실패 시 지도/지오코딩 기능만 건너뜀

  var map = new kakao.maps.Map(document.getElementById('orderMap'), {
    center: new kakao.maps.LatLng(36.5, 127.9),
    level: 12,
  });

  // 지도 확대보기: 새 지도 인스턴스를 또 만들지 않고, 이미 마커/경로가 그려진 같은
  // #orderMap DOM 노드를 모달로 옮겼다가(reparent) 닫으면 원래 자리로 되돌린다.
  // kakao.maps.Map은 컨테이너 크기가 바뀌면 relayout()을 호출해줘야 타일이 다시 그려진다.
  (function setupMapZoom() {
    var mapEl = document.getElementById('orderMap');
    if (!mapEl) return;
    var originalParent = mapEl.parentNode;
    var originalNextSibling = mapEl.nextSibling;

    // 버튼을 지도 div 안(kakao가 내부 레이어를 그려넣는 곳)이 아니라 별도 래퍼의 형제로
    // 둬야 카카오맵 내부 레이어에 가려지거나 지워지지 않는다.
    var wrap = document.createElement('div');
    wrap.className = 'map-wrap';
    originalParent.insertBefore(wrap, mapEl);
    wrap.appendChild(mapEl);

    var zoomBtn = document.createElement('button');
    zoomBtn.type = 'button';
    zoomBtn.className = 'map-zoom-btn';
    zoomBtn.title = '크게 보기';
    zoomBtn.setAttribute('aria-label', '지도 크게 보기');
    zoomBtn.textContent = '🔍';
    wrap.appendChild(zoomBtn);

    var overlay = document.createElement('div');
    overlay.className = 'map-modal-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML =
      '<div class="map-modal-box">' +
        '<div class="map-modal-header">' +
          '<h3>경로 미리보기</h3>' +
          '<button type="button" class="modal-close" id="mapZoomCloseBtn">✕</button>' +
        '</div>' +
        '<div class="map-modal-body" id="mapZoomBody"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    var modalBody = overlay.querySelector('#mapZoomBody');
    var closeBtn = overlay.querySelector('#mapZoomCloseBtn');

    function openZoom() {
      modalBody.appendChild(wrap);
      overlay.style.display = 'flex';
      // display:none이었던 동안 컨테이너 크기가 0이었으므로, 실제로 크기가 잡힌 다음
      // relayout해야 타일이 정상적으로 채워진다.
      setTimeout(function () { map.relayout(); refreshMapView(); }, 0);
    }
    function closeZoom() {
      if (originalNextSibling && originalNextSibling.parentNode === originalParent) {
        originalParent.insertBefore(wrap, originalNextSibling);
      } else {
        originalParent.appendChild(wrap);
      }
      overlay.style.display = 'none';
      setTimeout(function () { map.relayout(); refreshMapView(); }, 0);
    }
    zoomBtn.addEventListener('click', openZoom);
    closeBtn.addEventListener('click', closeZoom);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeZoom(); });
  })();

  var pinClassByKind = { origin: 'origin', destination: 'dest', waypoint: 'waypoint' };
  var markers = {}; // slot -> kakao.maps.CustomOverlay
  var routeLine = null;

  function toggleConfirmBadge(slot, on) {
    var badge = document.getElementById(slot + 'ConfirmBadge');
    if (badge) badge.classList.toggle('visible', !!on);
  }

  // 콜마너 오더접수에 필요한 좌표/행정구역은 hidden input이라 화면에서 확인할 방법이 없었다 —
  // "지도확정" 배지와 같은 방식으로 실제 hidden input 값을 읽어 켜고 끈다(추측이 아니라 실제로
  // 제출될 값을 그대로 반영). 경유지는 행정구역을 수집하지 않으므로(order_waypoints에 sido/
  // sigugun/dong 컬럼 없음 + 콜마너 viaList 미연동) 좌표 배지만 존재한다.
  function updateGeoBadges(slot) {
    var val = function (id) {
      var el = document.getElementById(id);
      return el ? String(el.value || '').trim() : '';
    };
    var coordBadge = document.getElementById(slot + 'CoordBadge');
    if (coordBadge) coordBadge.classList.toggle('visible', !!(val(slot + '_lat') && val(slot + '_lon')));
    var regionBadge = document.getElementById(slot + 'RegionBadge');
    if (regionBadge) {
      regionBadge.classList.toggle('visible', !!(val(slot + '_sido') && val(slot + '_sigugun') && val(slot + '_dong')));
    }
  }
  function removeMarker(slot) {
    if (markers[slot]) { markers[slot].setMap(null); delete markers[slot]; }
    toggleConfirmBadge(slot, false);
    clearGeoFields(slot);
    refreshMapView();
  }
  function placeMarker(slot, kind, latlng) {
    var position = new kakao.maps.LatLng(latlng[0], latlng[1]);
    if (markers[slot]) {
      markers[slot].setPosition(position);
    } else {
      markers[slot] = new kakao.maps.CustomOverlay({
        position: position,
        content: '<div class="map-pin ' + (pinClassByKind[kind] || 'origin') + '"></div>',
        xAnchor: 0.5,
        yAnchor: 0.5,
      });
      markers[slot].setMap(map);
    }
    toggleConfirmBadge(slot, true);
    refreshMapView();
  }

  // 출발 → 경유(순서대로) → 도착 순서의 슬롯 목록
  function getOrderedSlots() {
    var slots = ['origin'];
    document.querySelectorAll('#waypointsWrap .waypoint-row').forEach(function (row) {
      slots.push(row.dataset.slot);
    });
    slots.push('destination');
    return slots;
  }
  function slotLabel(slot) {
    if (slot === 'origin') return '출발';
    if (slot === 'destination') return '도착';
    var rows = document.querySelectorAll('#waypointsWrap .waypoint-row');
    var idx = -1;
    rows.forEach(function (row, i) { if (row.dataset.slot === slot) idx = i; });
    return '경유' + (idx + 1);
  }
  function haversineKm(a, b) {
    var R = 6371;
    var dLat = (b[0] - a[0]) * Math.PI / 180;
    var dLon = (b[1] - a[1]) * Math.PI / 180;
    var lat1 = a[0] * Math.PI / 180;
    var lat2 = b[0] * Math.PI / 180;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function drawPolyline(path) {
    if (routeLine) { routeLine.setMap(null); routeLine = null; }
    routeLine = new kakao.maps.Polyline({
      path: path, strokeWeight: 4, strokeColor: '#2e5c8a', strokeOpacity: 0.8, strokeStyle: 'solid',
    });
    routeLine.setMap(map);
  }

  function formatDuration(seconds) {
    var totalMin = Math.round(seconds / 60);
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    return h > 0 ? (h + '시간 ' + m + '분') : (m + '분');
  }

  function appendDistanceRow(listEl, fromLabel, toLabel, km) {
    var row = document.createElement('div');
    row.className = 'map-distance-row';
    row.innerHTML = '<span>' + fromLabel + ' → ' + toLabel + '</span><span>' + km.toFixed(1) + 'km</span>';
    listEl.appendChild(row);
  }

  function renderDistanceRows(points, distancesKm) {
    var listEl = document.getElementById('mapDistanceList');
    listEl.innerHTML = '';
    // 선박 이동이 필수인 구간(경유지 없이 출발-도착만 있는 경우)은 일반 "출발 → 도착" 한 줄
    // 대신, 실제 지명으로 "출발지명 → 출발항 → 도착항 → 도착지명" 세 구간으로 나눠 보여준다.
    var routeMeta = window.__aiIntakeRouteMeta || null;
    var seg = (routeMeta && routeMeta.hasFerryLeg) ? routeMeta.ferrySegments : null;
    if (seg && points.length === 2) {
      var originAddrInput = document.getElementById('origin_address');
      var destAddrInput = document.getElementById('destination_address');
      var originName = (originAddrInput && originAddrInput.value.trim()) || slotLabel('origin');
      var destName = (destAddrInput && destAddrInput.value.trim()) || slotLabel('destination');
      var fromPort = seg.fromPort || '출발항';
      var toPort = seg.toPort || '도착항';
      appendDistanceRow(listEl, originName, fromPort, (seg.beforeDistanceM || 0) / 1000);
      appendDistanceRow(listEl, fromPort, toPort, (seg.ferryDistanceM || 0) / 1000);
      appendDistanceRow(listEl, toPort, destName, (seg.afterDistanceM || 0) / 1000);
      document.getElementById('mapDistanceInfo').style.display = '';
      return;
    }
    for (var i = 0; i < points.length - 1; i++) {
      appendDistanceRow(listEl, slotLabel(points[i].slot), slotLabel(points[i + 1].slot), distancesKm[i]);
    }
    document.getElementById('mapDistanceInfo').style.display = '';
  }

  function renderRouteSummary(totalKm, totalDurationSec, tollFare, routeTimingMeta) {
    currentRouteDurationSec = Number.isFinite(totalDurationSec) ? totalDurationSec : null;
    document.getElementById('routeTotalDistance').textContent = totalKm != null ? totalKm.toFixed(1) + 'km' : '-';
    document.getElementById('routeTotalDuration').textContent = totalDurationSec != null ? formatDuration(totalDurationSec) : '-';
    // 톨비 표시. 카카오는 요금소별 금액을 주지 않고 합계 하나만 준다(실측) — 그래서 특수구간
    // (민자 교량 등)은 우리가 등록한 금액을 따로 덧붙여 보여준다. 합쳐 버리면 관리자가
    // "이 톨비에 서해대교가 들어 있나"를 알 수 없고, 실비 청구 대상인지도 구분이 안 된다.
    var tollEl = document.getElementById('routeTollFare');
    var tollText = (tollFare !== null && tollFare !== undefined)
      ? (Number(tollFare) === 0 ? '무료' : Number(tollFare).toLocaleString('ko-KR') + '원')
      : '-';
    if (lastSpecialTolls && lastSpecialTolls.length) {
      var sum = lastSpecialTolls.reduce(function (a, t) { return a + (Number(t.amount) || 0); }, 0);
      tollText += ' · 특수구간 ' + lastSpecialTolls.map(function (t) { return t.name; }).join(', ')
        + ' +' + sum.toLocaleString('ko-KR') + '원';
    }
    tollEl.textContent = tollText;
    // 직선거리 임시값인지 실제 도로 경로 확정값인지는 routeDurationBasis 문구가 있는 form.ejs
    // 화면에서만 사람이 읽을 수 있다 — ai_intake.ejs에는 그 엘리먼트가 없으므로, 어느 화면에서든
    // 챗봇(ai-intake.js)이 최종 확정 여부를 판단할 수 있도록 전역 플래그로도 남겨둔다.
    window.__aiIntakeRouteFinal = !!(routeTimingMeta && (routeTimingMeta.mode === 'future' || routeTimingMeta.mode === 'current'));
    var basisEl = document.getElementById('routeDurationBasis');
    if (basisEl) {
      if (routeTimingMeta && routeTimingMeta.mode === 'future') {
        basisEl.textContent = '소요시간 기준: 예약일시 교통 예측';
      } else if (routeTimingMeta && routeTimingMeta.mode === 'current') {
        basisEl.textContent = '소요시간 기준: 현재 교통';
      } else {
        basisEl.textContent = '소요시간 기준: 직선거리 임시값 (도로 경로 탐색 중)';
      }
      // 무료도로를 골랐는데 그 조건으로는 경로가 없어 유료도로 포함으로 계산된 경우.
      // 표시하지 않으면 "무료도로로 골랐는데 왜 톨비가 있지?"가 된다.
      var droppedMeta = window.__aiIntakeRouteMeta || null;
      if (droppedMeta && droppedMeta.avoidDropped) {
        basisEl.textContent += ' · 무료도로만으로는 경로가 없어 유료도로 포함으로 계산했습니다';
      }
    }
    lastRouteKm = totalKm;
    lastTollFare = tollFare;
    lastRouteTimingMeta = routeTimingMeta;
    updateFarePreview(totalKm);
    updateFerryFareTile(totalKm);
    syncReservationBasisPreview();
  }

  // 강원/경남/경북/부산/울산 출발 + 제주 도착 건은 삼천포신항-제주항(오션비스타) 도선을 타야
  // 하는데, 카카오모빌리티 길찾기는 이 노선을 아예 모른다(실제로 삼천포를 그냥 육로로 지나쳐서
  // 완도까지 내려가 완도-제주 항로로 계산해버리는 것을 직접 확인함 — 단순 경유지로 찍어서는
  // 고쳐지지 않는다). 그래서 이 구간은 카카오에게 통짜로 묻지 않고 ①출발지→삼천포신항(육로),
  // ②삼천포신항→제주항(카카오가 모르는 구간이라 직선거리+실제 시간표 기준 고정 소요시간),
  // ③제주항→목적지(육로) 세 구간으로 나눠 직접 계산해서 합친다.
  // 이 지역 판정 정규식은 lib/ferryFare.js의 pickFerryRouteCode()와 반드시 같이 맞춰야 한다.
  var SAMCHEONPO_REGION_RE = /(강원|경상남도|경남|경상북도|경북|부산|울산)/;
  var SAMCHEONPO_PORT_LATLNG = { lat: 34.9269695307662, lng: 128.088376812689 }; // 삼천포신항여객터미널(카카오 로컬API 조회값)
  var JEJU_PORT_LATLNG = { lat: 33.519591050522465, lng: 126.53500143704899 }; // 제주항연안여객터미널(카카오 로컬API 조회값)
  // 오션비스타제주 실제 시간표 기준(약 6시간30분) — ferry_schedules 테이블의 duration_minutes와 맞춰야 한다.
  var SAMCHEONPO_JEJU_FERRY_DURATION_S = 390 * 60;
  function shouldForceSamcheonpoRoute() {
    var originEl = document.getElementById('origin_address');
    var destEl = document.getElementById('destination_address');
    var origin = originEl ? originEl.value : '';
    var destination = destEl ? destEl.value : '';
    return SAMCHEONPO_REGION_RE.test(origin) && /제주/.test(destination);
  }

  // 구간요금 설정(fare_rules) 기반 자동 요금 계산 — 지사가 요금표를 사용하지 않으면 기존처럼 수동 입력을 유지한다.
  var fareAmountInput = document.getElementById('fare_amount');
  var ferryFareInput = document.getElementById('ferry_fare_amount');
  var fareCalcHint = document.getElementById('fareCalcHint');
  var myRole = form ? form.dataset.myRole : '';
  var fareRequestId = 0;
  var vehicleTypeInput = document.getElementById('vehicle_type');

  function ferryQueryParams(totalKm) {
    var branchInput = document.getElementById('branch_id');
    var branchId = branchInput ? branchInput.value : '';
    var routeMeta = window.__aiIntakeRouteMeta || null;
    var vehicleType = vehicleTypeInput ? vehicleTypeInput.value.trim() : '';
    var reservedDateInput = document.querySelector('input[name="reserved_date"]');
    var reservedTimeInput = document.querySelector('input[name="reserved_time"]');
    var fareReservedDate = (isDeliveryReservationBasis() && pickupReservedDateInput && pickupReservedDateInput.value)
      ? pickupReservedDateInput.value
      : (reservedDateInput && reservedDateInput.value ? reservedDateInput.value : '');
    // 도선 예상 도착시각 계산은 "출발지에서 실제 출발하는 시각"이 기준이라, 도착지 인도시간
    // 기준 예약이면(역산된) pickup_reserved_time을, 아니면 reserved_time을 그대로 쓴다.
    var fareReservedTime = (isDeliveryReservationBasis() && pickupReservedTimeInput && pickupReservedTimeInput.value)
      ? pickupReservedTimeInput.value
      : (reservedTimeInput && reservedTimeInput.value ? reservedTimeInput.value : '');
    var originAddressInput = document.getElementById('origin_address');
    var params = new URLSearchParams();
    if (branchId) params.set('branch_id', branchId);
    if (Number.isFinite(totalKm)) params.set('distance_km', String(totalKm.toFixed(2)));
    if (vehicleType) params.set('vehicle_type', vehicleType);
    if (originAddressInput && originAddressInput.value.trim()) params.set('origin_address', originAddressInput.value.trim());
    var destAddressInput = document.getElementById('destination_address');
    if (destAddressInput && destAddressInput.value.trim()) params.set('destination_address', destAddressInput.value.trim());
    // 지점 구간요금 판정에 필요한 값 — 좌표로 "출발/도착이 그 지점인가"를 보고, 반대편의
    // 시도·시군구로 계약표의 지역을 찾는다(lib/officeZoneFare.js). 주소 문자열로 지점을
    // 판정하면 "서울 강남구"와 "서울특별시 강남구"가 다른 곳이 된다.
    ['origin', 'destination'].forEach(function (slot) {
      ['lat', 'lon', 'sido', 'sigugun'].forEach(function (f) {
        var el = document.getElementById(slot + '_' + f);
        if (el && String(el.value || '').trim()) params.set(slot + '_' + f, String(el.value).trim());
      });
    });
    var groupSelect = document.querySelector('select[name="requester_group_id"], input[name="requester_group_id"]');
    if (groupSelect && groupSelect.value) params.set('group_id', groupSelect.value);
    if (fareReservedDate) params.set('reserved_date', fareReservedDate);
    if (fareReservedTime) params.set('reserved_time', fareReservedTime);
    if (routeMeta) {
      params.set('has_ferry_leg', routeMeta.hasFerryLeg ? '1' : '0');
      params.set('route_meta_json', JSON.stringify(routeMeta));
      // 도선 구간의 육로 구간별(출발지→항구/항구→도착지) 거리·소요시간 — 기본요금을 구간별로
      // 각각 계산해서 합산하고(기본요금이 두 번 청구되는 게 맞다는 확인을 받음), 예상 도착시각도
      // 실제 배편 시간표를 조회해서 계산하기 위해 필요하다.
      var seg = routeMeta.ferrySegments;
      if (seg) {
        if (Number.isFinite(seg.beforeDistanceM)) params.set('before_km', String((seg.beforeDistanceM / 1000).toFixed(2)));
        if (Number.isFinite(seg.afterDistanceM)) params.set('after_km', String((seg.afterDistanceM / 1000).toFixed(2)));
        if (Number.isFinite(seg.beforeDurationS)) params.set('before_minutes', String(Math.round(seg.beforeDurationS / 60)));
        if (Number.isFinite(seg.afterDurationS)) params.set('after_minutes', String(Math.round(seg.afterDurationS / 60)));
      }
    }
    return params;
  }

  function updateFarePreview(totalKm) {
    if (!fareAmountInput || !fareCalcHint || totalKm == null) return;
    var branchInput = document.getElementById('branch_id');
    var branchId = branchInput ? branchInput.value : '';
    if (!branchId) return;
    var requestId = (fareRequestId += 1);
    fetch('/orders/fare-preview?' + ferryQueryParams(totalKm).toString())
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (requestId !== fareRequestId) return;
        if (!data.enabled) {
          fareCalcHint.textContent = '이 지사는 구간요금표를 사용하지 않아 수동으로 입력합니다.';
          fareCalcHint.classList.remove('calculated');
          fareAmountInput.readOnly = false;
          return;
        }
        lastSpecialTolls = Array.isArray(data.specialTolls) ? data.specialTolls : [];
        // 톨비 줄을 다시 그린다 — 요금 응답이 경로 응답보다 늦게 오므로 여기서 한 번 더 반영한다.
        if (lastRouteKm != null) renderRouteSummary(lastRouteKm, currentRouteDurationSec, lastTollFare, lastRouteTimingMeta);
        fareAmountInput.value = data.totalFare != null ? data.totalFare : data.fare;
        if (ferryFareInput) ferryFareInput.value = data.ferryFare != null ? data.ferryFare : 0;
        if (data.ferryNeedVehicleType) {
          fareCalcHint.textContent = '구간요금은 자동 계산되었습니다 (' + totalKm.toFixed(1) + 'km 기준). 도선료 계산을 위해 차종을 입력하세요.';
        } else if (data.ferryApplied && data.ferryFare != null) {
          fareCalcHint.textContent = '구간요금 ' + Number(data.baseFare || 0).toLocaleString('ko-KR') + '원 + 도선료 ' + Number(data.ferryFare || 0).toLocaleString('ko-KR') + '원 = 총 ' + Number(data.totalFare || data.fare || 0).toLocaleString('ko-KR') + '원으로 자동 계산되었습니다.';
        } else {
          fareCalcHint.textContent = '구간요금 설정에 따라 자동 계산되었습니다 (' + totalKm.toFixed(1) + 'km 기준). 필요 시 직접 수정할 수 있습니다.';
          if (ferryFareInput) ferryFareInput.value = 0;
        }
        fareCalcHint.classList.add('calculated');
        var locked = myRole === 'client' && !data.editableByClient;
        fareAmountInput.readOnly = locked;
        if (locked) fareCalcHint.textContent += ' (수정 불가)';
      })
      .catch(function () {});
  }

  var ferryFareTileRequestId = 0;
  // "예상톨비" 옆 도선요금 타일 — branch_id가 아직 선택되지 않아도(예: AI 챗봇 요금 문의 중)
  // 표시되어야 하므로 updateFarePreview(지사 미선택 시 조기 종료)와는 별도로 항상 조회한다.
  function updateFerryFareTile(totalKm) {
    var ferryFareItem = document.getElementById('routeFerryFareItem');
    var ferryFareValue = document.getElementById('routeFerryFare');
    var ferryArrivalItem = document.getElementById('routeFerryArrivalItem');
    var ferryArrivalValue = document.getElementById('routeFerryArrival');
    if (!ferryFareItem || !ferryFareValue) return;
    var routeMeta = window.__aiIntakeRouteMeta || null;
    if (!routeMeta || !routeMeta.hasFerryLeg || totalKm == null) {
      ferryFareItem.style.display = 'none';
      if (ferryArrivalItem) ferryArrivalItem.style.display = 'none';
      return;
    }
    var requestId = (ferryFareTileRequestId += 1);
    fetch('/orders/fare-preview?' + ferryQueryParams(totalKm).toString())
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (requestId !== ferryFareTileRequestId) return;
        if (!data || !data.enabled) {
          ferryFareItem.style.display = 'none';
          if (ferryArrivalItem) ferryArrivalItem.style.display = 'none';
          return;
        }
        if (data.ferryNeedVehicleType) {
          ferryFareItem.style.display = '';
          ferryFareValue.textContent = '차종 필요';
        } else if (data.ferryApplied && data.ferryFare != null) {
          ferryFareItem.style.display = '';
          ferryFareValue.textContent = Number(data.ferryFare).toLocaleString('ko-KR') + '원';
        } else {
          ferryFareItem.style.display = 'none';
        }
        // 도착 예상 시각은 실제 배편 시간표를 조회해서 계산한 결과다 — 승선/하선 대기 등
        // 여유시간은 화면에 별도로 보여주지 않고 이 값 자체에 이미 반영되어 있다.
        if (ferryArrivalItem && ferryArrivalValue) {
          if (data.ferryEstimate && data.ferryEstimate.finalArrivalLabel) {
            ferryArrivalItem.style.display = '';
            ferryArrivalValue.textContent = data.ferryEstimate.finalArrivalLabel + ' 도착 예정';
          } else {
            ferryArrivalItem.style.display = 'none';
          }
        }
      })
      .catch(function () {
        ferryFareItem.style.display = 'none';
        if (ferryArrivalItem) ferryArrivalItem.style.display = 'none';
      });
  }

  if (vehicleTypeInput) {
    vehicleTypeInput.addEventListener('input', function () {
      updateFarePreview(lastRouteKm);
      updateFerryFareTile(lastRouteKm);
    });
  }

  var routePriority = 'RECOMMEND';
  var routePrioritySelect = document.getElementById('routePrioritySelect');
  // 사용자가 드롭다운을 한 번이라도 직접 바꾸면 그 뒤로는 오더타입이 바뀌어도 기본값을
  // 강제로 덮어쓰지 않는다 — 되돌리면 "방금 무료도로로 바꿨는데 왜 다시 추천으로 바뀌지"가 된다.
  var routePriorityTouchedByUser = false;
  var reservedDateInputForRoute = document.getElementById('reserved_date');
  var reservedTimeInputForRoute = document.querySelector('input[name="reserved_time"]');
  var reservedTimeHourSelect = document.getElementById('reserved_time_hour');
  var reservedTimeMinuteSelect = document.getElementById('reserved_time_minute');

  function buildDepartureTimeParam() {
    var dateValue = reservedDateInputForRoute && reservedDateInputForRoute.value ? reservedDateInputForRoute.value.trim() : '';
    var timeValue = reservedTimeInputForRoute && reservedTimeInputForRoute.value ? reservedTimeInputForRoute.value.trim() : '';
    if (!timeValue && reservedTimeHourSelect && reservedTimeMinuteSelect) {
      timeValue = String(reservedTimeHourSelect.value || '').trim() + ':' + String(reservedTimeMinuteSelect.value || '').trim();
    }
    var m = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    var t = timeValue.match(/^(\d{2}):(\d{2})$/);
    if (!m || !t) return '';
    return m[1] + m[2] + m[3] + t[1] + t[2];
  }

  function setAiRouteMeta(meta) {
    window.__aiIntakeRouteMeta = meta || { hasFerryLeg: false, ferryLegs: [], ferrySegments: null };
  }
  setAiRouteMeta({ hasFerryLeg: false, ferryLegs: [], ferrySegments: null });

  // 경로탐색이 실패한 이유를 남긴다.
  //
  // 왜 필요한가(2026-08-25 실사용): 사당역→서귀포시청 요금문의에서 "거리 계산을 완료하지
  // 못했습니다. 주소를 조금 더 상세히 입력해주세요"가 나갔다. 주소는 둘 다 정상 확정됐고 서버
  // 경로탐색도 멀쩡했다(직접 호출해 571.8km 확인) — 즉 안내 자체가 틀린 말이었고, 고객은 고칠
  // 것이 없는 주소를 고치려 들었다.
  //
  // 원인을 찾을 수 없었던 이유는 이 아래 두 갈래가 실패를 통째로 삼켰기 때문이다. 응답이
  // ok가 아니면 null로 바꿔 그냥 return하고, 예외는 빈 .catch()가 먹었다. 그래서 화면에는
  // 직선거리 임시값만 남고 챗봇은 20초를 기다리다 포기하는데, 왜 그랬는지는 아무 데도 안 남았다.
  //
  // 이제 사유를 여기 담아두고 챗봇(ai-intake.js)이 그대로 읽어 고객에게 맞는 말을 하게 한다.
  // 새 요청이 시작되면 지운다 — 지난 실패가 다음 안내에 묻으면 안 된다.
  function setRouteError(stage, detail) {
    window.__aiIntakeRouteError = detail ? { stage: stage, detail: detail } : null;
    if (detail) console.error('[경로탐색 실패] ' + stage + ': ' + detail);
  }
  setRouteError(null, null);

  // 실패 응답 본문에서 사람이 읽을 수 있는 사유를 뽑는다. 서버(routes/kakao.js)는 실패 시
  // { error, detail }을 주는데, 본문이 비었거나 JSON이 아닐 수도 있어 상태코드까지 함께 남긴다.
  function describeFailedResponse(res) {
    return res.text().catch(function () { return ''; }).then(function (body) {
      var reason = '';
      try {
        var parsed = JSON.parse(body);
        reason = parsed && (parsed.error || parsed.detail) ? String(parsed.error || parsed.detail) : '';
      } catch (e) {
        reason = String(body || '').slice(0, 200);
      }
      return 'HTTP ' + res.status + (reason ? ' · ' + reason : '');
    });
  }

  // fetch → (ok면 JSON, 아니면 사유를 담은 예외). 아래 두 갈래가 같은 규칙을 쓰도록 한 곳에 둔다.
  function fetchDirections(url) {
    return fetch(url).then(function (res) {
      if (res.ok) return res.json();
      return describeFailedResponse(res).then(function (why) { throw new Error(why); });
    });
  }
  if (routePrioritySelect) {
    routePrioritySelect.addEventListener('change', function () {
      routePriorityTouchedByUser = true;
      routePriority = routePrioritySelect.value;
      refreshMapView();
    });
  }

  // 오더타입별 경로탐색 기본값 — 탁송(dispatch)은 무료도로, 프리미엄/일일기사는 추천이 기본이다
  // (실사용 지적: 탁송은 톨비를 고객이 부담하는 경우가 많아 무료도로가 실제 운행 경로에 가깝고,
  // 대리/일일기사는 시간이 우선이라 추천 경로가 맞다). order_type <select>가 있는 화면
  // (form.ejs)과, 대화로 오더타입이 나중에 정해지는 화면(ai_intake.ejs, orderCategory 변경 시
  // ai-intake.js가 window.__applyRoutePriorityDefaultForOrderType을 직접 호출) 양쪽에서 쓴다.
  function applyRoutePriorityDefaultForOrderType(orderType) {
    if (routePriorityTouchedByUser || !routePrioritySelect) return;
    var next = (orderType === 'premium' || orderType === 'daily_driver') ? 'RECOMMEND' : 'FREE';
    if (next === routePriority) return;
    routePriority = next;
    routePrioritySelect.value = next;
    refreshMapView();
  }
  window.__applyRoutePriorityDefaultForOrderType = applyRoutePriorityDefaultForOrderType;

  var orderTypeSelectEl = document.querySelector('select[name="order_type"]');
  if (orderTypeSelectEl) {
    applyRoutePriorityDefaultForOrderType(orderTypeSelectEl.value);
    orderTypeSelectEl.addEventListener('change', function () {
      applyRoutePriorityDefaultForOrderType(orderTypeSelectEl.value);
    });
  } else if (routePrioritySelect) {
    // order_type <select>가 없는 화면(ai_intake.ejs)은 대화가 시작되기 전 기본 오더유형(탁송)
    // 기준으로 먼저 맞춰둔다 — orderCategory가 확정되면 ai-intake.js가 다시 불러 갱신한다.
    applyRoutePriorityDefaultForOrderType('dispatch');
  }

  // 요금 미리보기가 알려준 특수구간(민자 교량 등). 톨비 표시에 덧붙인다.
  var lastSpecialTolls = [];
  var lastTollFare = null;
  var lastRouteTimingMeta = null;
  var directionsRequestId = 0;
  function fetchRealDirections(points, requestId) {
    var coord = function (p) { return p.latlng.getLng() + ',' + p.latlng.getLat(); };
    var isFreeRoute = routePriority === 'FREE';
    var apiPriority = isFreeRoute ? 'RECOMMEND' : routePriority;
    var params = new URLSearchParams();
    params.set('origin', coord(points[0]));
    params.set('destination', coord(points[points.length - 1]));
    params.set('priority', apiPriority);
    if (isFreeRoute) params.set('avoid', 'toll');
    if (points.length > 2) {
      params.set('waypoints', points.slice(1, -1).map(coord).join('|'));
    }
    var departureTime = buildDepartureTimeParam();
    if (departureTime) params.set('departure_time', departureTime);
    setRouteError(null, null);
    fetchDirections('/kakao/directions?' + params.toString())
      .then(function (data) {
        if (requestId !== directionsRequestId) return; // 오래된 응답 — 새 요청이 이미 돌고 있다
        setAiRouteMeta({
          hasFerryLeg: !!data.hasFerryLeg,
          ferryLegs: Array.isArray(data.ferryLegs) ? data.ferryLegs : [],
          ferrySegments: data.ferrySegments || null,
          // 무료도로로는 경로가 없어 서버가 회피조건을 풀고 다시 물은 경우(제주행이 그렇다).
          // 탁송은 톨비를 고객이 내는 경우가 많아 조용히 넘어가면 안 된다.
          avoidDropped: data.avoidDropped || null,
          // 지나간 요금소 이름. 특수구간(교량 등) 판정에 쓴다 — 카카오는 요금소별 금액을
          // 주지 않으므로 "지났는지"만 여기서 알고 금액은 우리 표에서 가져온다.
          tollgates: Array.isArray(data.tollgates) ? data.tollgates : [],
        });
        if (data.path && data.path.length > 1) {
          drawPolyline(data.path.map(function (c) { return new kakao.maps.LatLng(c[0], c[1]); }));
        }
        // segments가 비어 오는 경우가 있어(경로는 나왔는데 구간 분해가 없는 응답) 그대로
        // .map을 부르면 여기서 예외가 나고, 아래 총거리 표시까지 통째로 못 간다 — 구간별
        // 표시는 부가정보이므로 없으면 없는 대로 두고 총거리는 반드시 그린다.
        var kmSegments = Array.isArray(data.segments)
          ? data.segments.map(function (s) { return s.distance / 1000; })
          : [];
        renderDistanceRows(points, kmSegments);
        renderRouteSummary(data.totalDistance / 1000, data.totalDuration, data.tollFare, {
          mode: data.usedFuture ? 'future' : 'current',
        });
      })
      .catch(function (e) {
        if (requestId !== directionsRequestId) return;
        setAiRouteMeta({ hasFerryLeg: false, ferryLegs: [], ferrySegments: null });
        setRouteError('경로탐색', (e && e.message) || '알 수 없는 오류');
        /* 화면은 직선거리 fallback 유지 — 사유는 위에 남겨 챗봇이 읽는다 */
      });
  }

  // 삼천포신항-제주항 구간은 카카오가 통짜로 계산 못 하므로(위 shouldForceSamcheonpoRoute 주석
  // 참고) ①출발지→삼천포신항, ②제주항→목적지 두 번의 육로 길찾기를 따로 불러 합친다.
  // 중간에 사용자가 추가한 경유지(있다면)는 승선 전(육지) 구간에 속하는 것으로 보고 ① 쪽에 붙인다.
  function fetchSplitSamcheonpoDirections(points, requestId) {
    var coord = function (p) { return p.latlng.getLng() + ',' + p.latlng.getLat(); };
    var origin = points[0];
    var destination = points[points.length - 1];
    var beforeWaypoints = points.slice(1, -1);

    var legAParams = new URLSearchParams();
    legAParams.set('origin', coord(origin));
    legAParams.set('destination', SAMCHEONPO_PORT_LATLNG.lng + ',' + SAMCHEONPO_PORT_LATLNG.lat);
    legAParams.set('priority', 'RECOMMEND');
    if (beforeWaypoints.length) legAParams.set('waypoints', beforeWaypoints.map(coord).join('|'));

    var legBParams = new URLSearchParams();
    legBParams.set('origin', JEJU_PORT_LATLNG.lng + ',' + JEJU_PORT_LATLNG.lat);
    legBParams.set('destination', coord(destination));
    legBParams.set('priority', 'RECOMMEND');

    setRouteError(null, null);
    Promise.all([
      fetchDirections('/kakao/directions?' + legAParams.toString()),
      fetchDirections('/kakao/directions?' + legBParams.toString()),
    ]).then(function (results) {
      if (requestId !== directionsRequestId) return;
      var legA = results[0];
      var legB = results[1];

      var ferryDistanceM = haversineKm(
        [SAMCHEONPO_PORT_LATLNG.lat, SAMCHEONPO_PORT_LATLNG.lng],
        [JEJU_PORT_LATLNG.lat, JEJU_PORT_LATLNG.lng]
      ) * 1000;
      // 기본요금(거리구간요금)은 도선 구간을 제외한 육로 거리만으로 계산해야 한다 — 도선료는
      // ferryFare.js가 별도 정액으로 더한다.
      var totalRoadKm = (legA.totalDistance + legB.totalDistance) / 1000;
      var totalDuration = legA.totalDuration + SAMCHEONPO_JEJU_FERRY_DURATION_S + legB.totalDuration;

      setAiRouteMeta({
        hasFerryLeg: true,
        ferryLegs: [{ synthetic: true, fromPort: '삼천포신항', toPort: '제주항' }],
        ferrySegments: {
          fromPort: '삼천포신항',
          toPort: '제주항',
          beforeDistanceM: legA.totalDistance,
          beforeDurationS: legA.totalDuration,
          ferryDistanceM: ferryDistanceM,
          ferryDurationS: SAMCHEONPO_JEJU_FERRY_DURATION_S,
          afterDistanceM: legB.totalDistance,
          afterDurationS: legB.totalDuration,
        },
      });

      var fullPath = [];
      if (legA.path) fullPath = fullPath.concat(legA.path.map(function (c) { return new kakao.maps.LatLng(c[0], c[1]); }));
      fullPath.push(new kakao.maps.LatLng(SAMCHEONPO_PORT_LATLNG.lat, SAMCHEONPO_PORT_LATLNG.lng));
      fullPath.push(new kakao.maps.LatLng(JEJU_PORT_LATLNG.lat, JEJU_PORT_LATLNG.lng));
      if (legB.path) fullPath = fullPath.concat(legB.path.map(function (c) { return new kakao.maps.LatLng(c[0], c[1]); }));
      if (fullPath.length > 1) drawPolyline(fullPath);

      renderDistanceRows(points, []);
      renderRouteSummary(totalRoadKm, totalDuration, (legA.tollFare || 0) + (legB.tollFare || 0), {
        mode: (legA.usedFuture || legB.usedFuture) ? 'future' : 'current',
      });
    }).catch(function (e) {
      if (requestId !== directionsRequestId) return;
      setAiRouteMeta({ hasFerryLeg: false, ferryLegs: [], ferrySegments: null });
      setRouteError('삼천포-제주 경로탐색', (e && e.message) || '알 수 없는 오류');
      /* 화면은 직선거리 fallback 유지 — 사유는 위에 남겨 챗봇이 읽는다 */
    });
  }

  // 마커/경로선/구간별 거리를 현재 입력 상태에 맞춰 다시 그린다.
  // 우선 직선거리로 즉시 표시하고, 카카오모빌리티 길찾기(유료 API) 응답이 오면 실제 도로 경로/거리로 교체한다.
  function refreshMapView() {
    var distanceInfo = document.getElementById('mapDistanceInfo');

    var points = [];
    getOrderedSlots().forEach(function (slot) {
      if (markers[slot]) points.push({ slot: slot, latlng: markers[slot].getPosition() });
    });

    directionsRequestId += 1;

    if (points.length === 0) { if (routeLine) { routeLine.setMap(null); routeLine = null; } distanceInfo.style.display = 'none'; return; }
    if (points.length === 1) {
      if (routeLine) { routeLine.setMap(null); routeLine = null; }
      map.setCenter(points[0].latlng);
      map.setLevel(5);
      distanceInfo.style.display = 'none';
      return;
    }

    drawPolyline(points.map(function (p) { return p.latlng; }));
    var straightKm = [];
    for (var i = 0; i < points.length - 1; i++) {
      straightKm.push(haversineKm(
        [points[i].latlng.getLat(), points[i].latlng.getLng()],
        [points[i + 1].latlng.getLat(), points[i + 1].latlng.getLng()]
      ));
    }
    renderDistanceRows(points, straightKm);
    var straightTotal = straightKm.reduce(function (a, b) { return a + b; }, 0);
    setAiRouteMeta({ hasFerryLeg: false, ferryLegs: [], ferrySegments: null });
    renderRouteSummary(straightTotal, null, null, { mode: 'straight' });

    var bounds = new kakao.maps.LatLngBounds();
    points.forEach(function (p) { bounds.extend(p.latlng); });
    map.setBounds(bounds);

    if (points.length >= 2 && shouldForceSamcheonpoRoute()) {
      fetchSplitSamcheonpoDirections(points, directionsRequestId);
      return;
    }
    fetchRealDirections(points, directionsRequestId);
  }

  function wireReservationTimeChange(el) {
    if (!el) return;
    el.addEventListener('change', function () {
      refreshMapView();
      syncReservationBasisPreview();
    });
  }

  function wireReservationDateChange(el) {
    if (!el) return;
    el.addEventListener('change', function () {
      syncReservedDateField();
      refreshMapView();
      syncReservationBasisPreview();
    });
  }

  wireReservationDateChange(reservedDateYearSelect);
  wireReservationDateChange(reservedDateMonthSelect);
  wireReservationDateChange(reservedDateDaySelect);
  wireReservationTimeChange(reservedDateInputForRoute);
  wireReservationTimeChange(reservedTimeInputForRoute);
  wireReservationTimeChange(reservedTimeHourSelect);
  wireReservationTimeChange(reservedTimeMinuteSelect);
  if (reservationBasisImmediate) reservationBasisImmediate.addEventListener('change', syncReservationBasisPreview);
  if (reservationBasisPickup) reservationBasisPickup.addEventListener('change', syncReservationBasisPreview);
  if (reservationBasisDelivery) reservationBasisDelivery.addEventListener('change', syncReservationBasisPreview);
  if (form) {
    form.addEventListener('submit', function (e) {
      syncReservedDateField();
      syncReservationBasisPreview();
      if (isDeliveryReservationBasis() && (!pickupReservedDateInput || !pickupReservedDateInput.value || !pickupReservedTimeInput || !pickupReservedTimeInput.value)) {
        e.preventDefault();
        alert('도착지 인도시간 기준은 경로가 확정되어야 출발지 픽업일시를 계산할 수 있습니다. 출발지와 도착지를 확인한 뒤 다시 시도해주세요.');
      }
    });
  }
  syncReservationBasisPreview();

  function wireMapViewBtn(btn) {
    btn.addEventListener('click', function () {
      var slot = btn.dataset.slot;
      if (markers[slot]) {
        map.setCenter(markers[slot].getPosition());
        map.setLevel(4);
      }
    });
  }
  document.querySelectorAll('.map-view-btn').forEach(wireMapViewBtn);
  var mapShowAllBtn = document.getElementById('mapShowAllBtn');
  if (mapShowAllBtn) mapShowAllBtn.addEventListener('click', refreshMapView);

  // 반환하는 Promise는 좌표/행정구역 hidden input이 실제로 채워진 뒤에 resolve된다(콜마너
  // 연동에 필요 — resolveRegionAndFill 주석 참고). 클릭/blur로 호출하는 곳(selectResult,
  // handleAddressBlur)은 반환값을 기다리지 않아도 되지만(사용자가 바로 제출하기까지 시간차가
  // 있음), __aiIntakeResolveAddress는 이 Promise를 반드시 이어받아 기다린다.
  function applyResult(r, mainInput, detailInput, slot, kind, preview) {
    mainInput.value = mainAddressOf(r);
    if (detailInput) {
      detailInput.disabled = false;
      detailInput.style.display = '';
      if (r.type === 'place') detailInput.value = r.place_name;
      else { detailInput.value = ''; detailInput.focus(); }
    }
    if (preview) preview.textContent = resultLabel(r);
    if (r.lat && r.lon) {
      placeMarker(slot, kind, [parseFloat(r.lat), parseFloat(r.lon)]);
      return resolveRegionAndFill(slot, kind, parseFloat(r.lat), parseFloat(r.lon));
    }
    return Promise.resolve();
  }

  function handleAddressBlur(input, detailInput, slot, kind) {
    if (input.dataset.skipGeocode === '1') return;
    var q = input.value.trim();
    if (q.length < MIN_ADDRESS_QUERY_LENGTH) return;
    var preview = document.getElementById(slot + 'Preview');
    if (preview) preview.textContent = '위치 확인 중...';
    geocode(q, function (results) {
      var best = results[0];
      if (!best) {
        if (preview) preview.textContent = '위치를 찾을 수 없습니다 (직접 확인 필요)';
        return;
      }
      if (preview) preview.textContent = resultLabel(best);
      if (best.lat && best.lon) {
        placeMarker(slot, kind, [parseFloat(best.lat), parseFloat(best.lon)]);
        resolveRegionAndFill(slot, kind, parseFloat(best.lat), parseFloat(best.lon));
      }
    });
  }

  // baseId: 'origin_address' | 'destination_address' (kind=origin/destination) 또는 'waypoint_N' (kind=waypoint)
  function wireAddressField(baseId, kind) {
    var mainId = (kind === 'waypoint') ? baseId + '_address' : baseId;
    var mainInput = document.getElementById(mainId);
    var detailInput = document.getElementById(detailIdFor(mainId));
    var resultsEl = document.getElementById(mainId + '_results');
    var slot = (kind === 'waypoint') ? baseId : (kind === 'origin' ? 'origin' : 'destination');
    var searchTimer = null;

    function clearResults() {
      resultsEl.innerHTML = '';
    }

    function selectResult(r) {
      applyResult(r, mainInput, detailInput, slot, kind, document.getElementById(slot + 'Preview'));
      clearResults();
    }

    function appendHighlightedText(element, text, query) {
      var label = String(text || '');
      var normalizedLabel = label.toLocaleLowerCase();
      var normalizedQuery = String(query || '').toLocaleLowerCase();
      var fromIndex = 0;
      var matchIndex = normalizedLabel.indexOf(normalizedQuery, fromIndex);

      while (matchIndex !== -1) {
        element.appendChild(document.createTextNode(label.slice(fromIndex, matchIndex)));
        var highlight = document.createElement('span');
        highlight.className = 'addr-result-match';
        highlight.textContent = label.slice(matchIndex, matchIndex + normalizedQuery.length);
        element.appendChild(highlight);
        fromIndex = matchIndex + normalizedQuery.length;
        matchIndex = normalizedLabel.indexOf(normalizedQuery, fromIndex);
      }
      element.appendChild(document.createTextNode(label.slice(fromIndex)));
    }

    function renderResults(results, query) {
      if (!results.length) {
        resultsEl.innerHTML = '<div class="addr-result-item muted">검색 결과가 없습니다.</div>';
        return;
      }
      resultsEl.innerHTML = '';
      results.slice(0, ADDRESS_RESULT_LIMIT).forEach(function (r) {
        var item = document.createElement('div');
        item.className = 'addr-result-item';
        appendHighlightedText(item, resultLabel(r), query);
        item.addEventListener('click', function () { selectResult(r); });
        resultsEl.appendChild(item);
      });
    }

    function searchAddress(showLoading) {
      var q = mainInput.value.trim();
      if (q.length < MIN_ADDRESS_QUERY_LENGTH) {
        clearResults();
        return;
      }
      if (showLoading) resultsEl.innerHTML = '<div class="addr-result-item muted">검색 중...</div>';
      geocode(q, function (results) {
        // 입력값이 바뀐 뒤 도착한 이전 검색 결과는 표시하지 않는다.
        if (mainInput.value.trim() !== q) return;
        renderResults(results, q);
      });
    }

    var searchBtn = document.querySelector('.addr-search-btn[data-target="' + mainId + '"]');
    if (searchBtn) {
      searchBtn.addEventListener('click', function () {
        searchAddress(true);
      });
    }

    mainInput.addEventListener('input', function () {
      if (mainInput.dataset.skipGeocode === '1') return;
      clearTimeout(searchTimer);
      if (mainInput.value.trim().length < MIN_ADDRESS_QUERY_LENGTH) {
        clearResults();
        return;
      }
      searchTimer = setTimeout(function () { searchAddress(true); }, 250);
    });

    mainInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (searchBtn && searchBtn.style.display !== 'none') searchBtn.click();
      }
    });

    mainInput.addEventListener('blur', function () {
      setTimeout(function () { handleAddressBlur(mainInput, detailInput, slot, kind); }, 150);
    });
  }

  wireAddressField('origin_address', 'origin');
  wireAddressField('destination_address', 'destination');

  // 제주항/서귀포 등 제주 지역 도착은 도선료 계산에 차종이 사실상 필수이므로, 도착지 주소에
  // "제주"가 들어가면 차종 입력을 필수로 표시한다(빨간 별표 + "선택"→"필수" 라벨 전환).
  function updateVehicleTypeRequirement() {
    var destInput = document.getElementById('destination_address');
    if (!destInput || !vehicleTypeInput) return;
    var isJeju = /제주/.test(destInput.value || '');
    vehicleTypeInput.required = isJeju;
    var mark = document.getElementById('vehicleTypeRequiredMark');
    if (mark) mark.style.display = isJeju ? '' : 'none';
    var optionalText = document.getElementById('vehicleTypeOptionalText');
    if (optionalText) optionalText.textContent = isJeju ? '필수' : '선택';
  }
  var destAddressForVehicleReq = document.getElementById('destination_address');
  if (destAddressForVehicleReq) {
    destAddressForVehicleReq.addEventListener('input', updateVehicleTypeRequirement);
  }
  updateVehicleTypeRequirement();
  // ai-intake.js는 챗봇이 파싱한 도착지 값을 .value에 직접 대입만 하고 'input' 이벤트는 안 띄운다
  // (여기서 'input'을 그대로 흉내내면 wireAddressField의 지명 검색 드롭다운까지 자동으로 열려버려서
  // 안 된다) — 그래서 이 판단 함수만 따로 전역에 노출해 ai-intake.js가 직접 불러 쓰게 한다.
  window.__updateVehicleTypeRequirement = updateVehicleTypeRequirement;

  // 차종 입력칸 자동완성 — 주소 자동완성(.addr-results)과 같은 시각 패턴을 재사용해서, 1글자만
  // 입력해도 ferry_fare_rules에 등록된 실제 차종 별칭 중 일치하는 것을 보여준다. 정확한 차종명을
  // 고르게 해서 도선료 매칭 실패(스펠링 불일치)를 애초에 줄이는 목적도 겸한다.
  function wireVehicleTypeAutocomplete(inputEl, resultsEl) {
    if (!inputEl || !resultsEl) return;
    var searchTimer = null;
    var requestId = 0;

    function clearResults() { resultsEl.innerHTML = ''; }

    function renderSuggestions(suggestions, query) {
      if (!suggestions.length) {
        resultsEl.innerHTML = '<div class="addr-result-item muted">일치하는 차종이 없습니다.</div>';
        return;
      }
      resultsEl.innerHTML = '';
      suggestions.forEach(function (label) {
        var item = document.createElement('div');
        item.className = 'addr-result-item';
        var normalizedLabel = label.toLocaleLowerCase();
        var normalizedQuery = query.toLocaleLowerCase();
        var matchIndex = normalizedLabel.indexOf(normalizedQuery);
        if (matchIndex === -1) {
          item.textContent = label;
        } else {
          item.appendChild(document.createTextNode(label.slice(0, matchIndex)));
          var highlight = document.createElement('span');
          highlight.className = 'addr-result-match';
          highlight.textContent = label.slice(matchIndex, matchIndex + query.length);
          item.appendChild(highlight);
          item.appendChild(document.createTextNode(label.slice(matchIndex + query.length)));
        }
        item.addEventListener('mousedown', function (e) {
          // blur보다 먼저 선택을 처리하기 위해 click 대신 mousedown에서 값을 채운다.
          e.preventDefault();
          inputEl.value = label;
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          clearResults();
        });
        resultsEl.appendChild(item);
      });
    }

    inputEl.addEventListener('input', function () {
      clearTimeout(searchTimer);
      var q = inputEl.value.trim();
      if (!q) { clearResults(); return; }
      searchTimer = setTimeout(function () {
        var myRequestId = (requestId += 1);
        fetch('/orders/vehicle-type-suggest?q=' + encodeURIComponent(q))
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (myRequestId !== requestId) return;
            if (inputEl.value.trim() !== q) return;
            renderSuggestions((data && data.suggestions) || [], q);
          })
          .catch(function () {});
      }, 200);
    });

    inputEl.addEventListener('blur', function () {
      setTimeout(clearResults, 150);
    });
  }
  wireVehicleTypeAutocomplete(vehicleTypeInput, document.getElementById('vehicle_type_results'));

  // "주차장/입구/정문" 같은 범용 시설어가 붙으면 카카오 키워드 검색이 그 단어를 업종 필터처럼
  // 취급해 정작 중요한 지명(예: "수서역이마트")을 무시하고 엉뚱한 곳을 1위로 주는 경우가 실측으로 확인됐다.
  // 이런 단어가 있을 때만 원문/핵심지명 두 가지로 검색해서 1위가 다르면 챗봇이 사용자에게 확인받는다.
  var GENERIC_LOCATION_SUFFIX = /(주차장|입구|정문|후문|앞|근처|건너편|맞은편)\s*$/;
  function stripGenericSuffix(query) {
    return query.replace(GENERIC_LOCATION_SUFFIX, '').trim();
  }
  function extractGenericSuffix(query) {
    var m = String(query || '').trim().match(GENERIC_LOCATION_SUFFIX);
    return m ? m[1] : '';
  }
  function appendDetailToken(detailInput, token) {
    var t = String(token || '').trim();
    if (!detailInput || !t) return '';
    detailInput.disabled = false;
    var current = String(detailInput.value || '').trim();
    if (!current) {
      detailInput.value = t;
      return detailInput.value;
    }
    if (current.indexOf(t) !== -1) return current;
    detailInput.value = current + ' ' + t;
    return detailInput.value;
  }
  function buildResolvedText(baseLabel, detailValue) {
    var label = String(baseLabel || '').trim();
    var detail = String(detailValue || '').trim();
    if (!detail || !label) return label || detail;
    if (label.indexOf(detail) !== -1) return label;

    // place_name이 이미 label 앞부분에 들어간 경우에는 중복 접두어를 제거하고 나머지만 붙인다.
    var extra = detail;
    var sepIdx = label.indexOf(' · ');
    var placePart = sepIdx >= 0 ? label.slice(0, sepIdx).trim() : label;
    if (placePart && extra.indexOf(placePart) === 0) extra = extra.slice(placePart.length).trim();
    if (!extra) return label;
    return label + ' ' + extra;
  }
  function sameSpot(a, b) {
    return !!a && !!b && a.lat === b.lat && a.lon === b.lon;
  }

  function normalizeSearchText(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[()\[\],.·]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenizeSearchText(text) {
    return normalizeSearchText(text)
      .split(' ')
      .map(function (token) { return token.trim(); })
      .filter(function (token) { return token.length >= 2; });
  }

  function scoreAddressCandidateMatch(query, result) {
    var tokens = tokenizeSearchText(query);
    if (!tokens.length || !result) return { matched: 0, total: tokens.length, ratio: 0 };

    var haystack = normalizeSearchText([
      result.place_name || '',
      result.road_address || '',
      result.jibun_address || '',
    ].join(' '));

    var matched = 0;
    tokens.forEach(function (token) {
      if (haystack.indexOf(token) !== -1) matched += 1;
    });

    return {
      matched: matched,
      total: tokens.length,
      ratio: tokens.length ? (matched / tokens.length) : 0,
    };
  }

  function shouldAutoConfirmPrimaryCandidate(query, primary, secondary) {
    if (!primary) return false;
    if (!secondary) return true;

    var primaryScore = scoreAddressCandidateMatch(query, primary);
    var secondaryScore = scoreAddressCandidateMatch(query, secondary);

    if (primaryScore.matched >= 2 && primaryScore.ratio >= 0.75 && secondaryScore.ratio < primaryScore.ratio) {
      return true;
    }
    if (primary.type === 'address' && primaryScore.ratio >= 0.6 && secondary.type === 'place' && primaryScore.matched > secondaryScore.matched) {
      return true;
    }
    return false;
  }

  function extractDetailHintFromQuery(query) {
    var raw = String(query || '').trim();
    if (!raw) return '';
    var parts = raw.split(',');
    if (parts.length >= 2) return parts.slice(1).join(' ').trim();
    return '';
  }

  function looksLikeDetailToken(text) {
    var t = String(text || '').trim();
    if (!t) return false;
    if (t.length > 60) return false;
    if (/(\d+층|\d+호|\d+동|지하\s*\d+|B\d+|정문|후문|입구|주차장|상가|오피스텔|아파트|타워|센터|빌딩)/i.test(t)) return true;
    // 상세주소는 보통 전체 행정주소(시/군/구/로/길)보다는 보조 식별자라서, 행정주소 토큰만 있는 경우는 제외한다.
    if (!/(시|군|구|로|길|번길)/.test(t) && /[가-힣A-Za-z0-9]/.test(t)) return true;
    return false;
  }

  function removeKnownToken(base, token) {
    var text = String(base || '');
    var key = String(token || '').trim();
    if (!text || !key) return text;
    // place_name · 도로명주소 형태의 라벨을 그대로 치환해도 되도록, 원문 그대로 한 번 지운다.
    text = text.replace(key, ' ');
    // 카카오 API가 돌려주는 도로명/지번주소는 "경기도"가 아니라 "경기"처럼 시/도 접미사가 없이
    // 오는 경우가 흔한데, 사용자가 원문에 "경기도"처럼 접미사를 붙여 입력하면 문자열이 정확히
    // 일치하지 않아 안 지워지고 도로명주소 전체가 그대로 상세주소에 중복으로 남는 문제가 있었다
    // — 첫 단어(시/도명) 뒤에 흔한 행정구역 접미사를 선택적으로 허용해 한 번 더 시도한다.
    var words = key.split(/\s+/).filter(Boolean);
    if (words.length) {
      var escapeWord = function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
      var pattern = escapeWord(words[0]) + '(?:도|특별시|광역시|특별자치도|특별자치시)?';
      for (var i = 1; i < words.length; i++) pattern += '\\s*' + escapeWord(words[i]);
      try {
        text = text.replace(new RegExp(pattern, 'gi'), ' ');
      } catch (e) {
        // 정규식 실패 시 무시하고 다음 시도로 넘어간다.
      }
    }
    // 가운데 공백/구두점 차이로 exact match가 안 되는 경우를 위해 공백을 느슨하게 한 번 더 시도한다.
    var escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var relaxed = escaped.replace(/\s+/g, '\\s*');
    try {
      text = text.replace(new RegExp(relaxed, 'gi'), ' ');
    } catch (e) {
      // 정규식 실패 시 원문 치환 결과만 사용한다.
    }
    return text;
  }

  function extractDetailHintFromResolved(query, best) {
    var raw = String(query || '').trim();
    if (!raw || !best) return extractDetailHintFromQuery(raw);

    var detailByComma = extractDetailHintFromQuery(raw);
    if (detailByComma) return detailByComma;

    var remained = raw;
    var tokens = [
      resultLabel(best),
      mainAddressOf(best),
      best.place_name || '',
      best.road_address || '',
      best.jibun_address || '',
    ].filter(Boolean);

    tokens.forEach(function (token) {
      remained = removeKnownToken(remained, token);
    });

    remained = remained
      .replace(/[()\[\]]/g, ' ')
      .replace(/[·]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return looksLikeDetailToken(remained) ? remained : '';
  }

  // AI 접수 화면에서 파싱된 주소를 검색 결과 1순위로 자동 확정할 때 사용 (일반 오더 등록 화면에서는 미사용)
  // 챗봇이 확인 메시지를 띄울 수 있도록 { success, resolvedText } 형태로 결과를 돌려준다.
  // 검색어가 모호한 경우(위 GENERIC_LOCATION_SUFFIX)이면서 실제로 결과가 갈리면
  // { success:false, ambiguous:true, candidates:[...] } 형태로 후보 2개를 돌려준다.
  window.__aiIntakeResolveAddress = function (mainId, kind, onStatus) {
    var mainInput = document.getElementById(mainId);
    if (!mainInput || !mainInput.value.trim()) return Promise.resolve({ success: false, resolvedText: null });
    var detailInput = document.getElementById(detailIdFor(mainId));
    var slot = (kind === 'waypoint') ? mainId.replace('_address', '') : (kind === 'origin' ? 'origin' : 'destination');
    var query = mainInput.value.trim();

    // searchedQuery: 오타 보정 재검색(예: "알파동타워"→"알파돔타워")으로 찾은 결과일 때는, 남은
    // 상세주소 힌트를 원문(query)이 아니라 실제로 검색에 성공한 보정된 문구 기준으로 뽑아야 한다 —
    // 원문 그대로 쓰면 보정 전 오타 토큰이 best의 라벨과 매칭되지 않아 그대로 상세주소에 남는다.
    // 좌표/행정구역 조회(resolveRegionAndFill)는 여기서 기다리지 않는다 — 채팅 응답 체감속도를
    // 위해 fire-and-forget으로 보내고, pendingRegionResolutions에 쌓아뒀다가 실제 오더 제출
    // 직전에만 한꺼번에 기다린다(window.__aiIntakeWaitPendingRegions, ai-intake.js에서 호출).
    function confirmWith(best, detailToken, meta, searchedQuery) {
      if (!best) return { success: false, resolvedText: null };
      applyResult(best, mainInput, detailInput, slot, kind, document.getElementById(slot + 'Preview'));
      var detailHint = extractDetailHintFromResolved(searchedQuery || query, best);
      if (detailToken) appendDetailToken(detailInput, detailToken);
      if (detailHint) appendDetailToken(detailInput, detailHint);
      return {
        success: true,
        resolvedText: buildResolvedText(resultLabel(best), detailInput ? detailInput.value : ''),
        // 원문 검색이 0건이라 Gemini 보정 검색어로 재시도해서 찾은 결과인 경우, 챗봇이 그 과정을
        // 안내 말풍선으로 보여줄 수 있도록 원문/보정 검색어를 함께 돌려준다.
        triedFallback: !!(meta && meta.triedFallback),
        correctedQuery: (meta && meta.correctedQuery) || null,
      };
    }

    var stripped = stripGenericSuffix(query);
    var genericSuffix = extractGenericSuffix(query);
    var hasGenericSuffix = stripped.length >= 2 && stripped !== query;

    if (!hasGenericSuffix) {
      return new Promise(function (resolve) {
        geocodeWithMode(query, 'plain', function (results) {
          if (results.length) {
            resolve(confirmWith(results[0], '', { triedFallback: false, correctedQuery: null }));
            return;
          }
          if (onStatus) onStatus({ type: 'no_result', query: query });

          geocodeWithMode(query, 'correction', function (_ignore, correctionMeta) {
            var candidates = (correctionMeta && correctionMeta.candidates) || [];
            var retryCandidates = candidates.filter(function (c) { return c && c !== query; });
            if (retryCandidates.length && onStatus) onStatus({ type: 'retry_start', correctedQuery: retryCandidates[0] });

            var idx = 0;
            function tryNext() {
              if (idx >= retryCandidates.length) {
                if (onStatus) onStatus({ type: 'retry_exhausted', total: retryCandidates.length });
                resolve({ success: false, resolvedText: null, triedFallback: true, correctedQuery: retryCandidates[0] || null });
                return;
              }
              var candidate = retryCandidates[idx++];
              if (onStatus) {
                onStatus({
                  type: 'retry_attempt',
                  correctedQuery: candidate,
                  attempt: idx,
                  total: retryCandidates.length,
                });
              }
              geocodeWithMode(candidate, 'plain', function (candidateResults) {
                if (candidateResults.length) {
                  resolve(confirmWith(candidateResults[0], '', { triedFallback: true, correctedQuery: candidate }, candidate));
                  return;
                }
                tryNext();
              });
            }
            tryNext();
          });
        });
      });
    }

    // 두 검색(원문/부속어 제거)은 서로 결과가 의존하지 않는 독립적인 조회라, 콜백 안에 중첩해서
    // 순서대로 기다릴 필요가 없다 — 동시에 쏘고 둘 다 끝나면 비교하도록 바꿔서 왕복시간이
    // 곱연산되지 않고 더 느린 쪽 하나만큼만 걸리게 한다("~주차장/입구/앞" 등으로 끝나는 주소
    // 확인이 유독 느렸던 원인).
    return new Promise(function (resolve) {
      var fullResults = null;
      var strippedResults = null;
      var fullMeta = null;
      var strippedMeta = null;
      var pending = 2;
      function onBothDone() {
        pending -= 1;
        if (pending > 0) return;
        var fullTop = fullResults[0];
        var strippedTop = strippedResults[0];
        if (!fullTop && !strippedTop) { resolve({ success: false, resolvedText: null }); return; }
        if (!strippedTop || sameSpot(fullTop, strippedTop)) { resolve(confirmWith(fullTop, genericSuffix, fullMeta)); return; }
        if (!fullTop) { resolve(confirmWith(strippedTop, genericSuffix, strippedMeta)); return; }
        // 원문 그대로가 이미 카카오에 정식 등록된 장소명과 정확히 일치하면(예: "세종대학교 정문"이
        // 접미어가 붙은 별칭이 아니라 그 자체로 등록된 POI 이름) 접미어 제거는 불필요하다 — 핵심
        // 지명(stripped) 결과와 비교해서 갈릴지 말지 따질 것 없이 원문 결과로 바로 확정한다.
        // genericSuffix를 상세주소로 또 붙이면("...능동로 209 정문"처럼) place_name에 이미 있는
        // 단어가 중복되므로 빈 문자열로 넘긴다.
        if (fullTop.type === 'place' && normalizeSearchText(fullTop.place_name) === normalizeSearchText(query)) {
          resolve(confirmWith(fullTop, '', fullMeta));
          return;
        }
        if (shouldAutoConfirmPrimaryCandidate(stripped, strippedTop, fullTop)) {
          resolve(confirmWith(strippedTop, genericSuffix, strippedMeta));
          return;
        }
        // 핵심 지명(부속어 제거)만으로 검색한 결과가 대체로 더 신뢰할 만해서 1번으로 먼저 보여준다.
        resolve({
          success: false,
          ambiguous: true,
          candidates: [
            { result: strippedTop, label: resultLabel(strippedTop) },
            { result: fullTop, label: resultLabel(fullTop) },
          ],
        });
      }
      geocodeWithMode(query, 'plain', function (r, meta) { fullResults = r; fullMeta = meta; onBothDone(); });
      geocodeWithMode(stripped, 'plain', function (r, meta) { strippedResults = r; strippedMeta = meta; onBothDone(); });
    });
  };

  // 챗봇이 모호한 주소 후보 중 하나를 사용자로부터 확인받은 뒤 실제로 필드에 반영할 때 사용.
  // 좌표/행정구역 조회는 여기서도 기다리지 않는다(confirmWith와 동일한 이유 — pendingRegionResolutions
  // 참고, 제출 직전에만 기다림).
  window.__aiIntakeApplyCandidate = function (mainId, kind, candidateResult) {
    var mainInput = document.getElementById(mainId);
    if (!mainInput) return null;
    var detailInput = document.getElementById(detailIdFor(mainId));
    var slot = (kind === 'waypoint') ? mainId.replace('_address', '') : (kind === 'origin' ? 'origin' : 'destination');
    var query = mainInput.value;
    var genericSuffix = extractGenericSuffix(mainInput.value);
    applyResult(candidateResult, mainInput, detailInput, slot, kind, document.getElementById(slot + 'Preview'));
    var detailHint = extractDetailHintFromResolved(query, candidateResult);
    if (genericSuffix) appendDetailToken(detailInput, genericSuffix);
    if (detailHint) appendDetailToken(detailInput, detailHint);
    return buildResolvedText(resultLabel(candidateResult), detailInput ? detailInput.value : '');
  };

  // AI 챗봇이 전화번호 응답을 형식 검사 + 하이픈 포맷팅해서 확인 메시지를 만들 때 사용.
  window.__aiIntakeFormatPhone = function (raw) {
    var digits = String(raw || '').replace(/\D/g, '').slice(0, 11);
    var formatted = formatPhoneDigits(digits);
    return { formatted: formatted, valid: !!formatted && isValidPhone(formatted) };
  };

  // 좌표/행정구역 조회가 아직 끝나지 않은 채 폼이 제출되는 마지막 구멍을 막는다.
  // 챗봇 흐름(confirmAndSubmit)은 __aiIntakeWaitPendingRegions를 직접 호출하지만, AI 접수화면
  // 우측의 수동 "오더 등록" 버튼(views/orders/ai_intake.ejs)과 일반 오더 등록 폼의 제출 버튼은
  // 그 경로를 타지 않고 브라우저 기본 submit으로 바로 나가버려서, 진행 중인 조회가 있으면
  // origin_lat 등이 빈 채로 등록될 수 있었다(콜마너 연동 실패 원인).
  // form.submit()은 submit 이벤트를 다시 발생시키지 않으므로 무한 루프가 되지 않는다.
  // 오더 수정 화면처럼 좌표/행정구역이 이미 채워진 채로 열리는 경우에도 배지가 맞게 보이도록
  // 최초 1회 동기화한다(경유지 행은 동적으로 만들어질 때 resolveRegionAndFill이 갱신한다).
  updateGeoBadges('origin');
  updateGeoBadges('destination');

  var orderFormEl = document.getElementById('orderForm');
  if (orderFormEl) {
    orderFormEl.addEventListener('submit', function (e) {
      if (!pendingRegionResolutions.length) return;
      e.preventDefault();
      window.__aiIntakeWaitPendingRegions().then(function () { orderFormEl.submit(); });
    });
  }
})();
