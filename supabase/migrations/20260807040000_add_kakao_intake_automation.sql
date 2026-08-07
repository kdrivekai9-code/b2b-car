-- 카카오 상담톡 접수 자동화 — "탁송 상담톡 챗봇 고도화 기획서" Phase 1.
--
-- 카카오 고객은 b2b-car 로그인 계정이 없는 게 기본값이라(연동 계획서 5.1) 오더를 만들 주체가
-- 없다 — orders는 branch_id/requester_group_id/created_by가 있어야 저장되고, 콜마너 접수도
-- 지사(providerId) 없이는 나가지 않는다. 그래서 "이 상담톡 채널의 접수는 이 거래처 계정으로
-- 등록한다"는 매핑을 데이터로 둔다. 매핑이 없는 채널은 자동 등록하지 않고 상담원에게 넘긴다.
create table if not exists kakao_consult_accounts (
  id integer generated always as identity primary key,
  -- 채널 식별 — service_key만 두면 그 채널 전체, external_user_key까지 두면 그 고객만.
  -- 좁은 조건(둘 다 일치)을 먼저 찾고 없으면 넓은 조건(service_key만)으로 떨어진다.
  service_key text,
  external_user_key text,
  label text,
  user_id integer not null references users(id) on delete cascade,
  branch_id integer not null references branches(id) on delete cascade,
  requester_group_id integer references groups_tbl(id) on delete set null,
  payment_method_id integer references payment_methods(id) on delete set null,
  -- 자동 등록 스위치. 새 채널을 붙일 때는 0으로 두고 파싱 결과만 관찰하다가 켜는 순서를 권장한다.
  auto_register boolean not null default false,
  enabled boolean not null default true,
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);
create index if not exists idx_kakao_consult_accounts_service on kakao_consult_accounts(service_key);
create index if not exists idx_kakao_consult_accounts_user_key on kakao_consult_accounts(external_user_key);

-- 되묻기 상태 — 필수 필드가 빠진 폼이 들어오면 부족한 항목만 물어보고, 고객이 보충 정보를
-- 보낼 때까지 파싱 결과를 들고 있어야 한다(기획서 5.2 "정보 보충" 인텐트). 카카오는 상담
-- 메시지를 3일만 보관하므로 대화 기록을 되짚어 재구성할 수 없어 우리 쪽에 남긴다.
alter table chat_sessions
  add column if not exists intake_slots_json text,
  add column if not exists intake_updated_at text;

-- 어느 상담 세션에서 만들어진 오더인지 — Phase 2의 능동 통보(배차/출발/도착)가 "이 오더의
-- 소식을 어느 카카오 세션으로 보낼지" 찾는 역방향 경로다. 채널 구분은 통계·감사용.
alter table orders
  add column if not exists chat_session_id integer references chat_sessions(id) on delete set null,
  add column if not exists source_channel text;
create index if not exists idx_orders_chat_session on orders(chat_session_id) where chat_session_id is not null;

alter table kakao_consult_accounts enable row level security;
