// 실제 브라우저(OS) 알림 — Web Notification API. 탭이 백그라운드에 있거나 다른 창에 가려져 있어도
// OS 알림 배너로 뜬다(브라우저 프로세스 자체가 완전히 종료된 경우는 제외 — 그 경우는 별도의
// 웹 푸시 구독(/push/settings의 "오더 알림 설정")이 이미 처리하고 있다). 이 모듈은 상담원 호출
// 이벤트 전용으로, 권한 요청과 실제 알림 표시를 함께 담당하며 push_settings.ejs와 agent-notification-center.js가 공유한다.
window.AgentBrowserNotify = (function () {
  var STORAGE_ENABLED = 'agentAlert.browserNotify.v1';

  function supported() {
    return typeof window.Notification !== 'undefined';
  }
  function permission() {
    return supported() ? Notification.permission : 'unsupported';
  }
  function isEnabled() {
    if (!supported() || Notification.permission !== 'granted') return false;
    var v = localStorage.getItem(STORAGE_ENABLED);
    return v === null ? true : v === '1';
  }
  function setEnabled(on) {
    localStorage.setItem(STORAGE_ENABLED, on ? '1' : '0');
  }
  function requestPermission() {
    if (!supported()) return Promise.resolve('unsupported');
    return Notification.requestPermission();
  }

  // 관리자가 /push/settings에 따로 들어가 버튼을 누르지 않아도, 아무 페이지에서나 처음
  // 클릭/키입력하는 순간 브라우저 네이티브 허용 팝업이 자동으로 뜨도록 한다(기본 활성화 취지).
  // 다만 그 팝업 자체에서 "허용"을 누르는 건 여전히 사용자 몫이다 — 브라우저 보안 정책상
  // 자바스크립트만으로 권한을 스스로 "허용됨"으로 만들 수는 없다.
  if (supported() && Notification.permission === 'default') {
    var autoRequested = false;
    var tryAutoRequest = function () {
      if (autoRequested) return;
      autoRequested = true;
      requestPermission();
    };
    ['click', 'keydown', 'touchstart'].forEach(function (evt) {
      document.addEventListener(evt, tryAutoRequest, { once: true, passive: true });
    });
  }

  function notify(title, body, sessionId) {
    if (!isEnabled()) return;
    try {
      var n = new Notification(title, { body: body || '' });
      n.onclick = function () {
        window.focus();
        if (sessionId) window.location.href = '/chat/sessions/' + sessionId;
        n.close();
      };
    } catch (e) { /* 일부 환경(권한 미허용 등)에서 생성 자체가 실패할 수 있음 — 조용히 무시 */ }
  }

  return { supported: supported, permission: permission, isEnabled: isEnabled, setEnabled: setEnabled, requestPermission: requestPermission, notify: notify };
})();
