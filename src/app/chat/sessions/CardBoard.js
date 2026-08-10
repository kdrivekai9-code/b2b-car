'use client';

import { useEffect, useRef, useState } from 'react';
import SessionViewer, { STATUS_LABEL, fetchJson } from './SessionViewer';
import IntakeMiniForm from './IntakeMiniForm';

// public/js/chat-session-cards.js(1111줄)를 React로 이식 — 상담 카드뷰의 핵심 화면.
// 메시지/SSE/답장/담당지정(self)/삭제는 SessionViewer.js(슬라이스 2에서 상세페이지와
// 공유하도록 추출)가 담당하고, 이 파일은 좌측 카드 목록(신규/변경 시 자동 갱신) + 상단
// 헤더 + "접수 마무리" 패널(슬라이스 3)을 소유한다.
//
// "접수 마무리"(임베드 오더등록 폼) — legacy와 동일하게 대화창 옆에 상시 2단으로 나란히
// 띄운다(.chat-admin-viewer-shell의 공유 2열 그리드, style.css). 폼 자체도 /orders/new의
// 전체 OrderForm이 아니라 legacy의 #cardOrderForm 전용 미니폼을 그대로 이식한
// IntakeMiniForm.js를 쓴다(지도·프리미엄/일일기사 필드·즐겨찾기 없음, 필드 순서/라벨까지
// legacy와 동일) — 자세한 배경은 그 파일 상단 주석 참고.
//
// intakeEnabled는 카드뷰 자체 플래그(NEXT_STAGE3_CHAT_CARDS_ENABLED)와 별개로
// NEXT_STAGE3_CHAT_INTAKE_ENABLED로 게이팅 — 카드뷰 전체를 끄지 않고 이 패널만 롤백 가능
// (꺼져있으면 대화 패널만 1열 전체 폭으로 보여준다).
//
// 목록 실시간 갱신: legacy는 헤더의 상시 agent-presence SSE가 쏘는 'agent-needs-count'
// 커스텀 이벤트를 재사용해 "새 상담 업데이트 보기" 버튼만 띄우고 전체 새로고침으로
// 반영했다(SSE 이중연결 방지). 이 컴포넌트도 같은 이벤트를 재사용하되, 전체 페이지
// 리로드 대신 카드 목록만 다시 fetch한다 — 현재 선택된 대화가 끊기지 않는 개선.
// 버튼을 다시 눌러야 반영되는 게 불편하다는 피드백으로, 신호가 오면 목록만 자동으로
// 다시 fetch한다(짧은 시간에 여러 신호가 연달아 오면 debounce로 한 번만 반영). 선택된
// 대화(selected)는 이 fetch로 건드리지 않으므로 답장 입력 중이어도 끊기지 않는다.

const STATUS_BADGE = { bot: 'gray', needs_agent: 'red', agent_active: 'blue', closed: 'dark' };

// 카카오 세션의 표시 이름 — 매핑된 거래처가 있으면 "거래처명(담당자)"로, 없으면 기본 이름
// (동의 전이면 "카카오 상담톡 고객 (UserKey)")으로 보여준다.
function sessionDisplayName(s) {
  if (s.channel === 'kakao' && (s.mapped_group_name || s.mapped_user_name)) {
    if (s.mapped_group_name && s.mapped_user_name) return `${s.mapped_group_name}(${s.mapped_user_name})`;
    return s.mapped_group_name || s.mapped_user_name;
  }
  return s.user_name || '-';
}

