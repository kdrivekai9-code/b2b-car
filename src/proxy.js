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
  const flagName = STAGE1_FLAGS[req.nextUrl.pathname];
  if (flagName && process.env[flagName] !== 'true') {
    return NextResponse.rewrite(new URL('/api/index', req.url));
  }
  return NextResponse.next();
}

// Next's proxy bundler statically analyzes this export, so it's kept as a literal array
// (a computed expression like Object.keys(STAGE1_FLAGS) may not be statically evaluable).
export const config = { matcher: ['/', '/orders', '/inquiries'] };
