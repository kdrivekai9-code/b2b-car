'use client';

import { useEffect, useRef, useState } from 'react';

// public/js/chat-session-cards.js(1111줄)를 React로 이식 — 상담 카드뷰의 핵심 화면.
// 서버 쪽은 거의 변경이 필요 없었다(계획 문서 참고): 메시지 cursor 페이징(/messages)과
// 세션별 SSE(/stream), 답장/담당지정(assign-self)/삭제는 이미 JSON 응답을 지원하는
// 기존 Express 엔드포인트를 그대로 fetch()/EventSource로 소비한다.
//
// 이번 슬라이스에서 생략한 것(공개적으로 문서화):
// - 오른쪽 "접수 마무리"(임베드 오더등록 폼, draft_json 자동상속)는 생략하고 "오더 등록으로
//   이동" 링크로 /orders/new(Stage 2)를 새 탭에 연다 — 자동상속 없음, 수동 재입력 필요.
// - session_detail.ejs(상세페이지)는 이번 슬라이스 대상이 아니라 "상세 페이지 열기" 링크가
//   그대로 Express로 이동한다(Next에 페이지가 없어 자동 fallback rewrite).
//
// 목록 실시간 갱신: legacy는 헤더의 상시 agent-presence SSE가 쏘는 'agent-needs-count'
// 커스텀 이벤트를 재사용해 "새 상담 업데이트 보기" 버튼만 띄우고 전체 새로고침으로
// 반영했다(SSE 이중연결 방지). 이 컴포넌트도 같은 이벤트를 재사용하되, 전체 페이지
// 리로드 대신 카드 목록만 다시 fetch한다 — 현재 선택된 대화가 끊기지 않는 개선.

const STATUS_LABEL = { bot: '봇 응대중', needs_agent: '상담원 호출', agent_active: '상담원 응대중', closed: '종료' };
const STATUS_BADGE = { bot: 'gray', needs_agent: 'red', agent_active: 'blue', closed: 'dark' };
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

