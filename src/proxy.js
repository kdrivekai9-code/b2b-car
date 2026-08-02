// Next 16 renamed "Middleware" to "Proxy" (same file convention, one file, must be literally
// named proxy.js/proxy.ts, next to app/). Lives under src/ (Next's documented alternative
// root) so this whole directory can have its own package.json ("type": "module") — letting
// this file use idiomatic ESM export syntax (required by Next's static analysis for the
// proxy's config.matcher) without touching the repo root package.json's "type": "commonjs",
// which the entire legacy Express app depends on.
//
// Migration feature flags (Stage 1 read-only pages + Stage 2 order-create form), one per
// migrated path, each defaulting OFF — so by default every request to a matched path is
// transparently forwarded to the matching existing Express page (byte-for-byte the legacy
// EJS response). Flip a flag to "true" (per-environment, e.g. Preview only) to let Next's
// own src/app/** route handle that one path instead.
import { NextResponse } from 'next/server';

// 실제 Vercel 배포에서는 '/api/index'로의 rewrite가 Vercel 라우팅의 특수 동작이라
// 원본 경로/쿼리를 그대로 유지한 채 그 서버리스 함수(api/index.js → server.js)로
// 디스패치된다. 로컬(next dev, 포트 분리 개발용)에는 이 특수 동작이 없으므로 직접
// http://localhost:3000(Express, `npm run dev`)으로 절대 URL 리라이트한다 — Next의
// rewrite destination은 절대 URL을 리버스 프록시 대상으로 허용하는 공식 기능이다.
// process.env.VERCEL은 실제 배포에서만 true라(server.js가 이미 같은 패턴으로
// app.listen() 여부를 가름) production/preview 동작에는 전혀 영향이 없다.
function toExpress(req) {
  if (process.env.VERCEL) {
    return NextResponse.rewrite(new URL('/api/index', req.url));
  }
  return NextResponse.rewrite(new URL(req.nextUrl.pathname + req.nextUrl.search, 'http://localhost:3000'));
}

const PATH_FLAGS = {
  '/': 'NEXT_STAGE1_DASHBOARD_ENABLED',
  '/orders': 'NEXT_STAGE1_ORDERS_ENABLED',
  '/inquiries': 'NEXT_STAGE1_INQUIRIES_ENABLED',
  '/orders/new': 'NEXT_STAGE2_ORDER_FORM_ENABLED',
  '/orders/ai-intake': 'NEXT_STAGE3_AI_INTAKE_ENABLED',
  '/users': 'NEXT_USERS_ENABLED',
  '/drivers': 'NEXT_DRIVERS_ENABLED',
  '/groups': 'NEXT_GROUPS_ENABLED',
  '/branches': 'NEXT_BRANCHES_ENABLED',
  '/notices': 'NEXT_NOTICES_ENABLED',
  '/location-aliases': 'NEXT_LOCATION_ALIASES_ENABLED',
  '/settings': 'NEXT_SETTINGS_ENABLED',
  '/knowledge-base': 'NEXT_KNOWLEDGE_BASE_ENABLED',
  '/faq': 'NEXT_FAQ_ENABLED',
  '/push/settings': 'NEXT_PUSH_SETTINGS_ENABLED',
  '/access-logs': 'NEXT_ACCESS_LOGS_ENABLED',
};

