export const metadata = {
  title: 'B2B-CAR',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="stylesheet" href="/css/style.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
