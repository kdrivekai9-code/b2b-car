'use client';

// OrderForm.js의 edit 모드에서 03번(RouteMap 자리)을 대체하는 패널 — "경로 미리보기" 대신
// 기사배정 정보 + 오더수정이력을 보여준다. 기사배정은 admin/branch_manager만 실제로 바꿀 수
// 있고(기존 POST /:id/driver, /:id/legs/drivers 그대로 재사용, 순수 <form> POST), client는
// 읽기전용으로만 본다. 수정이력은 routes/orders.js의 POST /:id가 남기는 note(바뀐 필드
// 한글 라벨 목록, 예: "요금, 고객사 메모 수정")를 그대로 노출해 "실제 수정사항"을 보여준다.
function historyLabel(h) {
  if (h.old_status == null) return `최초 등록: ${h.new_status}`;
  if (h.old_status === h.new_status) return '정보 수정';
  return `${h.old_status} → ${h.new_status}`;
}

// 귀속정보(지사/요청법인)와 오더타입(order_type/trip_type)은 OrderForm.js의 useReducer
// state에 속한 값이라 그 컴포넌트가 state/setField를 그대로 넘겨준다. 이 필드들은
// OrderForm의 <form id="order-edit-form">이 아니라 여기(03번 패널) 안의 별도
// <form>(제출 없음, onSubmit을 막아둠)에 있는데, 두 가지 이유가 있다:
//   1) .row/.field CSS는 `form .row`/`form .field`처럼 form 조상이 있어야만 레이아웃이
//      적용되므로(public/css/style.css) 아무 form도 없이 두면 스타일이 깨진다.
//   2) 지사 선택의 required 검증이 실제 저장(오더수정) 제출을 막아야 하는데, 그 제출은
//      상단 헤더의 버튼이 order-edit-form을 가리키며 일어난다 — 그래서 각 select에
//      form="order-edit-form"을 직접 지정해 실제로 검증될 폼을 명시한다(DOM상 어느
//      <form>에 들어있는지와는 무관하게 이 속성이 우선한다).
function AttributionAndOrderTypeFields({ state, setField, branches, groups, isAdmin, isClient }) {
  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <div className="section-title small">귀속 정보</div>
      <div className="row">
        {isAdmin ? (
          <div className="field">
            <label>지사 선택 <span className="required-mark" aria-hidden="true">*</span></label>
            <select required form="order-edit-form" value={state.branch_id} onChange={(e) => setField('branch_id', e.target.value)}>
              <option value="">선택하세요</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
        ) : null}
        {!isClient ? (
          <div className="field">
            <label>요청 법인(고객사)</label>
            <select form="order-edit-form" value={state.requester_group_id} onChange={(e) => setField('requester_group_id', e.target.value)}>
              <option value="">선택 안 함</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <div className="section-title small">오더 타입</div>
      <div className="row">
        <div className="field">
          <label>오더 타입</label>
          <select form="order-edit-form" value={state.order_type || 'dispatch'} onChange={(e) => setField('order_type', e.target.value)}>
            <option value="dispatch">탁송</option>
            <option value="premium">프리미엄</option>
            <option value="daily_driver">일일기사</option>
          </select>
        </div>
        <div className="field">
          <label>이용 형태 (일일기사)</label>
          <select form="order-edit-form" value={state.trip_type || ''} onChange={(e) => setField('trip_type', e.target.value)}>
            <option value="">해당 없음</option>
            <option value="round_trip">왕복</option>
            <option value="one_way">편도</option>
          </select>
        </div>
      </div>
    </form>
  );
}

export default function OrderSidePanel({ data, orderId, state, setField }) {
  const { order, legs, drivers, history, baseUrl, currentUserRole, ORDER_STATUSES, branches, groups } = data;
  const canManageDriver = currentUserRole === 'admin' || currentUserRole === 'branch_manager';
  const isAdmin = currentUserRole === 'admin';
  const isClient = currentUserRole === 'client';

  return (
    <section className="card order-panel order-map-panel">
      <div className="panel-title compact">
        <div className="panel-icon">03</div>
        <div><h2>기사배정 · 수정이력</h2><p>배정된 기사와 이 오더의 수정 내역을 확인합니다.</p></div>
      </div>

      <AttributionAndOrderTypeFields
        state={state} setField={setField} branches={branches} groups={groups}
        isAdmin={isAdmin} isClient={isClient}
      />

      <div className="section-title small">🧑‍✈️ 기사배정 정보</div>
      {canManageDriver ? (
        legs && legs.length > 0 ? (
          <form method="POST" action={`/orders/${orderId}/legs/drivers`}>
            {legs.map((leg) => (
              <div className="row" style={{ alignItems: 'center' }} key={leg.seq}>
                <div className="field" style={{ flex: '0 0 auto', minWidth: 220 }}>
                  <label>구간 {leg.seq}: {leg.fromLabel} → {leg.toLabel}</label>
                  <input type="hidden" name="leg_seq" value={leg.seq} />
                  <select name="leg_driver_id" defaultValue={leg.driverId || ''}>
                    <option value="">미배정</option>
                    {drivers.map((d) => (
                      <option key={d.id} value={d.id}>{d.name} ({d.phone || '연락처 없음'})</option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
            <button className="btn small" type="submit">구간별 배정 저장</button>
          </form>
        ) : (
          <form method="POST" action={`/orders/${orderId}/driver`}>
            <div className="row">
              <div className="field">
                <label>기사 선택</label>
                <select name="driver_id" defaultValue={order.assigned_driver_id || ''}>
                  <option value="">미배정</option>
                  {drivers.map((d) => (
                    <option key={d.id} value={d.id}>{d.name} ({d.phone || '연락처 없음'})</option>
                  ))}
                </select>
              </div>
            </div>
            <button className="btn small" type="submit">배정 저장</button>
          </form>
        )
      ) : (
        <div className="kv"><span className="k">배정 기사</span><span>{order.driver_name || '미배정'}</span></div>
      )}

      {canManageDriver && (
        <>
          <div className="section-title small">사진 업로드 링크(기사 전달용, 로그인 불필요)</div>
          <input type="text" className="photo-link-input" readOnly
            value={`${baseUrl}/upload/${order.photo_upload_token}`}
            onClick={(e) => e.target.select()} />
        </>
      )}

      {currentUserRole === 'admin' && (
        <>
          <div className="section-title small">오더 타입 변경</div>
          <form method="POST" action={`/orders/${orderId}/order-type`} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select name="order_type" defaultValue={order.order_type || 'dispatch'} style={{ flex: '0 0 auto', minWidth: 120 }}>
              <option value="dispatch">탁송</option>
              <option value="premium">프리미엄</option>
              <option value="daily_driver">일일기사</option>
            </select>
            <button className="btn small secondary" type="submit">변경</button>
          </form>
        </>
      )}

      <div className="section-title small">오더수정이력</div>
      <ul className="timeline">
        {history.map((h) => (
          <li key={h.id}>
            <b>{historyLabel(h)}</b>
            <div className="meta">{h.actor_name || '시스템'} · {h.created_at}{h.note ? ` · ${h.note}` : ''}</div>
          </li>
        ))}
      </ul>

      {/* 상태 변경은 페이지 맨 아래 관리자 패널에 따로 있었는데, 기사배정·수정이력을 보고
          바로 상태를 바꾸는 흐름이 자연스러워서 이 패널 아래로 옮겼다(사용자 요청).
          POST /:id/status는 콜마너 등록 트리거이기도 하다(routes/orders.js). */}
      {canManageDriver && (
        <>
          <div className="section-title small">오더 상태 변경</div>
          <form method="POST" action={`/orders/${orderId}/status`}>
            <div className="row">
              <div className="field">
                <label>새 상태</label>
                <select name="status" defaultValue={order.status}>
                  {(ORDER_STATUSES || []).map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <div className="row">
              <div className="field full">
                <label>사유/메모 (선택)</label>
                <input type="text" name="note" placeholder="변경 사유" />
              </div>
            </div>
            <button className="btn" type="submit">상태 변경 저장</button>
          </form>
        </>
      )}
    </section>
  );
}