export function proxy(req) {
  const { pathname, searchParams } = req.nextUrl;

  // src/app/** 아래 페이지는 전부 GET 전용(page.js)이다. GET이 아닌 요청(예: POST /orders —
  // 오더 등록 제출, PATCH /orders/... 등)을 Next 라우터로 넘기면 Next는 메서드를 구분하지
  // 않고 그냥 페이지를 렌더링해버려 요청 바디가 통째로 무시된다(실제로 발견된 버그: Stage 1의
  // GET /orders 플래그가 켜진 환경에서 POST /orders 오더 등록이 조용히 씹혔다). 그래서
  // GET이 아닌 모든 요청은 플래그 상태와 무관하게 항상 기존 Express로 보낸다.
  if (req.method !== 'GET') {
    return toExpress(req);
  }

  // /chat/sessions는 같은 경로에 두 가지 완전히 다른 화면이 걸려있다: ?view=list(읽기 전용
  // 테이블, Stage 1)와 카드뷰(실시간 채팅/답장/배정/삭제/오더등록 링크, Stage 3) — 뷰 없이
  // /chat/sessions만 요청하면 routes/chat.js(L404)와 동일하게 카드뷰로 취급한다. 각 뷰는
  // 서로 다른 플래그로 독립적으로 게이팅한다.
  if (pathname === '/chat/sessions') {
    const view = searchParams.get('view') === 'list' ? 'list' : 'card';
    if (view === 'list' && process.env.NEXT_STAGE1_CHAT_SESSIONS_ENABLED === 'true') {
      return NextResponse.next();
    }
    if (view === 'card' && process.env.NEXT_STAGE3_CHAT_CARDS_ENABLED === 'true') {
      return NextResponse.next();
    }
    return toExpress(req);
  }

  // /chat/sessions/:id는 상세페이지(Stage 3 슬라이스 2) — 숫자 세션 id일 때만 대상이다.
  // 같은 한 세그먼트 접두사를 쓰는 /chat/sessions/data.json, /chat/sessions/card-data.json,
  // /chat/sessions/needs-agent-summary, /chat/sessions/bulk-delete 같은 고정 서브경로도
  // config.matcher의 '/chat/sessions/:id' 패턴에 전부 걸리므로(Next의 :id는 세그먼트
  // 하나면 뭐든 매치, 숫자로 제한 안 됨), 이 분기에서 명시적으로 걸러 Express로 보내지
  // 않으면 맨 아래 기본 return NextResponse.next()로 새 [id] 다이나믹 라우트에 잘못
  // 매치되어버린다(실제로 겪은 버그 — /chat/sessions/needs-agent-summary가 세션 id
  // "needs-agent-summary"로 취급되어 500 에러 발생).
  const singleSegmentMatch = pathname.match(/^\/chat\/sessions\/([^/]+)$/);
  if (singleSegmentMatch) {
    const isNumericId = /^\d+$/.test(singleSegmentMatch[1]);
    if (isNumericId && process.env.NEXT_STAGE3_CHAT_DETAIL_ENABLED === 'true') {
      return NextResponse.next();
    }
    return toExpress(req);
  }

  // /orders/:id(오더 상세/수정, 신규) — 위 /chat/sessions/:id와 완전히 같은 이유로 같은
  // 패턴을 쓴다. 같은 접두사를 쓰는 /orders/new, /orders/data.json,
  // /orders/vehicle-type-suggest, /orders/fare-preview 등 고정 서브경로가 숫자 id로
  // 잘못 취급되지 않도록 명시적으로 숫자 한 세그먼트일 때만 대상으로 삼는다.
  const orderIdMatch = pathname.match(/^\/orders\/([^/]+)$/);
  if (orderIdMatch) {
    const isNumericId = /^\d+$/.test(orderIdMatch[1]);
    if (isNumericId && process.env.NEXT_ORDER_DETAIL_EDIT_ENABLED === 'true') {
      return NextResponse.next();
    }
    return toExpress(req);
  }

  const flagName = PATH_FLAGS[pathname];
  if (flagName && process.env[flagName] !== 'true') {
    return toExpress(req);
  }
  return NextResponse.next();
}

// Next's proxy bundler statically analyzes this export, so it's kept as a literal array
// (a computed expression like Object.keys(PATH_FLAGS) may not be statically evaluable).
export const config = { matcher: ['/', '/orders', '/inquiries', '/chat/sessions', '/chat/sessions/:id', '/orders/new', '/orders/ai-intake', '/orders/:id', '/users', '/drivers', '/groups', '/branches', '/notices', '/location-aliases', '/settings', '/knowledge-base', '/faq', '/push/settings', '/access-logs'] };
