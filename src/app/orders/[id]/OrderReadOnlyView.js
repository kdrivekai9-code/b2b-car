// client 역할 전용 읽기전용 상세 뷰 — views/orders/detail.ejs의 kv 카드를 그대로 이식.
// OrderForm(수정 폼)은 admin/branch_manager만 보고, client는 지금까지와 동일하게 이 화면만
// 본다(폼 컴포넌트 자체가 필요 없는 단순 kv 나열).
function formatMoney(n) {
  return (Number(n) || 0).toLocaleString('ko-KR') + '원';
}

export default function OrderReadOnlyView({ data }) {
  const { order, rawWaypoints, canViewPhotos, photos, history } = data;
  const waypoints = rawWaypoints || [];

  return (
    <div className="detail-grid" style={{ marginTop: 18 }}>
      <div className="card">
        <h2>📍 이동 경로</h2>
        <div className="kv"><span className="k">출발지</span><span>{order.origin_address}{order.origin_detail_address ? ' ' + order.origin_detail_address : ''}</span></div>
        <div className="kv"><span className="k">출발지 연락처</span><span>{order.origin_contact || '-'}</span></div>
        {waypoints.map((w, i) => {
          const wLabel = '경유지' + (waypoints.length > 1 ? ' ' + (i + 1) : '');
          return (
            <div key={w.id || i}>
              <div className="kv"><span className="k">{wLabel}</span><span>{w.address}</span></div>
              {(w.contact_phone || w.vehicle_number) && (
                <>
                  <div className="kv"><span className="k">{wLabel} 연락처</span><span>{w.contact_phone || '-'}</span></div>
                  <div className="kv"><span className="k">{wLabel} 차량번호</span><span>{w.vehicle_number || '-'}</span></div>
                </>
              )}
            </div>
          );
        })}
        <div className="kv"><span className="k">도착지</span><span>{order.destination_address}{order.destination_detail_address ? ' ' + order.destination_detail_address : ''}</span></div>
        <div className="kv"><span className="k">도착지 연락처</span><span>{order.destination_contact || '-'}</span></div>
        <div className="kv"><span className="k">차종 / 차량번호</span><span>{[order.vehicle_type, order.vehicle_number].filter(Boolean).join(' / ') || '-'}</span></div>
        <div className="kv"><span className="k">예약일시</span><span>{order.reserved_date} {order.reserved_time}</span></div>
        <div className="kv"><span className="k">결제방식</span><span>{order.payment_method_name || '-'}</span></div>
        <div className="kv"><span className="k">요금</span><span>{formatMoney(order.fare_amount)}</span></div>
        <div className="kv"><span className="k">도선료</span><span>{formatMoney(order.ferry_fare_amount || 0)}</span></div>
        <div className="kv"><span className="k">배정 기사</span><span>{order.driver_name || '미배정'}</span></div>

        <div className="section-title">메모</div>
        <div className="kv"><span className="k">고객사 메모</span><span>{order.memo_customer || '작성된 메모가 없습니다.'}</span></div>
        <div className="kv"><span className="k">업체요청사항</span><span>{order.memo_billing || '작성된 내용이 없습니다.'}</span></div>

        {canViewPhotos && (
          <>
            <div className="section-title">📷 기사 업로드 사진</div>
            {photos.length === 0 ? (
              <p className="page-sub" style={{ margin: 0 }}>업로드된 사진이 없습니다.</p>
            ) : (
              <div className="upload-gallery">
                {photos.map((p) => (
                  <a key={p.id} href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt="업로드된 사진" /></a>
                ))}
              </div>
            )}
          </>
        )}
      </div>

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
    </div>
  );
}
