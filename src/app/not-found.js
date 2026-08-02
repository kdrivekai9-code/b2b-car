import Link from 'next/link';

export default function NotFound() {
  return (
    <html lang="ko">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>404 · B2B-CAR</title>
        <link rel="stylesheet" href="/css/style.css" />
      </head>
      <body style={{ padding: 40 }}>
        <h1 className="page-title">404 · 페이지를 찾을 수 없습니다</h1>
        <p className="page-sub">요청하신 페이지가 존재하지 않습니다.</p>
        <Link className="btn secondary" href="/">대시보드로 이동</Link>
      </body>
    </html>
  );
}
