// client(고객사) 역할 전용 사이드 패널 — 상태변경/기사배정/관리자메모(admin/branch_manager
// 전용, OrderDetailAdminPanels.js)는 client에게 안 보이지만, 배정 기사 정보와 변경이력은
// 이전 읽기전용 화면에서도 볼 수 있었던 정보라 그대로 유지한다.
function historyLabel(h) {
  if (h.old_status == null) return `최초 등록: ${h.new_status}`;
  if (h.old_status === h.new_status) return '정보 수정';
  return `${h.old_status} → ${h.new_status}`;
}

export default function OrderHistoryPanel({ data }) {
  const { order, canViewPhotos, photos, history } = data;

  return (
    <>
      <div className="card">
        <h2>🧑‍✈️ 배정 정보</h2>
        <div className="kv"><span className="k">배정 기사</span><span>{order.driver_name || '미배정'}</span></div>
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
              <b>{historyLabel(h)}</b>
              <div className="meta">{h.actor_name || '시스템'} · {h.created_at}{h.note ? ` · ${h.note}` : ''}</div>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
