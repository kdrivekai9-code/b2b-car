'use client';

// admin/branch_manager 전용 관리자 패널 4개 — views/orders/detail.ejs의 상태변경/기사배정
// (구간별)/사진/변경이력 카드를 그대로 이식. 상태변경·기사배정(단일/구간별)은 기존 라우트
// (POST /:id/status, /:id/driver, /:id/legs/drivers)를 그대로 재사용하는 순수 HTML
// <form> POST라 fetch 없이도 동작한다 — 제출하면 브라우저가 리다이렉트를 따라가고, 그
// 요청이 다시 이 페이지(같은 NEXT_ORDER_DETAIL_EDIT_ENABLED 플래그 경로)로 돌아온다.
// 관리자 메모만 이번에 새로 추가한 POST /:id/admin-memo를 쓴다(기존 POST /:id/fare는
// legacy 화면 전용으로 완전히 그대로 남겨둠 — 계획 문서 참고).
export default function OrderDetailAdminPanels({ data, orderId }) {
  const { order, drivers, legs, history, canViewPhotos, photos, ORDER_STATUSES, baseUrl } = data;

  return (
    <>
      <div className="card">
        <h2>상태 변경</h2>
        <form method="POST" action={`/orders/${orderId}/status`}>
          <div className="row">
            <div className="field">
              <label>새 상태</label>
              <select name="status" defaultValue={order.status}>
                {ORDER_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="row"><div className="field full"><label>사유/메모 (선택)</label><input type="text" name="note" placeholder="변경 사유" /></div></div>
          <button className="btn" type="submit">상태 변경 저장</button>
        </form>
      </div>

      <div className="card">
        <h2>🧑‍✈️ 기사 배정</h2>
        {legs && legs.length > 0 ? (
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
            <button className="btn" type="submit">구간별 배정 저장</button>
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
            <button className="btn" type="submit">배정 저장</button>
          </form>
        )}
        <div className="section-title small">사진 업로드 링크(기사 전달용, 로그인 불필요)</div>
        <input type="text" className="photo-link-input" readOnly
          value={`${baseUrl}/upload/${order.photo_upload_token}`}
          onClick={(e) => e.target.select()} />
      </div>

      <div className="card">
        <h2>관리자 메모</h2>
        <form method="POST" action={`/orders/${orderId}/admin-memo`}>
          <div className="row"><div className="field full"><label>관리자 메모(내부용)</label><textarea name="memo_admin" defaultValue={order.memo_admin || ''} /></div></div>
          <button className="btn" type="submit">저장</button>
        </form>
      </div>

      {canViewPhotos && (
        <div className="card">
          <h2>📷 기사 업로드 사진</h2>
          {photos.length === 0 ? (
            <p className="page-sub" style={{ margin: 0 }}>업로드된 사진이 없습니다.</p>
          ) : (
            <div className="upload-gallery">
              {photos.map((p) => (
                <a key={p.id} href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt="업로드된 사진" /></a>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>변경 이력</h2>
        <ul className="timeline">
          {history.map((h) => (
            <li key={h.id}>
              <b>{h.old_status ? `${h.old_status} → ${h.new_status}` : `최초 등록: ${h.new_status}`}</b>
              <div className="meta">{h.actor_name || '시스템'} · {h.created_at}{h.note ? ` · ${h.note}` : ''}</div>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
