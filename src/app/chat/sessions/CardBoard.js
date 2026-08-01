'use client';

import { useEffect, useState } from 'react';
import SessionViewer, { STATUS_LABEL, fetchJson } from './SessionViewer';
import OrderForm from '../../orders/new/OrderForm';

// public/js/chat-session-cards.js(1111줄)를 React로 이식 — 상담 카드뷰의 핵심 화면.
// 메시지/SSE/답장/담당지정(self)/삭제는 SessionViewer.js(슬라이스 2에서 상세페이지와
// 공유하도록 추출)가 담당하고, 이 파일은 좌측 카드 목록 + 상단 헤더 + 새 상담 업데이트
// 알림 + "접수 마무리" 탭(슬라이스 3)을 소유한다.
//
// "접수 마무리"(임베드 오더등록 폼) 설계 — 계획 문서 참고:
// legacy는 대화창 옆에 나란히 폼을 배치했지만, OrderForm.js가 쓰는 .order-grid(3열,
// 최소폭 970px)를 그렇게 욱여넣으면 레이아웃이 깨진다(미디어쿼리는 그리드 아이템 폭이
// 아니라 브라우저 뷰포트 폭 기준이라 자동으로 안 줄어듦). 그래서 나란히 배치 대신
// "대화"/"접수 마무리" 탭 토글로 바꿔서, 탭 전환 시 뷰어 패널 전체 폭으로 OrderForm을
// 보여준다 — 기능은 legacy와 100% 동일(같은 POST /orders, 같은 chat_session_id/
// chat_session_transition 연동), 시각적 배치만 다르다(공개적으로 문서화하는 변경).
//
// intakeEnabled는 카드뷰 자체 플래그(NEXT_STAGE3_CHAT_CARDS_ENABLED)와 별개로
// NEXT_STAGE3_CHAT_INTAKE_ENABLED로 게이팅 — 카드뷰 전체를 끄지 않고 이 탭만 롤백 가능.
//
// 목록 실시간 갱신: legacy는 헤더의 상시 agent-presence SSE가 쏘는 'agent-needs-count'
// 커스텀 이벤트를 재사용해 "새 상담 업데이트 보기" 버튼만 띄우고 전체 새로고침으로
// 반영했다(SSE 이중연결 방지). 이 컴포넌트도 같은 이벤트를 재사용하되, 전체 페이지
// 리로드 대신 카드 목록만 다시 fetch한다 — 현재 선택된 대화가 끊기지 않는 개선.

const STATUS_BADGE = { bot: 'gray', needs_agent: 'red', agent_active: 'blue', closed: 'dark' };

