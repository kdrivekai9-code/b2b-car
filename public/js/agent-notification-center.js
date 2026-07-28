// 알림센터 — 두 부분으로 구성된다.
// (1) 우측 상단 토스트: 상담원 호출이 새로 발생하는 순간에만 잠깐 뜨는 팝업(기존 동작, 유지).
// (2) 우측 상단 벨 아이콘 + 클릭 시 열리는 패널: 모든 페이지에 항상 떠 있는 진입점으로,
//     맥OS 알림센터처럼 지금까지 온 알림 이력을 목록으로 보여준다(새로고침해도 서버에서 현재
//     대기 중인 상담을 다시 불러와 채운다 — 순수 인메모리라 완전한 이력은 아니지만, "지금 확인 안 된
//     것"은 항상 반영된다).
// SSE 연결은 agent-presence.js가 하나만 유지하고, 여기서는 커스텀 이벤트만 받아 그린다.
(function () {
  var MAX_ITEMS = 30;
  var notifications = []; // { sessionId, customerName, message, timestamp } — 최신이 앞

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  function formatTime(ts) {
    var d;
    if (typeof ts === 'number') {
      d = new Date(ts);
      var hh = d.getHours(), mm = d.getMinutes();
      var ampm = hh < 12 ? '오전' : '오후';
      var h12 = hh % 12 || 12;
      return ampm + ' ' + h12 + ':' + (mm < 10 ? '0' + mm : mm);
    }
    // 서버에서 온 'YYYY-MM-DD HH24:MI:SS'(KST) 문자열은 Date 파싱에 기대지 않고 정규식으로 시:분만 뽑는다
    // (Safari 등에서 비표준 날짜 문자열 파싱이 불안정한 걸 피하기 위해 — 이 프로젝트의 기존 관례).
    var m = String(ts || '').match(/(\d{1,2}):(\d{2})/);
    if (!m) return '';
    var hh2 = Number(m[1]), mm2 = m[2];
    var ampm2 = hh2 < 12 ? '오전' : '오후';
    var h122 = hh2 % 12 || 12;
    return ampm2 + ' ' + h122 + ':' + mm2;
  }

  // ---------------- 토스트(팝업) ----------------
  var toastContainer = document.createElement('div');
  toastContainer.id = 'agentNotifyCenter';
  document.body.appendChild(toastContainer);

  function renderToast(item) {
    var card = document.createElement('div');
    card.className = 'agent-notify-card';

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'agent-notify-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', '알림 닫기');
    closeBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      card.remove();
    });

    var name = document.createElement('div');
    name.className = 'agent-notify-name';
    name.textContent = item.customerName || '고객';

    var msg = document.createElement('div');
    msg.className = 'agent-notify-message';
    msg.textContent = item.message || '상담원 연결을 요청했습니다.';

    card.appendChild(closeBtn);
    card.appendChild(name);
    card.appendChild(msg);

    if (item.sessionId) {
      card.style.cursor = 'pointer';
      card.addEventListener('click', function () { window.location.href = '/chat/sessions/' + item.sessionId; });
    }

    toastContainer.appendChild(card);
    while (toastContainer.children.length > MAX_ITEMS) toastContainer.removeChild(toastContainer.firstElementChild);
    setTimeout(function () { if (card.parentNode) card.remove(); }, 15000);
  }

  // ---------------- 벨 아이콘 + 패널 ----------------
  var bellBtn = document.createElement('button');
  bellBtn.type = 'button';
  bellBtn.id = 'agentNotifyBellBtn';
  bellBtn.setAttribute('aria-label', '알림센터 열기');
  bellBtn.title = '알림센터';
  bellBtn.innerHTML = '🔔<span class="agent-notify-bell-badge" id="agentNotifyBellBadge" style="display:none"></span>';
  document.body.appendChild(bellBtn);

  var overlay = document.createElement('div');
  overlay.id = 'agentNotifyOverlay';
  document.body.appendChild(overlay);

  var panel = document.createElement('div');
  panel.id = 'agentNotifyPanel';
  panel.innerHTML =
    '<div class="agent-notify-panel-head">' +
      '<strong>알림센터</strong>' +
      '<button type="button" id="agentNotifyClearBtn" class="btn secondary small">모두 지우기</button>' +
    '</div>' +
    '<div class="agent-notify-panel-list" id="agentNotifyPanelList"></div>';
  document.body.appendChild(panel);

  var panelListEl = document.getElementById('agentNotifyPanelList');

  function renderPanel() {
    if (!notifications.length) {
      panelListEl.innerHTML = '<div class="agent-notify-panel-empty">새로운 알림이 없습니다.</div>';
      return;
    }
    var html = notifications.map(function (item) {
      return '<div class="agent-notify-panel-item" data-session-id="' + (item.sessionId || '') + '">' +
        '<div class="agent-notify-panel-item-head">' +
          '<span class="agent-notify-name">' + escapeHtml(item.customerName || '고객') + '</span>' +
          '<span class="agent-notify-panel-time">' + escapeHtml(formatTime(item.timestamp)) + '</span>' +
        '</div>' +
        '<div class="agent-notify-message">' + escapeHtml(item.message || '상담원 연결을 요청했습니다.') + '</div>' +
      '</div>';
    }).join('');
    panelListEl.innerHTML = html;
    Array.prototype.forEach.call(panelListEl.querySelectorAll('.agent-notify-panel-item'), function (row) {
      var sid = row.getAttribute('data-session-id');
      if (!sid) return;
      row.addEventListener('click', function () { window.location.href = '/chat/sessions/' + sid; });
    });
  }

  function updateBellBadge(count) {
    var badge = document.getElementById('agentNotifyBellBadge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  var panelOpen = false;
  function openPanel() { panelOpen = true; panel.classList.add('open'); overlay.classList.add('open'); }
  function closePanel() { panelOpen = false; panel.classList.remove('open'); overlay.classList.remove('open'); }
  bellBtn.addEventListener('click', function () { panelOpen ? closePanel() : openPanel(); });
  overlay.addEventListener('click', closePanel);
  document.getElementById('agentNotifyClearBtn').addEventListener('click', function () {
    notifications = [];
    renderPanel();
  });

  function addNotification(item) {
    notifications.unshift(item);
    if (notifications.length > MAX_ITEMS) notifications.length = MAX_ITEMS;
    renderPanel();
  }

  renderPanel();

  // 새로고침 직후에도 "지금 대기 중인" 상담을 패널에 바로 채워둔다(완전한 이력은 아니지만
  // 최소한 아직 처리 안 된 건은 항상 보이게).
  fetch('/chat/sessions/needs-agent-summary')
    .then(function (res) { return res.json(); })
    .then(function (data) {
      (data.sessions || []).forEach(function (s) {
        notifications.push({ sessionId: s.id, customerName: s.customer_name, message: s.message, timestamp: s.updated_at });
      });
      if (notifications.length > MAX_ITEMS) notifications.length = MAX_ITEMS;
      renderPanel();
    })
    .catch(function () {});

  window.addEventListener('agent-call-alert', function (e) {
    var data = e.detail || {};
    var item = { sessionId: data.sessionId, customerName: data.customerName, message: data.message, timestamp: Date.now() };
    renderToast(item);
    addNotification(item);
    if (window.AgentBrowserNotify) {
      window.AgentBrowserNotify.notify(
        (item.customerName || '고객') + ' · 상담원 호출',
        item.message || '상담원 연결을 요청했습니다.',
        item.sessionId
      );
    }
  });

  window.addEventListener('agent-needs-count', function (e) {
    updateBellBadge(e.detail ? e.detail.count : 0);
  });
})();
