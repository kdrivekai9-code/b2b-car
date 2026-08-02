'use client';

import Link from 'next/link';

export default function GlobalError({ error, reset }) {
  return (
    <html lang="ko">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>오류 · B2B-CAR</title>
        <link rel="stylesheet" href="/css/style.css" />
      </head>
      <body style={{ padding: 40 }}>
        <h1 className="page-title">오류가 발생했습니다</h1>
        <p className="page-sub">{error?.message || '알 수 없는 오류입니다.'}</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" type="button" onClick={reset}>다시 시도</button>
          <Link className="btn secondary" href="/">대시보드로 이동</Link>
        </div>
      </body>
    </html>
  );
}
