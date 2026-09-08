// next.config.js — CommonJS (repo root package.json is "type": "commonjs").
// Stage 1 coexistence: Next.js only owns paths that have a matching file under app/.
// Everything else (all not-yet-migrated Express routes) falls through to the
// existing Express app, unchanged, via the "fallback" rewrite below.
//
// 로컬 개발(포트 분리) 지원: `vercel dev`는 이 프로젝트 구조(최상위 api/index.js를
// next.config.js rewrite로 가리키는 방식)와 호환되지 않는다 — next dev의 내부 라우터가
// '/api/index'를 Next 라우트로 착각해서 못 찾고 404를 낸다(vercel dev의 함수 프록시
// 레이어까지 전달이 안 됨, 직접 겪은 문제). 대신 `npm run dev`(Express, 3000번 포트)를
// 그대로 띄워두고 별도 터미널에서 `npm run dev:next`(Next.js만, 3001번 포트)로 열면,
// Next가 못 다루는 모든 경로를 절대 URL로 Express(3000번)에 그대로 프록시한다 — Next의
// rewrite destination은 절대 URL도 허용하므로(공식 기능) 실제 리버스 프록시로 동작한다.
// `process.env.VERCEL`은 실제 Vercel 배포(로컬이 아님)에서만 true이므로(server.js가 이미
// 같은 패턴으로 app.listen() 여부를 가르는 데 씀), 이 분기는 production/preview 동작에는
// 전혀 영향을 주지 않는다.
const EXPRESS_FALLBACK = process.env.VERCEL ? '/api/index' : 'http://localhost:3000/:path*';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // dev 서버는 자기가 뜬 호스트(localhost)가 아닌 오리진에서 오는 /_next/* 요청을 **403으로
  // 막는다**(Next 공식 동작, node_modules/next/dist/docs/.../allowedDevOrigins.md).
  // 그래서 127.0.0.1:3001로 열면 클라이언트 청크가 전부 403이 되고, 화면은 서버 렌더 그대로
  // 굳어버린다 — 응답 본문이 비어 있어 원인이 전혀 드러나지 않는다. 로컬 검사가 두 주소를
  // 섞어 쓰므로(스펙은 localhost, 헬퍼는 127.0.0.1) 둘 다 허용한다. 배포에는 영향이 없다.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],

  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [],
      fallback: [
        { source: '/:path*', destination: EXPRESS_FALLBACK },
      ],
    };
  },
};

module.exports = nextConfig;
