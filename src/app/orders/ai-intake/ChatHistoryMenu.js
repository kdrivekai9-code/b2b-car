'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// public/js/ai-intake.js의 wireChatHistoryMenu(햄버거 메뉴 — 새 채팅 / 검색 / 최근 항목)를
// JSX로 이식.
//
// 왜 필요한가: Next 챗봇 화면에는 이 목록이 아예 없었다. 과거 세션을 **여는** 기능 자체는
// 살아 있는데(page.js가 쿼리를 넘기고 서버가 ?session=<id>로 복원한다) 목록 UI만 빠져
// 있었다. 그런데 안읽음 배지를 붙이면서 문제가 됐다 — 고객이 메뉴에서 "5"를 보고도 Next
// 화면에서는 그 5건이 어느 세션에 있는지 볼 목록이 없다. **배지가 가리키는 곳에 갈 수
// 없으면 배지가 오히려 답답하다.**
//
// 서버 계약은 EJS와 완전히 같다(/orders/ai-intake/sessions, .../delete) — 같은 응답을 쓰므로
// 두 화면의 목록이 갈리지 않는다. 클래스명도 그대로 써서 공용 CSS 한 장을 공유한다.
export default function ChatHistoryMenu({ sessionId }) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [startingNew, setStartingNew] = useState(false);

  // "새 채팅"은 **지금 대화를 닫고** 나서 이동해야 한다.
  //
  // 닫지 않고 같은 주소로 이동만 하면 서버가 열려 있는 세션을 그대로 복원한다 — 버튼을
  // 눌러도 화면이 하던 대화 그대로고, 확인 단계에 있었다면 다음에 붙여넣는 접수 문장이
  // "등록할까요?"의 답으로 처리된다(실측 2026-09-11: 접수 문장을 넣었더니 파싱조차 하지
  // 않고 '등록하려면 "네"…'로 답했다). EJS(public/js/ai-intake.js newChatBtn)는 예전부터
  // closeChatSession을 먼저 부르고 있었고, 이식하면서 그 한 줄이 빠졌다.
  //
  // 닫기가 실패해도 이동은 한다 — 못 닫았다고 버튼이 먹통이 되면 더 나쁘다.
  const startNewChat = useCallback(async () => {
    setStartingNew(true);
    if (sessionId) {
      try {
        await fetch('/chat/' + sessionId + '/bot-message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
          body: JSON.stringify({ closeSession: true }),
        });
      } catch { /* 이동은 그대로 진행한다 */ }
    }
    window.location.href = '/orders/ai-intake';
  }, [sessionId]);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);
  // 커서는 렌더링에 쓰지 않는다 — 상태로 두면 로드 중에 바뀌어 같은 페이지를 두 번 받는다.
  const cursorRef = useRef(null);

  const load = useCallback(async (reset) => {
    if (!reset && (loading || !hasMore)) return;
    setLoading(true);
    if (reset) cursorRef.current = null;
    try {
      const params = new URLSearchParams();
      if (cursorRef.current) params.set('before', String(cursorRef.current));
      if (query) params.set('q', query);
      const res = await fetch('/orders/ai-intake/sessions?' + params.toString(), {
        headers: { 'X-Requested-With': 'fetch' },
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const rows = (data && data.sessions) || [];
      setHasMore(!!(data && data.hasMore));
      if (rows.length) cursorRef.current = rows[rows.length - 1].id;
      setSessions((prev) => (reset ? rows : prev.concat(rows)));
      setLoadedOnce(true);
    } catch {
      // 목록을 못 불러와도 대화는 계속돼야 한다 — 조용히 비워둔다.
      if (reset) setSessions([]);
      setHasMore(false);
      setLoadedOnce(true);
    } finally {
      setLoading(false);
    }
  }, [hasMore, loading, query]);

  // 열 때 한 번만 불러온다. 열 때마다 다시 받으면 스크롤 위치와 더 불러온 페이지가 날아간다.
  useEffect(() => {
    if (open && !loadedOnce) load(true);
  }, [open, loadedOnce, load]);

  // 검색어는 입력마다 서버를 부르지 않는다(EJS와 같은 250ms 디바운스).
  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => { setLoadedOnce(false); setHasMore(true); load(true); }, 250);
    return () => clearTimeout(timer);
    // load를 의존성에 넣으면 매 렌더마다 타이머가 다시 걸린다 — query만 본다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // 바깥을 누르면 닫힌다.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  async function remove(id) {
    // 실제로는 DB에서 지우지 않고 이 사용자 화면에서만 숨긴다(user_hidden_at) — 문구는
    // 사용자에게 익숙한 "삭제"로 두되 동작은 소프트 삭제 그대로다(EJS와 동일).
    if (!window.confirm('이 항목을 삭제하시겠습니까?')) return;
    try {
      const res = await fetch('/orders/ai-intake/sessions/' + encodeURIComponent(id) + '/delete', {
        method: 'POST',
        headers: { 'X-Requested-With': 'fetch' },
      });
      if (!res.ok) throw new Error(String(res.status));
      if (String(id) === String(sessionId)) {
        window.location.href = '/orders/ai-intake';
        return;
      }
      setLoadedOnce(false);
      setHasMore(true);
      load(true);
    } catch (e) {
      window.alert('삭제에 실패했습니다: ' + (e && e.message ? e.message : '알 수 없는 오류'));
    }
  }

  function goto(id) {
    window.location.href = '/orders/ai-intake?session=' + encodeURIComponent(id);
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="ai-chat-menu-btn"
        aria-haspopup="true"
        aria-expanded={open ? 'true' : 'false'}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="hamburger-icon"><span></span><span></span></span>
      </button>

      {open && (
        <div className="ai-chat-menu-panel" style={{ display: 'flex' }}>
          <button
            type="button"
            className="ai-chat-menu-item"
            disabled={startingNew}
            onClick={startNewChat}
          >
            🆕 <span>새 채팅</span>
          </button>
          <button
            type="button"
            className="ai-chat-menu-item"
            onClick={() => setSearchOpen((v) => !v)}
          >
            🔍 <span>검색</span>
          </button>
          {searchOpen && (
            <div className="ai-chat-search-row" style={{ display: 'flex' }}>
              <input
                type="text"
                placeholder="채팅 검색"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
            </div>
          )}

          <div className="ai-chat-recent-label">최근 항목</div>
          {/* 더 불러오기는 EJS와 같이 스크롤로 한다(바닥 40px 안). "더 보기" 버튼을 두면
              두 화면의 조작이 달라지고, 그 버튼용 CSS도 공용 CSS에 없다. */}
          <div
            className="ai-chat-recent-list"
            onClick={(e) => e.stopPropagation()}
            onScroll={(e) => {
              const el = e.currentTarget;
              if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) load(false);
            }}
          >
            {loading && !sessions.length && <div className="ai-chat-recent-empty">불러오는 중…</div>}
            {!loading && loadedOnce && !sessions.length && (
              <div className="ai-chat-recent-empty">대화 내역이 없습니다.</div>
            )}
            {sessions.map((s) => (
              <div
                key={s.id}
                className={'ai-chat-recent-item' + (String(s.id) === String(sessionId) ? ' active' : '')}
                role="button"
                tabIndex={0}
                title={s.summary}
                onClick={() => goto(s.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goto(s.id); }
                }}
              >
                {/* 안읽음 배지는 요약 글 **앞**에 — 어느 세션에서 왔는지가 먼저 보여야
                    사용자가 그 항목을 눌러 들어간다(EJS와 같은 자리). */}
                {s.unread > 0 && (
                  <span className="unread-badge" aria-label={`읽지 않은 알림 ${s.unread}건`}>
                    {s.unread > 99 ? '99+' : String(s.unread)}
                  </span>
                )}
                <span className="ai-chat-recent-summary" title={s.summary}>{s.summary}</span>
                <span className="ai-chat-recent-meta">
                  <span className="ai-chat-recent-date">{formatRecentDate(s.updatedAt)}</span>
                  <button
                    type="button"
                    className="ai-chat-recent-delete"
                    title="삭제"
                    aria-label="삭제"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); remove(s.id); }}
                  >
                    ×
                  </button>
                </span>
              </div>
            ))}
            {loading && sessions.length > 0 && (
              <div className="ai-chat-recent-loading">불러오는 중…</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// public/js/ai-intake-render.js의 formatRecentDateTime과 같은 규칙("M.D").
// updated_at은 KST 벽시계가 담긴 text다 — new Date()에 넘기면 실행 환경에 따라 다르게 읽히므로
// 문자열에서 바로 꺼낸다(lib/chatHistoryWindow.js에 같은 함정이 적혀 있다).
function formatRecentDate(raw) {
  const m = String(raw || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  return `${Number(m[2])}.${Number(m[3])}`;
}
