'use client';

// 콜마너 탁송사진 — 기사 업로드 사진과 별도다(외부 CDN 링크만 보관, 우리 버킷으로 복사하지
// 않는다). views/orders/detail.ejs에도 같은 섹션이 있다.
//
// 별도 클라이언트 컴포넌트인 이유: 링크가 만료되면 썸네일이 깨지므로 onError로 이미지만 숨기고
// 링크는 남기는데, 이벤트 핸들러는 서버 컴포넌트에서 넘길 수 없다(page.js는 서버 컴포넌트다).
// 처음에 page.js 안에 그대로 뒀다가 "Event handlers cannot be passed to Client Component props"
// 런타임 오류가 났다 — next build는 통과하고 화면을 열 때 터지는 종류라 빌드로는 못 잡는다.
export default function CallmanerPhotos({ photos }) {
  const rows = Array.isArray(photos) ? photos : [];
  if (!rows.length) return null;

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <h2>🚚 콜마너 탁송사진</h2>
      {['start', 'end'].map((phase) => {
        const group = rows.filter((p) => p.phase === phase);
        if (!group.length) return null;
        const label = phase === 'start' ? '운행전' : '운행후';
        return (
          <div key={phase}>
            <p className="page-sub" style={{ margin: '6px 0 4px' }}><strong>{label}</strong> {group.length}장</p>
            <div className="callmaner-gallery">
              {group.map((p) => (
                <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="upload-photo-item">
                  <img
                    src={p.url}
                    alt={`${label} ${p.seq}번째 사진`}
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                  <span className="upload-photo-leg">{p.seq}</span>
                </a>
              ))}
            </div>
          </div>
        );
      })}
      <p className="page-sub" style={{ margin: '8px 0 0' }}>
        콜마너가 제공하는 링크를 그대로 보여줍니다 — 콜마너 쪽에서 만료되면 열리지 않을 수 있습니다.
      </p>
    </div>
  );
}