export default function CardBoard({ initialSessions, initialOnlineAgents, currentUser, intakeEnabled }) {
  const [sessions, setSessions] = useState(initialSessions || []);
  const [onlineAgents, setOnlineAgents] = useState(initialOnlineAgents || []);
  // { id, status, assignedAgentId, assignedAgentName, userName, userRole, userPhone, requestedFeature, updatedAt }
  const [selected, setSelected] = useState(null);
  const [orderMasterData, setOrderMasterData] = useState(null); // branches/groups/paymentMethods/favorites (한 번만 fetch)
  const [intakePrefill, setIntakePrefill] = useState(null);
  const [intakeLoading, setIntakeLoading] = useState(false);
  const intakeRefreshTimerRef = useRef(null);
  const listRefreshTimerRef = useRef(null);
  const selectedIdRef = useRef(null);
  selectedIdRef.current = selected ? selected.id : null;

  useEffect(() => {
    function onNeedsCount(e) {
      if (e.detail && e.detail.initial) return;
      clearTimeout(listRefreshTimerRef.current);
      listRefreshTimerRef.current = setTimeout(refreshList, 400);
    }
    window.addEventListener('agent-needs-count', onNeedsCount);

    // 이벤트만 믿지 않는다. 이 신호는 헤더의 agent-presence SSE → Supabase Realtime 브로드캐스트를
    // 거쳐 오는데, 그 사슬 어디가 끊겨도(서버리스에서 SSE가 잘리거나 브로드캐스트가 유실되면)
    // 화면을 열어둔 채로는 새 고객 발화가 영영 안 보인다. 목록은 가벼운 조회라 주기적으로도
    // 다시 읽는다 — 실측으로 카카오 고객 메시지가 목록에 안 뜨던 문제의 마지막 안전장치다.
    const listPoll = setInterval(() => {
      if (document.hidden) return; // 백그라운드 탭에서는 돌리지 않는다
      refreshList();
    }, 10000);

    // 다른 탭에 갔다 돌아오면 그동안 놓친 것을 즉시 따라잡는다.
    function onVisible() { if (!document.hidden) refreshList(); }
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.removeEventListener('agent-needs-count', onNeedsCount);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(listPoll);
      clearTimeout(listRefreshTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // legacy(public/js/chat-session-cards.js L1061)는 페이지 진입 시 첫 번째 카드를 자동으로
  // 선택해서 보여준다 — 목록만 뜨고 대화가 비어있는 화면으로 시작하지 않도록 그대로 재현.
  useEffect(() => {
    if (!selected && sessions.length > 0) selectSession(sessions[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  function selectSession(s) {
    if (selected && selected.id === s.id) return;
    setSelected({
      id: s.id,
      status: s.status,
      assignedAgentId: s.assigned_agent_id ? String(s.assigned_agent_id) : '',
      assignedAgentName: s.assigned_agent_name || '',
      userName: sessionDisplayName(s),
      userRole: s.user_role || '-',
      userPhone: s.user_phone || '',
      requestedFeature: s.requested_feature || '-',
      updatedAt: s.updated_at || '-',
    });
    setIntakePrefill(null);
    if (intakeEnabled) loadIntakeDraft(s.id);
  }

  function loadIntakeDraft(sessionId) {
    setIntakeLoading(true);
    const masterPromise = orderMasterData ? Promise.resolve(orderMasterData) : fetchJson('/orders/new/data.json').then((data) => { setOrderMasterData(data); return data; });
    Promise.all([masterPromise, fetchJson(`/chat/sessions/${sessionId}/intake-order`)])
      .then(([, intake]) => {
        setIntakePrefill((intake && intake.intakeOrder) || {});
      })
      .catch(() => setIntakePrefill({}))
      .finally(() => setIntakeLoading(false));
  }

  // 고객이 AI 접수 챗봇에서 계속 답변하면 chat_sessions.draft_json이 바뀌는데, 접수 마무리
  // 패널은 세션을 선택한 시점에 한 번만 로드해서 이후 답변(연락처/요청사항/요금 등)이 반영되지
  // 않았다 — SessionViewer가 새 고객 메시지를 받을 때마다(onNewMessage) 초안을 조용히
  // 다시 불러와 갱신한다(로딩 상태로 폼을 가리지 않음, 여러 메시지가 연달아 와도 한 번만
  // 반영되도록 짧게 디바운스).
  function handleNewCustomerMessage() {
    if (!intakeEnabled || !selected) return;
    const sessionId = selected.id;
    clearTimeout(intakeRefreshTimerRef.current);
    intakeRefreshTimerRef.current = setTimeout(() => {
      fetchJson(`/chat/sessions/${sessionId}/intake-order`)
        .then((intake) => {
          if (selectedIdRef.current !== sessionId) return; // 그 사이 다른 세션으로 전환됨
          setIntakePrefill((intake && intake.intakeOrder) || {});
        })
        .catch(() => {});
    }, 600);
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
          <a className="btn secondary" href="/quick-replies">⚡ 빠른 답변 관리</a>
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
                  <strong>#{s.id} · {sessionDisplayName(s)}</strong>
                  <span>
                    {/* 답장이 카카오로 나가는 세션인지 상담원이 바로 알아야 한다(응대 톤·속도가 다르다). */}
                    {s.channel === 'kakao' && <span className="badge amber">카카오</span>}
                    <span className={`badge ${STATUS_BADGE[s.status] || 'gray'}`}>{STATUS_LABEL[s.status] || s.status}</span>
                  </span>
                </div>
                {/* 카드 위쪽에 카카오 배지가 이미 있어 역할을 또 적지 않는다. 거래처는 이름줄에서
                    이미 보여주므로 여기선 연락처만 둔다. */}
                <div className="session-card-sub">{s.channel === 'kakao' ? (s.user_phone || '연락처 미확인') : `${s.user_role || '-'}${s.user_phone ? ` · ${s.user_phone}` : ''}`}</div>
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
          <div className="chat-admin-viewer-shell" style={intakeEnabled ? undefined : { gridTemplateColumns: '1fr' }}>
            <section className="chat-admin-conversation">
              <div className="chat-admin-viewer-head" id="cardViewerHead">
                {selected ? (
                  <div>
                    <h2>상담 #{selected.id} · {selected.userName}</h2>
                    <p className="page-sub">
                      <span className={`badge ${STATUS_BADGE[selected.status] || 'gray'}`}>{STATUS_LABEL[selected.status] || selected.status}</span>
                      <span style={{ marginLeft: 8 }}>{selected.userRole}{selected.userPhone ? ` · ${selected.userPhone}` : ''}</span>
                      <span style={{ marginLeft: 8 }}>요청 기능: {selected.requestedFeature}</span>
                      <span style={{ marginLeft: 8 }}>담당자: {selected.assignedAgentName || '미지정'}</span>
                      <span style={{ marginLeft: 8 }}>업데이트: {selected.updatedAt}</span>
                    </p>
                  </div>
                ) : (
                  <div>
                    <h2>세션을 선택하세요</h2>
                    <p className="page-sub">카드를 선택하면 해당 세션의 최근 대화를 불러옵니다. 전체 세션 메시지는 한 번에 로드하지 않습니다.</p>
                  </div>
                )}
              </div>

              <SessionViewer
                sessionId={selected ? selected.id : null}
                status={selected ? selected.status : null}
                assignedAgentId={selected ? selected.assignedAgentId : ''}
                assignedAgentName={selected ? selected.assignedAgentName : ''}
                currentUser={currentUser}
                onStatusChange={handleStatusChange}
                onDeleted={handleDeleted}
                onNewMessage={handleNewCustomerMessage}
                extraActions={selected && (
                  <>
                    <a className="btn small" href={`/chat/sessions/${selected.id}`}>상세 페이지 열기</a>
                    {!intakeEnabled && (
                      <a className="btn small" href="/orders/new" target="_blank" rel="noreferrer">오더 등록으로 이동</a>
                    )}
                  </>
                )}
              />
            </section>

            {intakeEnabled && (
              <section className="chat-admin-intake">
                <div className="chat-order-head">
                  <h2>접수 마무리</h2>
                </div>
                {!selected ? (
                  <div className="empty">세션을 선택하면 접수 초안이 표시됩니다.</div>
                ) : intakeLoading || !orderMasterData || !intakePrefill ? (
                  <div className="empty">접수 초안을 불러오는 중...</div>
                ) : (
                  <IntakeMiniForm
                    key={selected.id}
                    chatSessionId={selected.id}
                    branches={orderMasterData.branches}
                    groups={orderMasterData.groups}
                    paymentMethods={orderMasterData.paymentMethods}
                    order={{ ...orderMasterData.order, ...intakePrefill }}
                  />
                )}
              </section>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
