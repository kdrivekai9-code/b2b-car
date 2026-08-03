// 오더 리스트 컬럼 표시/순서/너비/행간격 커스터마이징 — 서버에 저장하지 않고 이 브라우저(localStorage)에만 저장한다.
(function () {
  var table = document.getElementById('ordersTable');
  if (!table) return;

  var COLUMN_LABELS = {
    oid: 'OID', branch: '지사', group: '요청 법인', group_phone: '대표번호',
    origin: '출발지', waypoints: '경유지', destination: '도착지', vehicle: '차량번호',
    driver: '기사정보', reserved_at: '예약일시', payment_method: '결제방식',
    fare: '요금', status: '상태', voc: 'VOC', photo: '사진', created_at: '등록일시',
  };
  var ALWAYS_VISIBLE = ['oid'];
  var DEFAULT_ORDER = ['oid', 'branch', 'group', 'group_phone', 'origin', 'waypoints', 'destination', 'vehicle', 'driver', 'reserved_at', 'payment_method', 'fare', 'status', 'voc', 'photo', 'created_at'];
  var DEFAULT_VISIBLE = ['oid', 'branch', 'group', 'group_phone', 'origin', 'destination', 'vehicle', 'reserved_at', 'payment_method', 'fare', 'status', 'created_at'];

  var STORAGE_KEY = 'orderList.columns.v1';
  var WIDTH_KEY = 'orderList.widths.v1';
  var DENSITY_KEY = 'orderList.density.v1';

  function loadState() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) { saved = null; }
    if (!saved || !saved.order || !saved.visible) {
      return { order: DEFAULT_ORDER.slice(), visible: DEFAULT_VISIBLE.slice() };
    }
    // 컬럼 키 변경(uid -> oid) 이전에 저장된 값이 있다면 그대로 이어받는다.
    ['order', 'visible'].forEach(function (listKey) {
      var i = saved[listKey].indexOf('uid');
      if (i !== -1) saved[listKey][i] = 'oid';
    });
    // 새로 추가된 컬럼(과거 저장값에 없던 키)은 목록 끝에 자동 포함시킨다.
    DEFAULT_ORDER.forEach(function (key) {
      if (saved.order.indexOf(key) === -1) saved.order.push(key);
    });
    return saved;
  }
  function saveState(state) { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

  function loadWidths() {
    try { return JSON.parse(localStorage.getItem(WIDTH_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveWidths(widths) { localStorage.setItem(WIDTH_KEY, JSON.stringify(widths)); }

  var state = loadState();
  var widths = loadWidths();

  function cellsForColumn(key) {
    return table.querySelectorAll('[data-column="' + key + '"]');
  }

  function applyOrder() {
    var thead = table.querySelector('thead tr');
    var rows = table.querySelectorAll('tbody tr');
    state.order.forEach(function (key) {
      var th = thead.querySelector('[data-column="' + key + '"]');
      if (th) thead.appendChild(th);
      rows.forEach(function (row) {
        var td = row.querySelector('[data-column="' + key + '"]');
        if (td) row.appendChild(td);
      });
    });
  }

  function applyVisibility() {
    Object.keys(COLUMN_LABELS).forEach(function (key) {
      var visible = state.visible.indexOf(key) !== -1;
      cellsForColumn(key).forEach(function (cell) { cell.style.display = visible ? '' : 'none'; });
    });
  }

  function applyWidths() {
    Object.keys(widths).forEach(function (key) {
      var th = table.querySelector('th[data-column="' + key + '"]');
      if (th) th.style.width = widths[key] + 'px';
    });
  }

  function applyDensity() {
    var density = localStorage.getItem(DENSITY_KEY) || 'normal';
    table.classList.remove('density-compact', 'density-comfortable');
    if (density === 'compact') table.classList.add('density-compact');
    if (density === 'comfortable') table.classList.add('density-comfortable');
  }

  function renderCheckboxes() {
    var wrap = document.getElementById('columnCheckboxes');
    if (!wrap) return;
    wrap.innerHTML = '';
    state.order.forEach(function (key) {
      var locked = ALWAYS_VISIBLE.indexOf(key) !== -1;
      var label = document.createElement('label');
      label.className = 'checkline';
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = state.visible.indexOf(key) !== -1;
      input.disabled = locked;
      input.addEventListener('change', function () {
        if (input.checked) { if (state.visible.indexOf(key) === -1) state.visible.push(key); }
        else { state.visible = state.visible.filter(function (k) { return k !== key; }); }
        saveState(state);
        applyVisibility();
      });
      label.appendChild(input);
      label.appendChild(document.createTextNode(' ' + COLUMN_LABELS[key] + (locked ? ' (고정)' : '')));
      wrap.appendChild(label);
    });
  }

  // ---------- 드래그로 컬럼 순서 변경 ----------
  function wireDragReorder() {
    var thead = table.querySelector('thead tr');
    var dragKey = null;
    thead.querySelectorAll('th').forEach(function (th) {
      th.draggable = true;
      th.addEventListener('dragstart', function () { dragKey = th.dataset.column; th.classList.add('dragging'); });
      th.addEventListener('dragend', function () { th.classList.remove('dragging'); });
      th.addEventListener('dragover', function (e) { e.preventDefault(); });
      th.addEventListener('drop', function (e) {
        e.preventDefault();
        var targetKey = th.dataset.column;
        if (!dragKey || dragKey === targetKey) return;
        var order = state.order.filter(function (k) { return k !== dragKey; });
        var idx = order.indexOf(targetKey);
        order.splice(idx, 0, dragKey);
        state.order = order;
        saveState(state);
        applyOrder();
        renderCheckboxes();
      });
    });
  }

  // ---------- 헤더 오른쪽 경계 드래그로 너비 변경 ----------
  function wireResize() {
    var thead = table.querySelector('thead tr');
    thead.querySelectorAll('th').forEach(function (th) {
      var handle = document.createElement('span');
      handle.className = 'col-resize-handle';
      th.style.position = 'relative';
      th.appendChild(handle);
      var startX, startWidth;
      handle.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        startX = e.clientX;
        startWidth = th.offsetWidth;
        function onMove(ev) {
          var newWidth = Math.max(50, startWidth + (ev.clientX - startX));
          th.style.width = newWidth + 'px';
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          widths[th.dataset.column] = th.offsetWidth;
          saveWidths(widths);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }

  // ---------- 헤더 클릭으로 오름차순/내림차순 정렬 ----------
  var NUMERIC_COLUMNS = ['oid', 'fare', 'photo'];
  var sortState = { key: null, dir: null };

  function extractSortValue(td, key) {
    var text = (td ? td.textContent : '') || '';
    text = text.trim();
    if (NUMERIC_COLUMNS.indexOf(key) !== -1) {
      var digits = text.replace(/[^0-9]/g, '');
      return digits ? Number(digits) : 0;
    }
    return text;
  }

  // 기본 상태는 회색 양방향 아이콘(정렬 가능함을 알림), 클릭해서 활성화된 컬럼만 빨간색 단일 방향 아이콘으로 바뀐다.
  function updateSortIcons() {
    table.querySelectorAll('thead th .sort-icon').forEach(function (icon) {
      var key = icon.closest('th').dataset.column;
      if (key === sortState.key) {
        icon.textContent = sortState.dir === 'asc' ? ' ▲' : ' ▼';
        icon.classList.add('sort-icon-active');
      } else {
        icon.textContent = ' ⇅';
        icon.classList.remove('sort-icon-active');
      }
    });
  }

  function sortRows(key, dir) {
    var tbody = table.querySelector('tbody');
    var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr')).filter(function (r) { return !r.querySelector('.empty'); });
    if (!rows.length) return;
    var numeric = NUMERIC_COLUMNS.indexOf(key) !== -1;
    rows.sort(function (a, b) {
      var va = extractSortValue(a.querySelector('[data-column="' + key + '"]'), key);
      var vb = extractSortValue(b.querySelector('[data-column="' + key + '"]'), key);
      var cmp = numeric ? (va - vb) : String(va).localeCompare(String(vb), 'ko');
      return dir === 'asc' ? cmp : -cmp;
    });
    rows.forEach(function (r) { tbody.appendChild(r); });
  }

  function wireSort() {
    var thead = table.querySelector('thead tr');
    thead.querySelectorAll('th').forEach(function (th) {
      var icon = document.createElement('span');
      icon.className = 'sort-icon';
      th.appendChild(icon);
      th.addEventListener('click', function (e) {
        // 헤더 순서 드래그, 너비 리사이즈 핸들 조작과는 별개 동작 — 리사이즈 핸들 위 클릭은 정렬을 건드리지 않는다.
        if (e.target.closest('.col-resize-handle')) return;
        var key = th.dataset.column;
        sortState.dir = (sortState.key === key && sortState.dir === 'asc') ? 'desc' : 'asc';
        sortState.key = key;
        sortRows(key, sortState.dir);
        updateSortIcons();
      });
    });
    updateSortIcons();
  }

  // ---------- 설정 패널 토글 / 행간격 / 초기화 ----------
  var settingsBtn = document.getElementById('columnSettingsBtn');
  var panel = document.getElementById('columnSettingsPanel');
  if (settingsBtn && panel) {
    settingsBtn.addEventListener('click', function () {
      panel.style.display = panel.style.display === 'none' ? '' : 'none';
    });
  }
  document.querySelectorAll('.row-density-buttons [data-density]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      localStorage.setItem(DENSITY_KEY, btn.dataset.density);
      applyDensity();
    });
  });
  var resetBtn = document.getElementById('columnResetBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(WIDTH_KEY);
      localStorage.removeItem(DENSITY_KEY);
      window.location.reload();
    });
  }

  applyOrder();
  applyVisibility();
  applyWidths();
  applyDensity();
  renderCheckboxes();
  wireDragReorder();
  wireResize();
  wireSort();
})();
