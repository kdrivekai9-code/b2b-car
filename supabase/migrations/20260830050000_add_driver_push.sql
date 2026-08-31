-- 기사 푸시(콜마너 Firebase FCM) — 토큰 보관과 발송 이력.
--
-- 구조(사용자 확정 2026-08-30, 방식 B "권한 위임"):
--   콜마너는 앱만 고친다 — 웹뷰 진입 서명토큰에 그 기기의 FCM 등록토큰을 함께 실어 보낸다.
--   발송은 우리가 콜마너 Firebase 프로젝트의 서비스계정으로 직접 한다.
--   → 콜마너 서버 개발이 빠지고, 재시도·실패 로깅을 우리가 쥔다.

-- ── 기기 토큰 ──────────────────────────────────────────────────────────────
-- FCM 등록토큰은 기기마다 다르고 갱신된다. 기사가 웹뷰에 들어올 때마다 최신값이 오므로
-- 그때 갱신한다 — 별도 동기화 경로가 필요 없다.
--
-- 기사 한 명이 기기 여러 대를 쓸 수 있어 (driver_id, token) 쌍으로 둔다.
create table if not exists driver_push_tokens (
  id          bigserial primary key,
  driver_id   bigint not null references drivers(id) on delete cascade,
  token       text   not null,
  last_seen_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create unique index if not exists driver_push_tokens_uniq on driver_push_tokens(driver_id, token);
create index if not exists driver_push_tokens_driver_idx on driver_push_tokens(driver_id);

-- ── 발송 이력 ──────────────────────────────────────────────────────────────
-- "보냈는데 기사가 못 봤다"를 되짚을 수 있어야 한다. 실패 사유도 남긴다 —
-- UNREGISTERED(앱 삭제·토큰 만료)는 그 토큰을 지우는 신호이고, 그 외는 재시도 대상이다.
create table if not exists driver_push_log (
  id          bigserial primary key,
  driver_id   bigint references drivers(id) on delete set null,
  order_id    bigint references orders(id) on delete set null,
  title       text,
  body        text,
  deeplink    text,
  ok          boolean not null default false,
  error_code  text,
  error_msg   text,
  created_at  timestamptz not null default now()
);
create index if not exists driver_push_log_created_idx on driver_push_log(created_at desc);

-- ── 액세스 토큰 캐시 ───────────────────────────────────────────────────────
-- vertex_token_cache와 같은 이유로 둔다: 콜드스타트마다 구글 OAuth 왕복(JWT 서명 + 토큰 교환)을
-- 반복하지 않도록, 아직 유효한 토큰을 인스턴스 간에 나눠 쓴다.
-- 표를 따로 두는 이유는 자격증명이 다른 프로젝트(콜마너 Firebase)의 것이기 때문이다.
create table if not exists fcm_token_cache (
  id           integer primary key,
  access_token text not null,
  expires_at   timestamptz not null
);
