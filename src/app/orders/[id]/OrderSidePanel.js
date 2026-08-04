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

export default function OrderSidePanel({ data, orderId }) {
  const { order, legs, drivers, history, baseUrl, currentUserRole, ORDER_STATUSES } = data;
  const canManageDriver = currentUserRole === 'admin' || currentUserRole === 'branch_manager';

  return (
    <section className="card order-panel order-map-panel">
      <div className="panel-title compact">
        <div className="panel-icon">03</div>
        <div><h2>기사배정 · 수정이력</h2><p>배정된 기사와 이 오더의 수정 내역을 확인합니다.</p></div>
      </div>

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