async function fetchJson(url, options) {
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

export default function CardBoard({ initialSessions, initialOnlineAgents, currentUser }) {
  const [sessions, setSessions] = useState(initialSessions || []);
  const [onlineAgents, setOnlineAgents] = useState(initialOnlineAgents || []);
  const [showRefreshBtn, setShowRefreshBtn] = useState(false);

  const [selected, setSelected] = useState(null); // { id, status, assignedAgentId, assignedAgentName }
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
  const selectedIdRef = useRef(null);

  useEffect(() => {
    selectedIdRef.current = selected ? selected.id : null;
  }, [selected]);

  // agent-presence.js(AgentPresenceScripts)가 쏘는 커스텀 이벤트 재사용 — 별도 SSE 연결을
  // 새로 열지 않는다(legacy와 동일한 이유, chat-session-cards.js L1100-1103 주석 참고).
  useEffect(() => {
    function onNeedsCount(e) {
      if (e.detail && e.detail.initial) return;
      setShowRefreshBtn(true);
    }
    window.addEventListener('agent-needs-count', onNeedsCount);
    return () => window.removeEventListener('agent-needs-count', onNeedsCount);
  }, []);

  useEffect(() => () => { if (streamRef.current) streamRef.current.close(); }, []);

  function scrollToBottom() {
    const el = messagesElRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  function openStream(sessionId) {
    if (streamRef.current) { streamRef.current.close(); streamRef.current = null; }
    if (!window.EventSource) return;
    const es = new EventSource(`/chat/sessions/${sessionId}/stream`);
    es.onmessage = (e) => {
      let payload;
      try { payload = JSON.parse(e.data); } catch { return; }
      if (!payload) return;
      if (payload.type === 'read_receipt') {
        const targetSender = payload.reader === 'agent' ? 'user' : 'agent';
        setMessages((prev) => prev.map((m) => (m.sender === targetSender ? { ...m, [`read_by_${payload.reader === 'agent' ? 'agent' : 'user'}_at`]: new Date().toISOString() } : m)));
        return;
      }
      if (!payload.id || knownMessageIdsRef.current.has(payload.id)) return;
      knownMessageIdsRef.current.add(payload.id);
      setMessages((prev) => [...prev, payload]);
      requestAnimationFrame(scrollToBottom);
    };
    streamRef.current = es;
  }

  function selectSession(s) {
    if (selectedIdRef.current === s.id) return;
    setSelected({ id: s.id, status: s.status, assignedAgentId: s.assigned_agent_id ? String(s.assigned_agent_id) : '', assignedAgentName: s.assigned_agent_name || '' });
    knownMessageIdsRef.current = new Set();
    oldestMessageIdRef.current = null;
    setHasMoreOlder(false);
    setMessages([]);
    setMessagesLoading(true);
    setReplyError('');
    setReplyText('');

    fetchJson(`/chat/sessions/${s.id}/messages?limit=30`)
      .then((data) => {
        if (selectedIdRef.current !== s.id) return;
        const msgs = data.messages || [];
        msgs.forEach((m) => knownMessageIdsRef.current.add(m.id));
        oldestMessageIdRef.current = msgs.length ? msgs[0].id : null;
        setMessages(msgs);
        setHasMoreOlder(!!data.hasMore);
        if (data.status) setSelected((prev) => (prev && prev.id === s.id ? { ...prev, status: data.status } : prev));
        setMessagesLoading(false);
        requestAnimationFrame(scrollToBottom);
        openStream(s.id);
      })
      .catch(() => {
        if (selectedIdRef.current !== s.id) return;
        setMessagesLoading(false);
        setHasMoreOlder(false);
      });
  }

  function loadOlderMessages() {
    if (!selected || !hasMoreOlder || !oldestMessageIdRef.current) return;
    const sessionId = selected.id;
    fetchJson(`/chat/sessions/${sessionId}/messages?limit=30&beforeId=${oldestMessageIdRef.current}`)
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
    if (!selected || isSendingReply) return;
    const text = replyText.trim();
    if (!text) return;
    setIsSendingReply(true);
    setReplyError('');
    fetchJson(`/chat/sessions/${selected.id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
      .then((data) => {
        const agentId = currentUser ? String(currentUser.id) : '';
        const agentName = currentUser ? currentUser.name : '';
        setSelected((prev) => (prev ? { ...prev, status: (data && data.status) || 'agent_active', assignedAgentId: agentId, assignedAgentName: agentName } : prev));
        setSessions((prev) => prev.map((s) => (s.id === selected.id ? { ...s, assigned_agent_id: agentId, assigned_agent_name: agentName, status: (data && data.status) || 'agent_active' } : s)));
        setReplyText('');
      })
      .catch((err) => setReplyError(err.message || '메시지 전송에 실패했습니다.'))
      .finally(() => setIsSendingReply(false));
  }

  function assignSelf() {
    if (!selected || isAssigningSelf) return;
    setIsAssigningSelf(true);
    setReplyError('');
    fetchJson(`/chat/sessions/${selected.id}/assign-self`, { method: 'POST' })
      .then((data) => {
        const agentId = String((data && data.assignedAgentId) || (currentUser ? currentUser.id : ''));
        const agentName = (data && data.assignedAgentName) || (currentUser ? currentUser.name : '');
        setSelected((prev) => (prev ? { ...prev, assignedAgentId: agentId, assignedAgentName: agentName } : prev));
        setSessions((prev) => prev.map((s) => (s.id === selected.id ? { ...s, assigned_agent_id: agentId, assigned_agent_name: agentName } : s)));
      })
      .catch((err) => setReplyError(err.message || '담당자 지정에 실패했습니다.'))
      .finally(() => setIsAssigningSelf(false));
  }

  function deleteSession(sessionId) {
    if (!window.confirm('이 상담 세션을 삭제하시겠습니까?')) return;
    fetchJson(`/chat/sessions/${sessionId}/delete`, { method: 'POST' })
      .then(() => {
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        if (selectedIdRef.current === sessionId) {
          if (streamRef.current) { streamRef.current.close(); streamRef.current = null; }
          setSelected(null);
          setMessages([]);
        }
      })
      .catch((err) => window.alert(err.message || '삭제에 실패했습니다.'));
  }

  function refreshList() {
    fetchJson('/chat/sessions/card-data.json')
      .then((data) => {
        setSessions(data.sessions || []);
        setOnlineAgents(data.onlineAgents || []);
        setShowRefreshBtn(false);
      })
      .catch(() => {});
  }

  const hasOtherAssignee = !!(selected && selected.assignedAgentId && currentUser && selected.assignedAgentId !== String(currentUser.id));
  const isClosed = selected && selected.status === 'closed';
  const replyDisabled = !selected || hasOtherAssignee || isClosed;

  return (
    <>
      <div className="page-head-row chat-page-head">
        <div>
          <div className="chat-title-row">
            <h1 className="page-title">상담 관리</h1>
            <p className="page-sub chat-title-desc">AI 챗봇으로 들어온 대화를 모니터링하고, 상담원 연결이 필요한 세션에 직접 응대할 수 있습니다. (Next.js 프리뷰)</p>
          </div>
          <p className="page-sub chat-agent-status">
            {onlineAgents.length ? (
              <span className="badge green">🟢 접속 중인 상담원: {onlineAgents.join(', ')}</span>
            ) : (
              <span className="badge gray">⚪ 접속 중인 상담원 없음</span>
            )}
          </p>
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/chat/guide">상담 운영안</a>
          <a className="btn secondary" href="/chat/sessions?view=list">리스트 보기</a>
          <a className="btn" href="/chat/sessions?view=card">챗봇 카드 보기</a>
        </div>
      </div>

      <div className="chat-admin-layout" data-current-user-id={currentUser ? currentUser.id : ''} data-current-user-name={currentUser ? currentUser.name : ''}>
        <div className="card chat-admin-card-list">
          {sessions.length === 0 && <div className="empty">진행 중인 상담 세션이 없습니다.</div>}
          {sessions.map((s) => (
            <div className="session-card-row" key={s.id}>
              <button
                type="button"
                className={`session-card-item ${s.status === 'needs_agent' ? 'needs-agent' : ''} ${selected && selected.id === s.id ? 'active' : ''}`}
                onClick={() => selectSession(s)}
              >
                <div className="session-card-head">
                  <strong>#{s.id} · {s.user_name || '-'}</strong>
                  <span className={`badge ${STATUS_BADGE[s.status] || 'gray'}`}>{STATUS_LABEL[s.status] || s.status}</span>
                </div>
                <div className="session-card-sub">{s.user_role || '-'}{s.user_phone ? ` · ${s.user_phone}` : ''}</div>
                <div className="session-card-msg" title={s.last_message || ''}>{s.last_message || '최근 메시지 없음'}</div>
                <div className="session-card-meta">메시지 {s.message_count}개 · 업데이트 {s.updated_at}</div>
                <div className="session-card-meta">담당: {s.assigned_agent_name || '미지정'}</div>
              </button>
              <div className="session-card-inline-delete">
                <button type="button" className="btn danger small session-card-delete-btn" title="이 세션 삭제" onClick={() => deleteSession(s.id)}>삭제</button>
              </div>
            </div>
          ))}
        </div>

        <div className="card chat-admin-viewer">
          {/* chat-admin-viewer-shell은 원래 두 번째 grid 컬럼(임베드 오더등록 패널)까지
              전제하는데, 이번 슬라이스는 그 패널을 생략했으므로(계획 문서 참고) 대화 패널이
              전체 폭을 쓰도록 인라인으로 1열 그리드를 강제한다. */}
          <div className="chat-admin-viewer-shell" style={{ gridTemplateColumns: '1fr' }}>
            <section className="chat-admin-conversation">
              <div className="chat-admin-viewer-head">
                {selected ? (
                  <>
                    <h2>상담 #{selected.id}</h2>
                    <p className="page-sub">
                      <span className={`badge ${STATUS_BADGE[selected.status] || 'gray'}`}>{STATUS_LABEL[selected.status] || selected.status}</span>
                      <span style={{ marginLeft: 8 }}>담당자: {selected.assignedAgentName || '미지정'}</span>
                    </p>
                  </>
                ) : (
                  <>
                    <h2>세션을 선택하세요</h2>
                    <p className="page-sub">카드를 선택하면 해당 세션의 최근 대화를 불러옵니다. 전체 세션 메시지는 한 번에 로드하지 않습니다.</p>
                  </>
                )}
              </div>

              <div className="card chat-session-card" style={{ boxShadow: 'none', borderStyle: 'dashed' }}>
                <div className="ai-chat-messages" ref={messagesElRef}>
                  {!selected && <div className="empty">왼쪽에서 상담 세션을 선택해주세요.</div>}
                  {selected && messagesLoading && <div className="empty">대화를 불러오는 중...</div>}
                  {selected && !messagesLoading && messages.length === 0 && <div className="empty">아직 메시지가 없습니다.</div>}
                  {selected && messages.map((m) => <MessageBubble key={m.id} message={m} />)}
                </div>
              </div>

              {selected && (
                <form className="chat-reply-row" onSubmit={sendReply} autoComplete="off">
                  <textarea
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(e); } }}
                    placeholder={hasOtherAssignee ? '담당 상담원만 고객에게 응답할 수 있습니다.' : (isClosed ? '종료된 상담은 이 화면에서 전송할 수 없습니다.' : '상담원으로 답변을 입력하세요... (Enter 전송 / Shift+Enter 줄바꿈)')}
                    required
                    disabled={replyDisabled}
                  />
                  <button className="btn" type="submit" disabled={replyDisabled || isSendingReply || !replyText.trim()}>전송</button>
                </form>
              )}
              {replyError && <div className="chat-inline-error">{replyError}</div>}
              {hasOtherAssignee && (
                <div className="chat-inline-error">현재 담당자: {selected.assignedAgentName || '다른 상담원'} · 담당자 변경 후 응답해주세요.</div>
              )}

              {selected && (
                <div className="chat-admin-viewer-actions">
                  <button className="btn secondary small" type="button" onClick={assignSelf} disabled={isAssigningSelf}>
                    {selected.assignedAgentId && currentUser && selected.assignedAgentId === String(currentUser.id) ? '내가 담당중' : '내가 담당하기'}
                  </button>
                  <button className="btn danger small" type="button" onClick={() => deleteSession(selected.id)}>삭제</button>
                  <button className="btn secondary small" type="button" onClick={loadOlderMessages} disabled={!hasMoreOlder}>이전 메시지 더 보기</button>
                  <a className="btn small" href={`/chat/sessions/${selected.id}`}>상세 페이지 열기</a>
                  <a className="btn small" href="/orders/new" target="_blank" rel="noreferrer">오더 등록으로 이동</a>
                </div>
              )}
            </section>
          </div>
        </div>
      </div>

      {showRefreshBtn && (
        <button
          type="button"
          className="btn"
          style={{ position: 'fixed', right: 20, bottom: 20, zIndex: 1000 }}
          onClick={refreshList}
        >
          새 상담 업데이트 보기
        </button>
      )}
    </>
  );
}
