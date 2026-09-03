'use client';

// 콜마너 탁송사진 — 기사 업로드 사진과 별도다(외부 CDN 링크만 보관, 우리 버킷으로 복사하지
// 않는다). views/orders/detail.ejs에도 같은 섹션이 있다.
//
// 운행전·운행후를 **순번으로 짝지어 나란히** 놓는다. 예전에는 운행전 13장, 운행후 13장을
// 각각 늘어놓았는데, 그러면 같은 자리를 비교하려고 눈으로 세어 짝을 찾아야 했다.
// 흠집이 언제 생겼는지가 사고 처리의 전부인데 그걸 손으로 맞추게 두면 안 된다.
//
// 별도 클라이언트 컴포넌트인 이유: 링크가 만료되면 썸네일이 깨지므로 onError로 이미지만 숨기고
// 링크는 남기는데, 이벤트 핸들러는 서버 컴포넌트에서 넘길 수 없다(page.js는 서버 컴포넌트다).
// 처음에 page.js 안에 그대로 뒀다가 "Event handlers cannot be passed to Client Component props"
// 런타임 오류가 났다 — next build는 통과하고 화면을 열 때 터지는 종류라 빌드로는 못 잡는다.

// 한 칸. 사진이 없으면 빈 자리를 남긴다 — 빠진 것이 보여야 "안 찍었다"를 알 수 있다.
function Shot({ photo, phase, label }) {
  if (!photo) {
    return <div className="photo-cell empty"><span>{phase} 없음</span></div>;
  }
  return (
    <a className="photo-cell" href={photo.url} target="_blank" rel="noreferrer">
      <img
        src={photo.url}
        alt={`${label} ${phase}`}
        loading="lazy"
        onError={(e) => { e.currentTarget.style.display = 'none'; }}
      />
      <span className="photo-phase">{phase}</span>
    </a>
  );
}

export default function CallmanerPhotos({ photos, pairs }) {
  const rows = Array.isArray(pairs) ? pairs : [];
  const total = Array.isArray(photos) ? photos.length : 0;
  if (!rows.length) return null;

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <h2>🚚 콜마너 탁송사진</h2>
      <p className="page-sub" style={{ margin: '4px 0 12px' }}>
        같은 항목의 <strong>운행전 · 운행후</strong>를 나란히 놓았습니다. 총 {total}장.
      </p>

      <div className="photo-compare">
        {rows.map((p) => (
          <div className="photo-row" key={p.seq}>
            <div className="photo-label">{p.label}</div>
            <div className="photo-pair">
              <Shot photo={p.start} phase="운행전" label={p.label} />
              <Shot photo={p.end} phase="운행후" label={p.label} />
            </div>
          </div>
        ))}
      </div>

      <p className="page-sub" style={{ margin: '10px 0 0' }}>
        콜마너가 제공하는 링크를 그대로 보여줍니다 — 콜마너 쪽에서 만료되면 열리지 않을 수 있습니다.
      </p>
    </div>
  );
}