export default function CardBoard({ initialSessions, initialOnlineAgents, currentUser, intakeEnabled }) {
  const [sessions, setSessions] = useState(initialSessions || []);
  const [onlineAgents, setOnlineAgents] = useState(initialOnlineAgents || []);
  const [showRefreshBtn, setShowRefreshBtn] = useState(false);
  const [selected, setSelected] = useState(null); // { id, status, assignedAgentId, assignedAgentName }
  const [viewerTab, setViewerTab] = useState('chat'); // 'chat' | 'intake'
  const [orderMasterData, setOrderMasterData] = useState(null); // branches/groups/paymentMethods/favorites (한 번만 fetch)
  const [intakePrefill, setIntakePrefill] = useState(null);
  const [intakeLoading, setIntakeLoading] = useState(false);

  useEffect(() => {
    function onNeedsCount(e) {
      if (e.detail && e.detail.initial) return;
      setShowRefreshBtn(true);
    }
    window.addEventListener('agent-needs-count', onNeedsCount);
    return () => window.removeEventListener('agent-needs-count', onNeedsCount);
  }, []);

  function selectSession(s) {
    if (selected && selected.id === s.id) return;
    setSelected({ id: s.id, status: s.status, assignedAgentId: s.assigned_agent_id ? String(s.assigned_agent_id) : '', assignedAgentName: s.assigned_agent_name || '' });
    setViewerTab('chat');
    setIntakePrefill(null);
  }

  function openIntakeTab() {
    if (!selected) return;
    setViewerTab('intake');
    setIntakeLoading(true);
    const masterPromise = orderMasterData ? Promise.resolve(orderMasterData) : fetchJson('/orders/new/data.json').then((data) => { setOrderMasterData(data); return data; });
    Promise.all([masterPromise, fetchJson(`/chat/sessions/${selected.id}/intake-order`)])
      .then(([, intake]) => {
        setIntakePrefill((intake && intake.intakeOrder) || {});
      })
      .catch(() => setIntakePrefill({}))
      .finally(() => setIntakeLoading(false));
  }

  function handleStatusChange(patch) {
    setSelected((prev) => (prev ? { ...prev, ...patch } : prev));
    setSessions((prev) => prev.map((s) => {
      if (!selected || s.id !== selected.id) return s;
      const next = { ...s };
      if (patch.status) next.status = patch.status;
      if (patch.assignedAgentId !== undefined) next.assigned_agent_id = patch.assignedAgentId;
      if (patch.assignedAgentName !== undefined) next.assigned_agent_name = patch.assignedAgentName;
      return next;
    }));
  }

  function handleDeleted() {
    setSessions((prev) => prev.filter((s) => s.id !== selected.id));
    setSelected(null);
  }

  function deleteCardFromList(sessionId) {
    if (!window.confirm('이 상담 세션을 삭제하시겠습니까?')) return;
    fetchJson(`/chat/sessions/${sessionId}/delete`, { method: 'POST' })
      .then(() => {
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        if (selected && selected.id === sessionId) setSelected(null);
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
                <button type="button" className="btn danger small session-card-delete-btn" title="이 세션 삭제" onClick={() => deleteCardFromList(s.id)}>삭제</button>
              </div>
            </div>
          ))}
        </div>

        <div className="card chat-admin-viewer">
          {/* chat-admin-viewer-shell은 원래 두 번째 grid 컬럼(임베드 오더등록 패널)까지
              전제하는데, 나란히 배치 대신 탭 토글로 바꿨으므로(파일 상단 주석 참고) 항상
              1열 그리드를 강제한다. */}
          <div className="chat-admin-viewer-shell" style={{ gridTemplateColumns: '1fr' }}>
            <section className="chat-admin-conversation">
              <div className="chat-admin-viewer-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                {selected ? (
                  <div>
                    <h2>상담 #{selected.id}</h2>
                    <p className="page-sub">
                      <span className={`badge ${STATUS_BADGE[selected.status] || 'gray'}`}>{STATUS_LABEL[selected.status] || selected.status}</span>
                      <span style={{ marginLeft: 8 }}>담당자: {selected.assignedAgentName || '미지정'}</span>
                    </p>
                  </div>
                ) : (
                  <div>
                    <h2>세션을 선택하세요</h2>
                    <p className="page-sub">카드를 선택하면 해당 세션의 최근 대화를 불러옵니다. 전체 세션 메시지는 한 번에 로드하지 않습니다.</p>
                  </div>
                )}
                {selected && intakeEnabled && (
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button type="button" className={`btn small ${viewerTab === 'chat' ? '' : 'secondary'}`} onClick={() => setViewerTab('chat')}>💬 대화</button>
                    <button type="button" className={`btn small ${viewerTab === 'intake' ? '' : 'secondary'}`} onClick={openIntakeTab}>📋 접수 마무리</button>
                  </div>
                )}
              </div>

              {selected && viewerTab === 'intake' ? (
                intakeLoading || !orderMasterData || !intakePrefill ? (
                  <div className="empty">접수 초안을 불러오는 중...</div>
                ) : (
                  <OrderForm
                    key={selected.id}
                    chatSessionId={selected.id}
                    initialData={{ ...orderMasterData, order: { ...orderMasterData.order, ...intakePrefill } }}
                  />
                )
              ) : (
                <SessionViewer
                  sessionId={selected ? selected.id : null}
                  status={selected ? selected.status : null}
                  assignedAgentId={selected ? selected.assignedAgentId : ''}
                  assignedAgentName={selected ? selected.assignedAgentName : ''}
                  currentUser={currentUser}
                  onStatusChange={handleStatusChange}
                  onDeleted={handleDeleted}
                  extraActions={selected && (
                    <>
                      <a className="btn small" href={`/chat/sessions/${selected.id}`}>상세 페이지 열기</a>
                      {!intakeEnabled && (
                        <a className="btn small" href="/orders/new" target="_blank" rel="noreferrer">오더 등록으로 이동</a>
                      )}
                    </>
                  )}
                />
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
