// Next 16 renamed "Middleware" to "Proxy" (same file convention, one file, must be literally
// named proxy.js/proxy.ts, next to app/). Lives under src/ (Next's documented alternative
// root) so this whole directory can have its own package.json ("type": "module") — letting
// this file use idiomatic ESM export syntax (required by Next's static analysis for the
// proxy's config.matcher) without touching the repo root package.json's "type": "commonjs",
// which the entire legacy Express app depends on.
//
// Stage 1 feature flags, one per migrated page, each defaulting OFF — so by default every
// request to a matched path is transparently forwarded to the matching existing Express page
// (byte-for-byte the legacy EJS response). Flip a flag to "true" (per-environment, e.g.
// Preview only) to let Next's own src/app/** route handle that one path instead.
import { NextResponse } from 'next/server';

const STAGE1_FLAGS = {
  '/': 'NEXT_STAGE1_DASHBOARD_ENABLED',
  '/orders': 'NEXT_STAGE1_ORDERS_ENABLED',
  '/inquiries': 'NEXT_STAGE1_INQUIRIES_ENABLED',
};

export function proxy(req) {
  const { pathname, searchParams } = req.nextUrl;

  // /chat/sessions는 같은 경로에 두 가지 완전히 다른 화면이 걸려있다: 기본(카드뷰, 실시간
  // 채팅/답장/배정/삭제/오더등록폼 — Stage 1 범위 밖)과 ?view=list(읽기 전용 테이블만,
  // Stage 1 대상). 그래서 플래그만으로는 못 가르고, view=list일 때만 + 플래그도 켜졌을
  // 때만 React로 보낸다. 그 외(카드뷰 등)는 플래그 상태와 무관하게 항상 Express로 보낸다.
  if (pathname === '/chat/sessions') {
    const isListView = searchParams.get('view') === 'list';
    if (isListView && process.env.NEXT_STAGE1_CHAT_SESSIONS_ENABLED === 'true') {
      return NextResponse.next();
    }
    return NextResponse.rewrite(new URL('/api/index', req.url));
  }

  const flagName = STAGE1_FLAGS[pathname];
  if (flagName && process.env[flagName] !== 'true') {
    return NextResponse.rewrite(new URL('/api/index', req.url));
  }
  return NextResponse.next();
}

// Next's proxy bundler statically analyzes this export, so it's kept as a literal array
// (a computed expression like Object.keys(STAGE1_FLAGS) may not be statically evaluable).
export const config = { matcher: ['/', '/orders', '/inquiries', '/chat/sessions'] };
