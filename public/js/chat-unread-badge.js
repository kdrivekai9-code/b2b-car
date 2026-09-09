// 안읽음 배지 — 역할에 따라 **세는 방향과 붙는 자리가 다르다**.
//
//   고객·기사 등: 내게 온 통보·상담원 답장을 내가 안 읽음(/chat/unread.json)
//                 → 'AI 챗봇' 메뉴, 챗봇 화면 상단
//   관리자:       고객이 보낸 말을 상담원이 안 읽음(/chat/agent-unread.json)
//                 → '상담 관리' 메뉴 (좌측 대화 카드는 서버가 그린다)
//
// 관리자에게 고객용 숫자를 붙였던 적이 있는데(2026-09-09 낮), 그건 관리자 **본인**이 챗봇으로
// 받은 통보를 센 것이라 상담 업무와 상관이 없었다. 사용자 확정: 관리자 배지는 상담 관리에.
//
// 왜 필요한가(실사용 지적 2026-09-08): 통보는 상담창에 꽂히는데, 창을 열지 않으면 도착한
// 줄을 모른다. 카카오는 앱 알림이 저절로 뜨는 반면 웹은 아무 표시가 없어서, 고객이 배차
// 통보를 받았다는 사실 자체를 인지할 수 없었다.
//
// 세는 규칙은 서버 한 곳에서만 정한다(routes/chat.js /unread.json) — 통보와 상담원 답장만.
// 클라이언트가 따로 세면 자리마다 숫자가 갈린다.
(function () {
  'use strict';

  // 이 스크립트는 모든 페이지에 실려 있다. 로그인 화면 같은 곳에서는 조용히 아무것도 안 한다.
  //
  // 역할은 메뉴로 가른다 — '상담 관리'는 관리자에게만 보인다(requireRole('admin')).
  // currentUser를 스크립트로 내려보내는 통로가 없어서 DOM으로 판단한다.
  var agentLink = document.querySelector('a[href="/chat/sessions"]');
  var isAgent = !!agentLink;
  var endpoint = isAgent ? '/chat/agent-unread.json' : '/chat/unread.json';
  var navLink = isAgent ? agentLink : document.querySelector('a[href="/orders/ai-intake"]');
  // 챗봇 화면 상단 배지는 고객 것이다 — 관리자 화면에는 이 요소가 없다.
  var titleHost = isAgent ? null : document.querySelector('.ai-chat-title');
  if (!navLink && !titleHost) return;

  function setBadge(host, count, cls) {
    if (!host) return;
    var badge = host.querySelector('.unread-badge');
    if (!count) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'unread-badge ' + cls;
      host.appendChild(badge);
    }
    // 세 자리가 넘으면 배지가 라벨을 밀어낸다. 정확한 수보다 "많다"는 사실이 중요하다.
    badge.textContent = count > 99 ? '99+' : String(count);
    var what = isAgent ? '읽지 않은 고객 메시지 ' : '읽지 않은 알림 ';
    badge.setAttribute('aria-label', what + count + '건');
    // '상담 관리' 메뉴에는 대기 건수 배지(아이콘 위)가 이미 있다. 빨간 동그라미가 둘이라
    // 무엇인지 알 수 없으므로 각자 설명을 붙인다 — 대기는 "연결 요청", 이건 "안 읽은 말".
    badge.setAttribute('title', what + count + '건');
  }

  function refresh() {
    fetch(endpoint, { headers: { 'X-Requested-With': 'fetch' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        setBadge(navLink, data.total, 'nav-unread-badge');
        setBadge(titleHost, data.total, 'ai-chat-title-badge');
        // 최근 항목 배지는 목록을 그리는 쪽이 자기 응답으로 붙인다(ai-intake.js) — 여기서
        // 또 손대면 두 곳이 같은 DOM을 다투게 된다.
        window.dispatchEvent(new CustomEvent('chat-unread', { detail: data }));
      })
      .catch(function () { /* 배지는 부가 정보다. 실패해도 화면을 막지 않는다. */ });
  }

  refresh();
  // 통보는 고객이 화면을 보고 있는 중에도 도착한다(크론이 매분 돈다). 다만 이건 배지일 뿐이라
  // 자주 물을 이유가 없다 — 탭이 보일 때만 1분마다 본다.
  setInterval(function () {
    if (!document.hidden) refresh();
  }, 60000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refresh();
  });
  // 세션을 열어 읽고 나면 즉시 줄어야 한다 — 챗봇 화면이 이 이벤트를 쏜다.
  window.addEventListener('chat-unread-refresh', refresh);
})();
