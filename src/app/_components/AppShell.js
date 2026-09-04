import Script from 'next/script';
import AgentPresenceScripts from './AgentPresenceScripts';

// views/partials/header.ejs + footer.ejs를 JSX로 이식한 공유 셸. Stage 1/2가 만든 5개
// 페이지(대시보드/오더목록/문의목록/상담목록/오더등록폼)는 지금까지 이 사이드바/헤더 없이
// 순수 콘텐츠만 렌더링해왔다(Stage 3 계획 단계에서 발견된 미공개 격차) — 이 컴포넌트로
// 소급 적용한다. activePath는 각 page.js가 자신의 경로를 리터럴로 넘긴다(header.ejs의
// `path.startsWith(...)` 활성화 판정을 서버에서 그대로 재현하기 위함, 클라이언트
// usePathname 불필요).
const ROLE_LABEL = { admin: '관리자', branch_manager: '지사장', client: '고객사' };
const GRADE_LABEL = { leader: '법인 담당(리더)', member: '법인 담당(일반)' };

function isActive(activePath, prefix, exact) {
  if (exact) return activePath === prefix;
  return activePath.startsWith(prefix);
}

export default function AppShell({ currentUser, activePath, topNav = false, children }) {
  const roleLabel = currentUser ? ROLE_LABEL[currentUser.role] || '' : '';
  const gradeLabel = currentUser && currentUser.role === 'client' && currentUser.grade
    ? ' · ' + (GRADE_LABEL[currentUser.grade] || '')
    : '';
  const isAdmin = currentUser && currentUser.role === 'admin';
  const isClient = currentUser && currentUser.role === 'client';
  // 개인 딜러 판정 — 값이 비어 있는 기존 계정은 본사 직원으로 본다(lib/clientScope.js와
  // 같은 규칙). 마이그레이션만으로 누군가의 메뉴가 조용히 사라지면 안 된다.
  const isDealer = isClient && currentUser.client_type === 'dealer';
  const isAdminOrBranchManager = currentUser && (currentUser.role === 'admin' || currentUser.role === 'branch_manager');

  return (
    <div className={`app${topNav ? ' app-top-nav' : ''}`}>
      <aside className={`sidebar${topNav ? ' sidebar-top-nav' : ''}`} id="appSidebar" data-layout-mode={topNav ? 'top-nav' : undefined}>
        {!topNav && <button type="button" className="sidebar-toggle" id="sidebarToggle" title="사이드바 접기/펼치기">☰</button>}
        <div className="brand">
          <span className="brand-icon">🚚</span>
          <span className="brand-text">B2B-CAR<small>탁송 B2B 통합·운영 플랫폼</small></span>
        </div>
        {currentUser && (
          <div className="brand-user">
            <div className="brand-user-name" title={`${currentUser.name}님 (${currentUser.login_id}) · ${roleLabel}${gradeLabel}`}>
              {currentUser.name}님<span className="brand-user-loginid"> ({currentUser.login_id})</span>
            </div>
            <div className="brand-user-actions">
              <button className="btn secondary small" id="pushToggleBtn" type="button" title="알림 받기">🔕 알림 받기</button>
              <form action="/logout" method="POST"><button className="btn secondary small" type="submit" title="로그아웃">🚪 로그아웃</button></form>
            </div>
          </div>
        )}
        <nav>
          <a href="/" className={isActive(activePath, '/', true) ? 'active' : ''} title="대시보드"><span className="nav-icon">📊</span><span className="nav-label">대시보드</span></a>
          <a href="/orders" className={activePath.startsWith('/orders') && !activePath.startsWith('/orders/ai-intake') ? 'active' : ''} title="오더 리스트"><span className="nav-icon">📋</span><span className="nav-label">오더 리스트</span></a>
          <a href="/orders/ai-intake" className={isActive(activePath, '/orders/ai-intake') ? 'active' : ''} title="AI 챗봇"><span className="nav-icon">🤖</span><span className="nav-label">AI 챗봇</span></a>
          <a href="/notices" className={isActive(activePath, '/notices') ? 'active' : ''} title="공지사항"><span className="nav-icon">📢</span><span className="nav-label">공지사항</span></a>
          <a href="/push/settings" className={isActive(activePath, '/push') ? 'active' : ''} title="오더 알림 설정"><span className="nav-icon">🔔</span><span className="nav-label">오더 알림 설정</span></a>
          <a href="/faq" className={isActive(activePath, '/faq') ? 'active' : ''} title="FAQ 문의"><span className="nav-icon">💬</span><span className="nav-label">FAQ 문의</span></a>
          {/* 고객 전용 메뉴 — EJS 네비(views/partials/header.ejs)에 있던 세 줄이 여기에는
              통째로 빠져 있었다. 고객이 Next가 그리는 화면에 들어오면 정산내역·팀 현황으로
              가는 길이 사라진다. 한쪽에만 메뉴를 넣지 않는다는 규칙을 여기서 맞춘다. */}
          {isClient && (
            <>
              {/* 개인 딜러에게는 안 보인다 — 화면 자체가 막혀 있어 메뉴만 남기면 403을
                  보게 된다. EJS 네비도 같은 줄을 갖는다(views/partials/header.ejs). */}
              {!isDealer && (
                <a href="/orders/team-feed" className={isActive(activePath, '/orders/team-feed') ? 'active' : ''} title="팀 접수 현황 안내"><span className="nav-icon">🏷️</span><span className="nav-label">팀 접수 현황 안내</span></a>
              )}
              <a href="/my/settlement" className={isActive(activePath, '/my/settlement') ? 'active' : ''} title="정산내역"><span className="nav-icon">🧾</span><span className="nav-label">정산내역</span></a>
              <a href="/my/photos" className={isActive(activePath, '/my/photos') ? 'active' : ''} title="사진 전송리스트"><span className="nav-icon">📷</span><span className="nav-label">사진 전송리스트</span></a>
            </>
          )}
          {isAdminOrBranchManager && (
            <a href="/inquiries" className={isActive(activePath, '/inquiries') ? 'active' : ''} title="문의 관리"><span className="nav-icon">📝</span><span className="nav-label">문의 관리</span></a>
          )}
          {isAdmin && (
            <>
              <a href="/branches" className={isActive(activePath, '/branches') ? 'active' : ''} title="지사 관리"><span className="nav-icon">🏢</span><span className="nav-label">지사 관리</span></a>
              <a href="/groups" className={isActive(activePath, '/groups') ? 'active' : ''} title="법인 관리"><span className="nav-icon">👥</span><span className="nav-label">법인 관리</span></a>
              <a href="/users" className={isActive(activePath, '/users') ? 'active' : ''} title="사용자 관리"><span className="nav-icon">🧑‍💼</span><span className="nav-label">사용자 관리</span></a>
              <a href="/drivers" className={isActive(activePath, '/drivers') ? 'active' : ''} title="기사 관리"><span className="nav-icon">🚙</span><span className="nav-label">기사 관리</span></a>
              {/* 기사 채팅 링크 — EJS 네비에도 같은 줄이 있다(views/partials/header.ejs).
                  Express가 그리는 화면이라 Next 라우트는 없고, 프록시가 그대로 넘긴다. */}
              <a href="/driver/link" className={activePath.startsWith('/driver') ? 'active' : ''} title="기사 채팅 링크"><span className="nav-icon">🔗</span><span className="nav-label">기사 채팅 링크</span></a>
              <a href="/location-aliases" className={isActive(activePath, '/location-aliases') ? 'active' : ''} title="거점 별칭 관리"><span className="nav-icon">📍</span><span className="nav-label">거점 별칭 관리</span></a>
              <a href="/knowledge-base" className={isActive(activePath, '/knowledge-base') ? 'active' : ''} title="지식관리"><span className="nav-icon">📚</span><span className="nav-label">지식관리</span></a>
              <a href="/ferry-fares" className={isActive(activePath, '/ferry-fares') ? 'active' : ''} title="도선료 관리"><span className="nav-icon">🚢</span><span className="nav-label">도선료 관리</span></a>
              <a href="/chat/sessions" className={isActive(activePath, '/chat/sessions') ? 'active' : ''} title="상담 관리"><span className="nav-icon">🎧</span><span className="nav-label">상담 관리</span><span className="nav-badge" id="agentCallBadge" style={{ display: 'none' }}></span></a>
              <a href="/chat/guide" className={isActive(activePath, '/chat/guide') ? 'active' : ''} title="상담 운영안"><span className="nav-icon">🧭</span><span className="nav-label">상담 운영안</span></a>
              <a href="/access-logs" className={isActive(activePath, '/access-logs') ? 'active' : ''} title="접속기록"><span className="nav-icon">🛡️</span><span className="nav-label">접속기록</span></a>
              <a href="/kakao-accounts" className={isActive(activePath, '/kakao-accounts') ? 'active' : ''} title="카카오 채널 매핑"><span className="nav-icon">💬</span><span className="nav-label">카카오 채널</span></a>
              <a href="/integration-errors" className={isActive(activePath, '/integration-errors') ? 'active' : ''} title="연동 오류"><span className="nav-icon">🔌</span><span className="nav-label">연동 오류</span></a>
              <a href="/settings" className={isActive(activePath, '/settings') ? 'active' : ''} title="설정"><span className="nav-icon">⚙️</span><span className="nav-label">설정</span></a>
            </>
          )}
        </nav>
        {!topNav && <div className="sidebar-resize-handle" id="sidebarResizeHandle"></div>}
      </aside>
      <div className="main">
        <Script src="/js/push.js" strategy="afterInteractive" />
        <Script src="/js/callmaner-alert.js" strategy="afterInteractive" />
        {isAdmin && <AgentPresenceScripts />}
        <div className="content">{children}</div>
      </div>
      <Script src="/js/sidebar.js" strategy="afterInteractive" />
    </div>
  );
}
