'use client';

import { useState } from 'react';
import SessionViewer, { STATUS_LABEL, fetchJson } from './SessionViewer';

const STATUS_BADGE = { bot: 'gray', needs_agent: 'red', agent_active: 'blue', closed: 'dark' };

// 담당자명이 거래처명으로 시작하면(예: "서울모터스 채정식") 괄호 앞 회사명과 겹치므로 뗀다.
function personOnly(group, user) {
  if (!user) return user;
  if (group && user.indexOf(group) === 0) {
    const rest = user.slice(group.length).replace(/^[\s·\-]+/, '').trim();
    return rest || user;
  }
  return user;
}

// session_detail.ejs 이식. 메시지/SSE/답장/담당지정(self)/삭제는 SessionViewer가 담당하고,
// 이 화면 고유 기능 3개(다른 상담원 지정 드롭다운/종료/봇복귀)만 여기서 구현한다 — 카드뷰엔
// 없는 기능들이다(조사 결과, session_detail.ejs L51-96 참고). "내가 담당하기"는
// SessionViewer의 액션바에 이미 있어 중복 렌더링하지 않고, 이 화면 상단엔 "다른 상담원
// 지정" 드롭다운만 별도로 둔다(legacy는 두 폼이 나란히 있었지만, 액션이 겹치는 걸 피하려고
// 위치만 재배치 — 기능 자체는 동일).
export default function SessionDetailView({ initialSession, mappedAccount, agents, currentUser }) {
  const [session, setSession] = useState(initialSession);
  const [assignAgentId, setAssignAgentId] = useState('');
  const [isAssigning, setIsAssigning] = useState(false);
  const [actionError, setActionError] = useState('');

  function applyPatch(patch) {
    setSession((prev) => ({
      ...prev,
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.assignedAgentId !== undefined ? { assigned_agent_id: patch.assignedAgentId } : {}),
      ...(patch.assignedAgentName !== undefined ? { assigned_agent_name: patch.assignedAgentName } : {}),
    }));
  }

  function assignToAgent(e) {
    e.preventDefault();
    if (!assignAgentId || isAssigning) return;
    setIsAssigning(true);
    setActionError('');
    fetchJson(`/chat/sessions/${session.id}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: assignAgentId }),
    })
      .then((data) => {
        applyPatch({ assignedAgentId: String(data.assignedAgentId), assignedAgentName: data.assignedAgentName });
        setAssignAgentId('');
      })
      .catch((err) => setActionError(err.message || '담당자 지정에 실패했습니다.'))
      .finally(() => setIsAssigning(false));
  }

  function closeSession() {
    if (!window.confirm('이 상담을 종료하시겠습니까?')) return;
    fetchJson(`/chat/sessions/${session.id}/close`, { method: 'POST' })
      .then(() => window.location.assign('/chat/sessions'))
      .catch((err) => setActionError(err.message || '상담 종료에 실패했습니다.'));
  }

  function returnToBot() {
    fetchJson(`/chat/sessions/${session.id}/return-to-bot`, { method: 'POST' })
      .then(() => applyPatch({ status: 'bot', assignedAgentId: '', assignedAgentName: '' }))
      .catch((err) => setActionError(err.message || '봇 복귀에 실패했습니다.'));
  }

  const isClosed = session.status === 'closed';

  return (
    <>
      <div className="page-head-row">
        <div>
          <h1 className="page-title">
            상담 #{session.id} <span className={`badge ${STATUS_BADGE[session.status] || 'gray'}`}>{STATUS_LABEL[session.status] || session.status}</span>
          </h1>
          <p className="page-sub">
            {/* 카카오 세션은 아래 배지가 채널을 말해준다 — 역할까지 적으면 중복이다.
                매핑된 거래처가 있으면 이름줄을 "거래처명(담당자)"로 보여준다. */}
            고객: {(session.channel === 'kakao' && mappedAccount && (mappedAccount.groupName || mappedAccount.userName))
              ? (mappedAccount.groupName && mappedAccount.userName
                ? `${mappedAccount.groupName}(${personOnly(mappedAccount.groupName, mappedAccount.userName)})`
                : (mappedAccount.groupName || mappedAccount.userName))
              : (session.user_name || '-')}{session.channel === 'kakao' ? '' : ` (${session.user_role || '-'})`}{session.user_phone ? ` · ${session.user_phone}` : ''}
            {/* 여기서 보내는 답장이 카카오 상담톡으로 나간다는 걸 입력 전에 알 수 있어야 한다. */}
            {session.channel === 'kakao' && <span className="badge amber">카카오 상담톡</span>}
          </p>
          {/* 거래처·담당자는 위 이름줄에 이미 있으므로, 여기선 지사·자동접수만 보조로 밝힌다. */}
          {mappedAccount && (
            <p className="page-sub mapped-account">
              <span className="badge green">매핑</span>
              {mappedAccount.branchName ? ` ${mappedAccount.branchName}` : ''}
              {mappedAccount.autoRegister && <span className="badge blue">자동접수</span>}
            </p>
          )}
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/chat/sessions">← 목록으로</a>
          <a className="btn secondary" href="/orders/ai-intake">AI 접수 화면</a>
        </div>
      </div>

      {/* 두 칸(대화 | 접수 마무리) — EJS(views/chat/session_detail.ejs)와 같은 .chat-workspace-grid를
          쓴다. 이식할 때 감싸는 칸과 둘째 칸이 통째로 빠져서, 상담원이 이 화면에서 접수로 가는
          길을 잃었다(머리말의 "AI 접수 화면"은 챗봇 화면이라 가리키는 곳이 다르다). */}
      <div className="chat-workspace-grid">
      <section className="card chat-workspace-chat">
        <div className="session-meta">
          <span>요청 기능: <b>{session.requested_feature || '-'}</b></span>
          <span>담당 상담원: <b>{session.assigned_agent_name || '미배정'}</b></span>
          <span>생성일시: <b>{session.created_at}</b></span>
          <span>최근 업데이트: <b>{session.updated_at}</b></span>
        </div>

        {!isClosed && (
          <form onSubmit={assignToAgent} className="session-meta" style={{ marginTop: -4 }}>
            <label htmlFor="assign_agent_id" style={{ fontSize: 12, color: 'var(--muted)' }}>담당자 변경</label>
            <select id="assign_agent_id" value={assignAgentId} onChange={(e) => setAssignAgentId(e.target.value)} required>
              <option value="">상담원 선택</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <button className="btn small secondary" type="submit" disabled={isAssigning || !assignAgentId}>지정</button>
          </form>
        )}
        {actionError && <div className="chat-inline-error">{actionError}</div>}

        <SessionViewer
          sessionId={session.id}
          status={session.status}
          assignedAgentId={session.assigned_agent_id ? String(session.assigned_agent_id) : ''}
          assignedAgentName={session.assigned_agent_name || ''}
          currentUser={currentUser}
          autoLoadAll
          onStatusChange={applyPatch}
          onDeleted={() => window.location.assign('/chat/sessions')}
          extraActions={!isClosed && (
            <>
              {session.status === 'agent_active' && (
                <button className="btn small secondary" type="button" onClick={returnToBot}>봇에게 되돌리기</button>
              )}
              <button className="btn small secondary" type="button" onClick={closeSession}>상담 종료</button>
            </>
          )}
        />
      </section>

      {/* 접수 마무리는 상담관리 카드 보기로 옮겨졌다 — 여기서는 그리로 가는 길만 알려준다.
          문구와 링크를 EJS와 같게 맞춘다(한쪽만 바뀌면 화면에 따라 다른 곳으로 간다). */}
      <section className="card chat-workspace-order">
        <div className="chat-order-head">
          <h2>접수 마무리</h2>
          <p className="page-sub">접수 마무리 섹션은 상담관리 화면(카드 보기)으로 이동되었습니다.</p>
          <a className="btn" href="/chat/sessions?view=card">상담관리에서 접수하기</a>
        </div>
      </section>
      </div>
    </>
  );
}
