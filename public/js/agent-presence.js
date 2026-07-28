// 관리자가 로그인해 있는 모든 페이지의 사이드바에서 이 연결을 유지해 "상담원 접속 중"으로 집계되게 한다
// (header.ejs에서 admin 역할에만 전역으로 불러온다). 같은 연결로 상담대기(needs_agent) 건수도 실시간
// 수신해 사이드바 "상담 관리" 배지를 갱신하고, 페이지 진입 후 새로 대기가 생기면 알림음도 재생한다.
(function () {
  if (!window.EventSource) return;
  var badge = document.getElementById('agentCallBadge');
  var lastCount = null;

  function updateBadge(count) {
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  var es = new EventSource('/chat/agent-presence/stream');
  es.onmessage = function (event) {
    var data;
    try { data = JSON.parse(event.data); } catch (e) { return; }
    if (!data) return;
    if (data.type === 'needs_agent_count') {
      updateBadge(data.count);
      // initial: 접속 직후 최초 동기화인지, 그 이후 실제 상담 목록 변경으로 온 신호인지 구분해서 넘겨준다 —
      // 상담관리 리스트/카드뷰가 이 신호를 "목록이 바뀌었다"는 뜻으로 재사용한다(별도 SSE 연결 없이).
      window.dispatchEvent(new CustomEvent('agent-needs-count', { detail: { count: data.count, initial: !!data.initial } }));
      if (!data.initial && lastCount !== null && data.count > lastCount && window.AgentAlertSound && window.AgentAlertSound.isEnabled()) {
        window.AgentAlertSound.play();
      }
      lastCount = data.count;
      return;
    }
    if (data.type === 'new_agent_call') {
      // 알림센터 팝업 렌더링은 별도 스크립트(agent-notification-center.js)가 담당 —
      // 연결은 이거 하나만 유지하고, 이벤트로 전달만 한다.
      window.dispatchEvent(new CustomEvent('agent-call-alert', { detail: data }));
    }
  };

  // EventSource는 페이지 이동(unload)만으로는 브라우저가 자동으로 끊어주지 않는다 — 명시적으로
  // close()하지 않으면 서버 쪽 연결이 계속 살아있는 채로 남는다. 페이지를 옮길 때마다 이 연결이
  // 새로 열리는데(모든 관리자 페이지에 로드됨) 정리를 안 해주면 옮겨다닐수록 좀비 연결이 쌓여서
  // 실제로 서버 DB(chat_agent_presence)에 연결이 무한정 누적되는 걸 확인했다 — 로컬처럼 브라우저
  // 호스트당 동시연결 수가 제한된 환경에서는 이게 다음 페이지 로딩 지연의 원인이 된다.
  window.addEventListener('beforeunload', function () { es.close(); });
})();
