'use client';

import { useCallback, useRef } from 'react';

// 콜마너 탁송사진 — 기사 업로드 사진과 별도다(외부 CDN 링크만 보관, 우리 버킷으로 복사하지
// 않는다). views/orders/detail.ejs에도 같은 섹션이 있다.
//
// 운행전·운행후를 **가로 두 줄**로 놓는다(사용자 지정 2026-09-08). 줄 하나가 운행전, 줄 하나가
// 운행후이고 같은 열이 같은 항목이다 — 열이 곧 짝이라 흠집이 언제 생겼는지 눈으로 바로 잡힌다.
// 예전에는 짝마다 한 행을 만들어 큰 사진 두 장을 넣었는데, 13쌍이면 화면이 열세 번 스크롤되고
// 한 장이 화면 절반을 차지해 목록으로도 비교용으로도 못 썼다.
//
// 짝짓기는 서버가 한다(lib/callmanerPhotos.js pairByPhase) — 화면이 다시 세면 EJS 화면과 갈린다.
// 확대는 공용 스크립트가 맡는다(public/js/photo-lightbox.js, data-lightbox 속성) — 두 화면이
// 같은 것을 쓰지 않으면 플래그에 따라 확대가 사라진다.
//
// 별도 클라이언트 컴포넌트인 이유: 링크가 만료되면 썸네일이 깨지므로 onError로 이미지만 숨기고
// 링크는 남기는데, 이벤트 핸들러는 서버 컴포넌트에서 넘길 수 없다(page.js는 서버 컴포넌트다).
// 처음에 page.js 안에 그대로 뒀다가 "Event handlers cannot be passed to Client Component props"
// 런타임 오류가 났다 — next build는 통과하고 화면을 열 때 터지는 종류라 빌드로는 못 잡는다.

// 한 칸. 사진이 없으면 빈 자리를 남긴다 — 빠진 것이 보여야 "안 찍었다"를 알 수 있고,
// 열도 어긋나지 않는다.
function Shot({ photo, phase, label, seq }) {
  if (!photo) {
    return <div className="photo-cell empty"><span>{seq}<br />없음</span></div>;
  }
  return (
    <a
      className="photo-cell"
      href={photo.url}
      target="_blank"
      rel="noreferrer"
      data-lightbox="callmaner"
      data-caption={`${label} · ${phase}`}
    >
      <img
        src={photo.url}
        alt={`${label} ${phase}`}
        loading="lazy"
        onError={(e) => { e.currentTarget.style.display = 'none'; }}
      />
      <span className="photo-phase">{seq}</span>
    </a>
  );
}

export default function CallmanerPhotos({ photos, pairs }) {
  const rows = Array.isArray(pairs) ? pairs : [];
  const total = Array.isArray(photos) ? photos.length : 0;
  const strips = useRef([]);
  const syncing = useRef(false);

  // 두 줄을 함께 굴린다 — 따로 움직이면 열이 어긋나 짝 비교가 깨진다.
  const onScroll = useCallback((e) => {
    if (syncing.current) return;
    syncing.current = true;
    const from = e.currentTarget;
    strips.current.forEach((el) => { if (el && el !== from) el.scrollLeft = from.scrollLeft; });
    // 다음 프레임에 풀어야 서로를 되밀며 튀지 않는다.
    requestAnimationFrame(() => { syncing.current = false; });
  }, []);

  if (!rows.length) return null;

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <h2>🚚 콜마너 탁송사진</h2>
      <p className="page-sub" style={{ margin: '4px 0 10px' }}>
        같은 열이 <strong>같은 항목</strong>입니다(운행전 · 운행후). 총 {total}장.
        사진을 누르면 크게 볼 수 있고, ← → 로 넘깁니다.
      </p>

      <div className="photo-rails">
        {[['start', '운행전'], ['end', '운행후']].map(([key, phase], railIndex) => (
          <div className="photo-rail" key={key}>
            <div className="rail-label">{phase}</div>
            <div
              className="rail-strip"
              ref={(el) => { strips.current[railIndex] = el; }}
              onScroll={onScroll}
            >
              {rows.map((p) => (
                <Shot key={p.seq} photo={p[key]} phase={phase} label={p.label} seq={p.seq} />
              ))}
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
