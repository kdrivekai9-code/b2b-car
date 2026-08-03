'use client';

import { useEffect, useRef, useState } from 'react';

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
        <span className="bubble-label">{label}</span>
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

  const knownMessageIdsRef = useRef(new Set());
  const oldestMessageIdRef = useRef(null);
  const streamRef = useRef(null);
  const messagesElRef = useRef(null);
  const sessionIdRef = useRef(null);
  const onNewMessageRef = useRef(onNewMessage);
  onNewMessageRef.current = onNewMessage;

  function scrollToBottom() {
    const el = messagesElRef.current;
    if (el) el.scrollTop = el.scrollHeight;
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
    };
    streamRef.current = es;
  }

  function fetchOlder(id, beforeId) {
    const qs = new URLSearchParams({ limit: '30' });
    if (beforeId) qs.set('beforeId', beforeId);
    return fetchJson(`/chat/sessions/${id}/messages?${qs.toString()}`);
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
    }
    load();

    return () => {
      cancelled = true;
      if (streamRef.current) { streamRef.current.close(); streamRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

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
        setMessages((prev) => [...msgs, ...prev]);
        setHasMoreOlder(!!data.hasMore);
        requestAnimationFrame(() => {
          if (el) el.scrollTop = el.scrollHeight - prevHeight;
        });
      })
      .catch(() => {});
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
        </div>
      </div>

      {sessionId && !isClosed && (
        <form className="chat-reply-row" onSubmit={sendReply} autoComplete="off">
          <textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(e); } }}
            placeholder={hasOtherAssignee ? '담당 상담원만 고객에게 응답할 수 있습니다.' : '상담원으로 답변을 입력하세요... (Enter 전송 / Shift+Enter 줄바꿈)'}
            required
            disabled={replyDisabled}
          />
          <button className="btn" type="submit" disabled={replyDisabled || isSendingReply || !replyText.trim()}>전송</button>
        </form>
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
