// Next 16 renamed "Middleware" to "Proxy" (same file convention, one file, must be literally
// named proxy.js/proxy.ts, next to app/). Lives under src/ (Next's documented alternative
// root) so this whole directory can have its own package.json ("type": "module") — letting
// this file use idiomatic ESM export syntax (required by Next's static analysis for the
// proxy's config.matcher) without touching the repo root package.json's "type": "commonjs",
// which the entire legacy Express app depends on.
//
// Stage 1 feature flag: NEXT_STAGE1_DASHBOARD_ENABLED defaults OFF, so by default every
// request to "/" is transparently forwarded to the existing Express dashboard
// (routes/dashboard.js) and the response is byte-for-byte the legacy EJS page.
// Flip the env var to "true" (per-environment, e.g. Preview only) to let Next's own
// app/page.js handle "/" instead.
import { NextResponse } from 'next/server';

export function proxy(req) {
  if (process.env.NEXT_STAGE1_DASHBOARD_ENABLED !== 'true') {
    return NextResponse.rewrite(new URL('/api/index', req.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ['/'] };
