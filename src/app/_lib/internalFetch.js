import http from 'node:http';

// 브라우저의 Cookie 헤더에는 이 앱의 세션(connect.sid)뿐 아니라, 같은 localhost 도메인을
// 공유하는 다른 로컬 프로젝트의 쿠키(예: 다른 앱의 Supabase 인증 토큰)까지 섞여 들어올 수
// 있다 — 실제로 2.6KB짜리 다른 프로젝트 쿠키가 섞인 채로 Express에 그대로 전달됐을 때
// 라우팅이 깨져 엉뚱하게 404가 나는 게 재현됐다. Express 세션에 필요한 건 connect.sid뿐이므로
// 그것만 골라서 전달한다.
function extractSessionCookie(rawCookieHeader) {
  const match = /(?:^|;\s*)connect\.sid=[^;]+/.exec(rawCookieHeader || '');
  return match ? match[0] : '';
}

// Server Component에서 아직 Express에 남아있는 *.json 데이터 엔드포인트를 호출할 때 쓰는 헬퍼.
// 로컬 분리포트 개발(next dev, 3001)에서는 Express(3000)에 직접 raw request를 보낸다 —
// Vercel 배포에서는 self-fetch(`${proto}://${host}`)가 원래 문제 없이 동작해서(같은 origin,
// `/api/index`로의 rewrite가 원본 경로를 유지) 그대로 둔다.
export function fetchExpressJson(pathAndQuery, { proto, host, cookie }) {
  const sessionCookie = extractSessionCookie(cookie);

  if (process.env.VERCEL) {
    return fetch(`${proto}://${host}${pathAndQuery}`, {
      headers: { cookie: sessionCookie, 'X-Requested-With': 'fetch' },
      cache: 'no-store',
    });
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: 3000,
        path: pathAndQuery,
        method: 'GET',
        headers: { cookie: sessionCookie, 'X-Requested-With': 'fetch' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            json: async () => JSON.parse(body),
            text: async () => body,
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}
