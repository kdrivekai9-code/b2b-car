'use client';

import Script from 'next/script';
import { useEffect } from 'react';

// public/js/agent-presence.js를 useEffect로 이식 — 정적 <script>는 'beforeunload'에만
// 의존해 연결을 닫는데, Next App Router의 페이지 전환은 클라이언트 사이드 라우팅이라
// beforeunload가 안 뜬다(브라우저를 실제로 떠나지 않으므로). 이 컴포넌트는 AppShell 안에
// 있고 페이지마다 새로 렌더링되므로, useEffect의 cleanup 함수가 정확히 "이 페이지를
// 벗어날 때" 실행되어 legacy와 동일한 시점에 연결을 닫는다(좀비 SSE 연결 누적 방지,
// public/js/agent-presence.js L42-46 주석에 실측 기록된 문제).
function useAgentPresenceStream() {
  useEffect(() => {
    if (!window.EventSource) return;
    let lastCount = null;

    function updateBadge(count) {
      const badge = document.getElementById('agentCallBadge');
      if (!badge) return;
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }

    const es = new EventSource('/chat/agent-presence/stream');
    es.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (!data) return;
      if (data.type === 'needs_agent_count') {
        updateBadge(data.count);
        window.dispatchEvent(new CustomEvent('agent-needs-count', { detail: { count: data.count, initial: !!data.initial } }));
        if (!data.initial && lastCount !== null && data.count > lastCount && window.AgentAlertSound && window.AgentAlertSound.isEnabled()) {
          window.AgentAlertSound.play();
        }
        lastCount = data.count;
        return;
      }
      if (data.type === 'new_agent_call') {
        window.dispatchEvent(new CustomEvent('agent-call-alert', { detail: data }));
      }
    };

    return () => es.close();
  }, []);
}

export default function AgentPresenceScripts() {
  useAgentPresenceStream();
  return (
    <>
      <Script src="/js/agent-alert-sound.js" strategy="afterInteractive" />
      <Script src="/js/agent-browser-notify.js" strategy="afterInteractive" />
      <Script src="/js/agent-notification-center.js" strategy="afterInteractive" />
    </>
  );
}
