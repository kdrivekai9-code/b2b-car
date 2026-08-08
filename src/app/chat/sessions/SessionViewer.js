'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// 카드뷰(CardBoard.js)와 상세페이지(SessionDetailView.js) 둘 다 쓰는 공유 대화 뷰어 —
// 메시지 목록/SSE 실시간 수신/답장/담당지정(self)/삭제, 이 다섯 가지는 legacy에서도
// chat-session-cards.js와 session_detail.ejs 양쪽에 거의 동일한 로직으로 중복 구현돼 있던
// 부분이라(Stage 3 슬라이스 2 조사 결과) 여기서 한 번만 구현한다. 헤더(제목/상태뱃지 등)는
// 두 화면이 배치가 달라 각자 렌더링하고, 이 컴포넌트는 순수하게 메시지 영역 아래만 담당한다.
const STATUS_LABEL = { bot: '봇 응대중', needs_agent: '상담원 호출', agent_active: '상담원 응대중', closed: '종료' };
const SENDER_LABEL = { user: '고객', bot: 'AI', agent: '상담원', system: '시스템' };
const SENDER_CLASS = { user: 'ai-user', bot: 'ai-bot', agent: 'ai-agent', system: 'ai-bot' };

function formatChatTime(raw) {
  const m = String(raw || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h = Number(m[1]);
  const mm = m[2];
  const ampm = h < 12 ? '오전' : '오후';
  const h12 = h % 12 || 12;
  return `${ampm} ${h12}:${mm}`;
}

function isQuestionBubble(message) {
  return message.sender === 'bot' && /\?\s*$/.test(String(message.message || '').trim());
}

function readStateText(message) {
  if (!message) return '';
  if (message.sender === 'user') return message.read_by_agent_at ? '읽음' : '미읽음';
  if (message.sender === 'agent') return message.read_by_user_at ? '읽음' : '미읽음';
  return '';
}

// 자동 발송된 초안인지 — chat_messages에는 발신 주체 구분이 'agent' 하나뿐이라, 서버가 붙이는
// 안내 문구로 판별한다(routes/chat.js AUTO_SEND_NOTICE와 같은 문장이어야 한다).
const AUTO_SENT_MARK = '상담원이 30초동안 응답이 없어 AI가 응답을 먼저 생성하였습니다.';

function isAutoSent(message) {
  return message.sender === 'agent' && String(message.message || '').includes(AUTO_SENT_MARK);
}

function MessageBubble({ message }) {
  const who = SENDER_CLASS[message.sender] || 'ai-bot';
  const label = SENDER_LABEL[message.sender] || message.sender;
  const time = formatChatTime(message.created_at);
  const readText = readStateText(message);
  const isUnread = readText === '미읽음';
  const bubbleClass = `ai-chat-bubble ${who}${isQuestionBubble(message) ? ' ai-bot-question' : ''}`;
  return (
    <div className={`ai-chat-item ${who}`} data-id={message.id} data-sender={message.sender}>
      <div className={bubbleClass}>
        <span className="bubble-label">{label}{isAutoSent(message) ? ' · 자동 발송됨' : ''}</span>
        {message.message || ''}
      </div>
      {(time || readText) && (
        <div className="bubble-footer">
          {time && <div className="bubble-time">{time}</div>}
          {readText && <div className={`bubble-read${isUnread ? ' unread' : ''}`}>{readText}</div>}
        </div>
      )}
    </div>
  );
}

// 봇이 만든 답변 초안 — 고객 말풍선 바로 아래에, 아직 나가지 않았다는 게 한눈에 보이는
// 점선 말풍선으로 그린다. 상담원이 그대로 승인하거나 고쳐서 승인할 수 있고, 무시해도 된다.
// 여기 있는 동안에는 고객에게 전혀 보이지 않는다(chat_messages에 저장되지 않는다).
const SUGGESTION_KIND_LABEL = { intake: '접수 내용 파싱', faq: '지식베이스 답변' };

function SuggestionBubble({ suggestion, text, onChange, onApprove, onDismiss, disabled }) {
  return (
    <div className="ai-chat-item ai-agent" data-suggestion-id={suggestion.id}>
      <div
        className="ai-chat-bubble ai-agent"
        style={{ borderStyle: 'dashed', opacity: 0.95, width: '100%', maxWidth: '100%' }}
      >
        <span className="bubble-label">
          AI 초안 · 채택 대기
          {SUGGESTION_KIND_LABEL[suggestion.kind] ? ` (${SUGGESTION_KIND_LABEL[suggestion.kind]})` : ''}
        </span>
        <textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          rows={Math.min(10, Math.max(3, String(text || '').split('\n').length + 1))}
          disabled={disabled}
          style={{ width: '100%', marginTop: 6, fontSize: 13, lineHeight: 1.6, resize: 'vertical' }}
          aria-label="AI 답변 초안 (수정 가능)"
        />
        <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
          <button className="btn small secondary" type="button" onClick={onDismiss} disabled={disabled}>무시</button>
          <button className="btn small" type="button" onClick={onApprove} disabled={disabled || !String(text || '').trim()}>
            승인하고 전송
          </button>
        </div>
      </div>
      <div className="bubble-footer">
        <div className="bubble-time">아직 고객에게 보내지 않았습니다</div>
      </div>
    </div>
  );
}

// 빠른 답변 고르기 — 입력창 바로 위에 뜬다. 분류별로 묶어 보여줘야 "인사말이 어디 있더라"를
// 뒤지지 않는다(등록 문구가 20개를 넘어가면 평평한 목록은 못 쓴다).
function QuickReplyPicker({ replies, onPick, onClose }) {
  const [keyword, setKeyword] = useState('');
  const q = keyword.trim();
  const filtered = q
    ? replies.filter((r) => (r.title + ' ' + r.body).toLowerCase().includes(q.toLowerCase()))
    : replies;

  const grouped = filtered.reduce((acc, r) => {
    (acc[r.category] = acc[r.category] || []).push(r);
    return acc;
  }, {});

  return (
    <div className="card" style={{ marginBottom: 8, padding: 12, maxHeight: 260, overflowY: 'auto' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <input
          type="search"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="문구 검색"
          autoFocus
          style={{ flex: 1 }}
          aria-label="빠른 답변 검색"
        />
        <a className="btn small secondary" href="/quick-replies">관리</a>
        <button className="btn small secondary" type="button" onClick={onClose}>닫기</button>
      </div>

      {replies.length === 0 && (
        <div className="empty" style={{ padding: 8 }}>
          등록된 빠른 답변이 없습니다. <a href="/quick-replies">지금 등록하기</a>
        </div>
      )}
      {replies.length > 0 && filtered.length === 0 && (
        <div className="empty" style={{ padding: 8 }}>검색 결과가 없습니다.</div>
      )}

      {Object.entries(grouped).map(([category, items]) => (
        <div key={category} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0' }}>{category}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {items.map((r) => (
              <button
                key={r.id}
                className="btn small secondary"
                type="button"
                onClick={() => onPick(r.body)}
                title={r.body}
                style={{ maxWidth: '100%' }}
              >
                {r.title}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export async function fetchJson(url, options) {
  const res = await fetch(url, {
    ...options,
    headers: { Accept: 'application/json', 'X-Requested-With': 'fetch', ...(options && options.headers) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(err.error || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

export { STATUS_LABEL };

// autoLoadAll: 상세페이지는 legacy(session_detail.ejs)가 세션 전체 메시지를 한 번에
// 보여주므로, 초기 30건 로드 후 hasMore가 남아있으면 자동으로 이어서 전부 불러온다(최대
// 100건씩, 서버 GET /messages의 상한과 동일). 카드뷰는 legacy처럼 가볍게 유지(수동 "이전
// 메시지 더 보기" 버튼)하기 위해 false로 둔다.
export default function SessionViewer({
  sessionId,
  status,
  assignedAgentId,
  assignedAgentName,
  currentUser,
  autoLoadAll = false,
  onStatusChange,
  onDeleted,
  onNewMessage,
  extraActions,
}) {
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [replyError, setReplyError] = useState('');
  const [isSendingReply, setIsSendingReply] = useState(false);
  const [isAssigningSelf, setIsAssigningSelf] = useState(false);
  // 상담원 도우미 — 봇이 만든 답변 초안(채택 대기). 승인해야 고객에게 나간다.
  const [suggestion, setSuggestion] = useState(null);
  const [suggestionText, setSuggestionText] = useState('');
  const [isDecidingSuggestion, setIsDecidingSuggestion] = useState(false);
  suggestionRef.current = suggestion;
  // 빠른 답변(상용구) — 열 때 한 번만 불러온다. {상담원} 치환은 서버에서 끝내서 내려온다.
  const [quickReplies, setQuickReplies] = useState(null);
  const [quickRepliesOpen, setQuickRepliesOpen] = useState(false);
  const replyInputRef = useRef(null);

  const knownMessageIdsRef = useRef(new Set());
  const oldestMessageIdRef = useRef(null);
  const streamRef = useRef(null);
  const suggestionTimersRef = useRef([]);
  // 폴링·타이머 콜백이 최신 초안 상태를 봐야 해서 ref로도 들고 있는다.
  const suggestionRef = useRef(null);
  const lastTypingSentRef = useRef(0);
  const pollTimerRef = useRef(null);
  const messagesElRef = useRef(null);
  // 폴링 콜백이 최신 메시지 목록을 봐야 해서(setInterval은 최초 클로저를 붙잡는다) ref로 둔다.
  const messagesRef = useRef([]);
  messagesRef.current = messages;
  const sessionIdRef = useRef(null);
  const onNewMessageRef = useRef(onNewMessage);
  onNewMessageRef.current = onNewMessage;

  // 최신 메시지가 항상 보이게 한다. rAF 한 번만으로는 부족한 경우가 있다 — 초안 말풍선의
  // textarea처럼 렌더 직후 높이가 더 커지는 요소가 있으면 그 전에 스크롤이 끝나 마지막 줄이
  // 가려진다. 다음 프레임에서 한 번 더 맞춘다.
  function scrollToBottom() {
    const el = messagesElRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      const again = messagesElRef.current;
      if (again) again.scrollTop = again.scrollHeight;
    });
  }

  function openStream(id) {
    if (streamRef.current) { streamRef.current.close(); streamRef.current = null; }
    if (!window.EventSource) return;
    const es = new EventSource(`/chat/sessions/${id}/stream`);
    es.onmessage = (e) => {
      let payload;
      try { payload = JSON.parse(e.data); } catch { return; }
      if (!payload) return;
      if (payload.type === 'read_receipt') {
        const targetSender = payload.reader === 'agent' ? 'user' : 'agent';
        const field = payload.reader === 'agent' ? 'read_by_agent_at' : 'read_by_user_at';
        setMessages((prev) => prev.map((m) => (m.sender === targetSender ? { ...m, [field]: new Date().toISOString() } : m)));
        return;
      }
      if (!payload.id || knownMessageIdsRef.current.has(payload.id)) return;
      knownMessageIdsRef.current.add(payload.id);
      setMessages((prev) => [...prev, payload]);
      requestAnimationFrame(scrollToBottom);
      // 고객이 AI 접수 챗봇에서 계속 답변하면 chat_sessions.draft_json이 갱신되는데, 접수
      // 마무리 패널(IntakeMiniForm)은 세션 선택 시 한 번만 불러오므로 새 메시지가 올 때마다
      // 호출부(CardBoard)가 draft를 다시 조회해 반영할 수 있도록 신호를 준다.
      if (payload.sender === 'user' && onNewMessageRef.current) onNewMessageRef.current(payload);
      // 고객 메시지가 오면 봇 초안이 만들어졌는지 확인한다. 초안은 메시지 스트림으로 보내지
      // 않는다 — 스트림에 실으면 대화 말풍선으로 그려져 고객에게 보이는 것과 같아진다.
      if (payload.sender === 'user') scheduleSuggestionFetch(id);
    };
    streamRef.current = es;
  }

  // 초안은 고객 메시지보다 늦게 준비된다 — 접수 분류나 요금 계산이 들어가면 LLM·외부 API를
  // 거쳐 실측 3초까지 걸린다. 한 번만 조회하면(예전엔 0.9초 뒤 단발이었다) 그 사이에 없으면
  // 다음 고객 메시지가 올 때까지 영영 안 뜬다. 준비될 때까지 몇 번 더 확인한다.
  const SUGGESTION_RETRY_DELAYS = [800, 2000, 4000, 7000, 11000];

  function scheduleSuggestionFetch(id) {
    suggestionTimersRef.current.forEach(clearTimeout);
    suggestionTimersRef.current = SUGGESTION_RETRY_DELAYS.map((delay) => setTimeout(() => {
      // 이미 떠 있으면 더 두드리지 않는다(상담원이 편집 중일 수 있다).
      if (suggestionRef.current) return;
      fetchSuggestion(id);
    }, delay));
  }

  function fetchSuggestion(id) {
    if (!id) return;
    fetchJson(`/chat/sessions/${id}/suggestion`)
      .then((data) => {
        if (sessionIdRef.current !== id) return; // 그 사이 다른 세션으로 전환됨
        const next = (data && data.suggestion) || null;
        // 상담원이 초안을 고치는 중이면 같은 초안으로 덮어쓰지 않는다.
        if (next && suggestionRef.current && next.id === suggestionRef.current.id) return;
        setSuggestion(next);
        setSuggestionText(next ? next.text : '');
      })
      .catch(() => {});
  }

  function decideSuggestion(action) {
    if (!sessionId || !suggestion || isDecidingSuggestion) return;
    setIsDecidingSuggestion(true);
    setReplyError('');
    const url = `/chat/sessions/${sessionId}/suggestions/${suggestion.id}/${action}`;
    const options = action === 'approve'
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: suggestionText.trim() }) }
      : { method: 'POST' };
    fetchJson(url, options)
      .then((data) => {
        setSuggestion(null);
        setSuggestionText('');
        if (action === 'approve') {
          const agentId = currentUser ? String(currentUser.id) : '';
          const agentName = currentUser ? currentUser.name : '';
          if (onStatusChange) onStatusChange({ status: 'agent_active', assignedAgentId: agentId, assignedAgentName: agentName });
        }
      })
      .catch((err) => setReplyError(err.message || '초안 처리에 실패했습니다.'))
      .finally(() => setIsDecidingSuggestion(false));
  }

  function fetchOlder(id, beforeId) {
    const qs = new URLSearchParams({ limit: '30' });
    if (beforeId) qs.set('beforeId', beforeId);
    return fetchJson(`/chat/sessions/${id}/messages?${qs.toString()}`);
  }

  // 실시간 스트림이 끊기거나(서버리스에서 SSE가 잘리는 경우가 있다) 브로드캐스트가 유실돼도
  // 고객 발화가 화면에서 누락되면 안 된다. 마지막으로 받은 id 이후만 주기적으로 확인한다 —
  // 새 메시지가 없으면 빈 배열이라 비용이 거의 없다.
  const CATCH_UP_INTERVAL_MS = 7000;

  function startCatchUpPolling(id) {
    clearInterval(pollTimerRef.current);
    pollTimerRef.current = setInterval(() => {
      if (document.hidden) return; // 백그라운드 탭에서는 굳이 돌리지 않는다
      // 초안이 아직 없으면 같이 확인한다 — 생성이 늦어져 재시도 타이머를 다 소진했어도
      // 여기서 결국 잡힌다.
      if (!suggestionRef.current) fetchSuggestion(id);
      const lastId = messagesRef.current.length ? messagesRef.current[messagesRef.current.length - 1].id : 0;
      fetchJson(`/chat/sessions/${id}/poll?since=${lastId || 0}`)
        .then((data) => {
          if (sessionIdRef.current !== id) return;
          const fresh = (data.messages || []).filter((m) => m && m.id && !knownMessageIdsRef.current.has(m.id));
          if (!fresh.length) return;
          fresh.forEach((m) => knownMessageIdsRef.current.add(m.id));
          setMessages((prev) => [...prev, ...fresh]);
          if (fresh.some((m) => m.sender === 'user')) {
            if (onNewMessageRef.current) onNewMessageRef.current(fresh[fresh.length - 1]);
            scheduleSuggestionFetch(id);
          }
        })
        .catch(() => {});
    }, CATCH_UP_INTERVAL_MS);
  }

  useEffect(() => {
    sessionIdRef.current = sessionId;
    if (!sessionId) return;
    knownMessageIdsRef.current = new Set();
    oldestMessageIdRef.current = null;
    setHasMoreOlder(false);
    setMessages([]);
    setMessagesLoading(true);
    setReplyError('');
    setReplyText('');
    setSuggestion(null);
    setSuggestionText('');

    let cancelled = false;

    async function load() {
      let data;
      try {
        data = await fetchOlder(sessionId, null);
      } catch {
        if (!cancelled) { setMessagesLoading(false); setHasMoreOlder(false); }
        return;
      }
      if (cancelled) return;
      let msgs = data.messages || [];
      msgs.forEach((m) => knownMessageIdsRef.current.add(m.id));
      oldestMessageIdRef.current = msgs.length ? msgs[0].id : null;
      let more = !!data.hasMore;

      if (autoLoadAll) {
        while (more && !cancelled) {
          let older;
          try {
            older = await fetchOlder(sessionId, oldestMessageIdRef.current);
          } catch {
            break;
          }
          const olderMsgs = older.messages || [];
          if (!olderMsgs.length) { more = false; break; }
          olderMsgs.forEach((m) => knownMessageIdsRef.current.add(m.id));
          oldestMessageIdRef.current = olderMsgs[0].id;
          msgs = [...olderMsgs, ...msgs];
          more = !!older.hasMore;
        }
      }
      if (cancelled) return;
      setMessages(msgs);
      setHasMoreOlder(more);
      if (data.status && onStatusChange) onStatusChange({ status: data.status });
      setMessagesLoading(false);
      requestAnimationFrame(scrollToBottom);
      openStream(sessionId);
      // 화면을 열었을 때 이미 대기 중인 초안이 있을 수 있다(상담원이 자리를 비운 사이 도착).
      fetchSuggestion(sessionId);
      startCatchUpPolling(sessionId);
    }
    load();

    return () => {
      cancelled = true;
      suggestionTimersRef.current.forEach(clearTimeout);
      clearInterval(pollTimerRef.current);
      if (streamRef.current) { streamRef.current.close(); streamRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 메시지나 초안이 늘어나면 무조건 맨 아래로 붙인다 — 스트림 콜백에서만 스크롤하면
  // "이전 메시지 더 보기"나 초안 렌더처럼 다른 경로로 늘어난 경우를 놓친다.
  // 이전 메시지를 위로 불러올 때는 그 함수가 스크롤 위치를 직접 보정하므로 여기서 건드리지 않는다.
  const messageCountRef = useRef(0);
  const skipAutoScrollRef = useRef(false);
  useLayoutEffect(() => {
    const grew = messages.length > messageCountRef.current;
    messageCountRef.current = messages.length;
    if (skipAutoScrollRef.current) { skipAutoScrollRef.current = false; return; }
    if (grew || suggestion) scrollToBottom();
  }, [messages, suggestion]);

  function loadOlderMessages() {
    if (!sessionId || !hasMoreOlder || !oldestMessageIdRef.current) return;
    fetchOlder(sessionId, oldestMessageIdRef.current)
      .then((data) => {
        const msgs = data.messages || [];
        if (!msgs.length) { setHasMoreOlder(false); return; }
        const el = messagesElRef.current;
        const prevHeight = el ? el.scrollHeight : 0;
        msgs.forEach((m) => knownMessageIdsRef.current.add(m.id));
        oldestMessageIdRef.current = msgs[0].id;
        // 위로 붙는 경우다 — 아래로 끌어내리면 읽던 위치를 잃는다.
        skipAutoScrollRef.current = true;
        setMessages((prev) => [...msgs, ...prev]);
        setHasMoreOlder(!!data.hasMore);
        requestAnimationFrame(() => {
          if (el) el.scrollTop = el.scrollHeight - prevHeight;
        });
      })
      .catch(() => {});
  }

  // 상담원이 입력창에 타이핑하는 중이라는 신호. 이게 없으면 답을 쓰고 있는 사이에 서버가
  // 초안을 자동 발송해 같은 질문에 답이 두 번 나간다(카카오는 발송 취소가 안 된다).
  // 매 글자마다 보내지 않고 5초에 한 번으로 묶는다 — 서버는 "최근에 타이핑이 있었나"만 본다.
  function notifyTyping() {
    if (!sessionId) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < 5000) return;
    lastTypingSentRef.current = now;
    fetchJson(`/chat/sessions/${sessionId}/typing`, { method: 'POST' }).catch(() => {});
  }

  function sendReply(e) {
    e.preventDefault();
    if (!sessionId || isSendingReply) return;
    const text = replyText.trim();
    if (!text) return;
    setIsSendingReply(true);
    setReplyError('');
    fetchJson(`/chat/sessions/${sessionId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
      .then((data) => {
        const agentId = currentUser ? String(currentUser.id) : '';
        const agentName = currentUser ? currentUser.name : '';
        if (onStatusChange) onStatusChange({ status: (data && data.status) || 'agent_active', assignedAgentId: agentId, assignedAgentName: agentName });
        setReplyText('');
      })
      .catch((err) => setReplyError(err.message || '메시지 전송에 실패했습니다.'))
      .finally(() => setIsSendingReply(false));
  }

  function toggleQuickReplies() {
    setQuickRepliesOpen((open) => {
      const next = !open;
      if (next && quickReplies === null) {
        fetchJson('/quick-replies/data.json')
          .then((data) => setQuickReplies(data.replies || []))
          .catch(() => setQuickReplies([]));
      }
      return next;
    });
  }

  function assignSelf() {
    if (!sessionId || isAssigningSelf) return;
    setIsAssigningSelf(true);
    setReplyError('');
    fetchJson(`/chat/sessions/${sessionId}/assign-self`, { method: 'POST' })
      .then((data) => {
        const agentId = String((data && data.assignedAgentId) || (currentUser ? currentUser.id : ''));
        const agentName = (data && data.assignedAgentName) || (currentUser ? currentUser.name : '');
        if (onStatusChange) onStatusChange({ assignedAgentId: agentId, assignedAgentName: agentName });
      })
      .catch((err) => setReplyError(err.message || '담당자 지정에 실패했습니다.'))
      .finally(() => setIsAssigningSelf(false));
  }

  function deleteSession() {
    if (!sessionId) return;
    if (!window.confirm('이 상담 세션을 삭제하시겠습니까?')) return;
    fetchJson(`/chat/sessions/${sessionId}/delete`, { method: 'POST' })
      .then(() => {
        if (streamRef.current) { streamRef.current.close(); streamRef.current = null; }
        if (onDeleted) onDeleted();
      })
      .catch((err) => window.alert(err.message || '삭제에 실패했습니다.'));
  }

  const hasOtherAssignee = !!(assignedAgentId && currentUser && String(assignedAgentId) !== String(currentUser.id));
  const isClosed = status === 'closed';
  const replyDisabled = !sessionId || hasOtherAssignee || isClosed;

  return (
    <>
      <div className="card chat-session-card" style={{ boxShadow: 'none', borderStyle: 'dashed' }}>
        <div className="ai-chat-messages" ref={messagesElRef}>
          {!sessionId && <div className="empty">왼쪽에서 상담 세션을 선택해주세요.</div>}
          {sessionId && messagesLoading && <div className="empty">대화를 불러오는 중...</div>}
          {sessionId && !messagesLoading && messages.length === 0 && <div className="empty">아직 메시지가 없습니다.</div>}
          {sessionId && messages.map((m) => <MessageBubble key={m.id} message={m} />)}
          {sessionId && suggestion && !isClosed && (
            <SuggestionBubble
              suggestion={suggestion}
              text={suggestionText}
              onChange={setSuggestionText}
              onApprove={() => decideSuggestion('approve')}
              onDismiss={() => decideSuggestion('dismiss')}
              disabled={isDecidingSuggestion || hasOtherAssignee}
            />
          )}
        </div>
      </div>

      {sessionId && !isClosed && (
        <>
          {quickRepliesOpen && (
            <QuickReplyPicker
              replies={quickReplies || []}
              onPick={(body) => {
                // 입력창에 이미 쓰던 내용이 있으면 지우지 않고 뒤에 붙인다 — 반쯤 쓰다가
                // 상용구를 덧붙이는 경우가 실제로 많다.
                setReplyText((prev) => (prev.trim() ? prev.replace(/\s*$/, '\n') + body : body));
                setQuickRepliesOpen(false);
                requestAnimationFrame(() => { if (replyInputRef.current) replyInputRef.current.focus(); });
              }}
              onClose={() => setQuickRepliesOpen(false)}
            />
          )}
          <form className="chat-reply-row" onSubmit={sendReply} autoComplete="off">
            <button
              className="btn secondary"
              type="button"
              onClick={toggleQuickReplies}
              disabled={replyDisabled}
              title="빠른 답변 (자주 쓰는 문구 넣기)"
              aria-label="빠른 답변 열기"
              aria-expanded={quickRepliesOpen}
              style={{ flex: 'none', padding: '0 12px' }}
            >
              ⚡
            </button>
            <textarea
              ref={replyInputRef}
              value={replyText}
              onChange={(e) => { setReplyText(e.target.value); notifyTyping(); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(e); } }}
              placeholder={hasOtherAssignee ? '담당 상담원만 고객에게 응답할 수 있습니다.' : '상담원으로 답변을 입력하세요... (Enter 전송 / Shift+Enter 줄바꿈)'}
              required
              disabled={replyDisabled}
            />
            <button className="btn" type="submit" disabled={replyDisabled || isSendingReply || !replyText.trim()}>전송</button>
          </form>
        </>
      )}
      {replyError && <div className="chat-inline-error">{replyError}</div>}
      {hasOtherAssignee && (
        <div className="chat-inline-error">현재 담당자: {assignedAgentName || '다른 상담원'} · 담당자 변경 후 응답해주세요.</div>
      )}

      {sessionId && (
        <div className="chat-admin-viewer-actions">
          <button className="btn secondary small" type="button" onClick={assignSelf} disabled={isAssigningSelf}>
            {assignedAgentId && currentUser && String(assignedAgentId) === String(currentUser.id) ? '내가 담당중' : '내가 담당하기'}
          </button>
          <button className="btn danger small" type="button" onClick={deleteSession}>삭제</button>
          <button className="btn secondary small" type="button" onClick={loadOlderMessages} disabled={!hasMoreOlder}>이전 메시지 더 보기</button>
          {extraActions}
        </div>
      )}
    </>
  );
}
