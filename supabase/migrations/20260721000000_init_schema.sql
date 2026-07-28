-- B2B-CAR 초기 스키마 (SQLite -> PostgreSQL/Supabase 전환)
-- 날짜/시각 컬럼은 기존 뷰(EJS)가 "YYYY-MM-DD HH:MM:SS" 문자열을 그대로 출력하던 방식을
-- 그대로 유지하기 위해 text 타입 + KST 기준 문자열 default를 사용한다.

create table if not exists branches (
  id integer generated always as identity primary key,
  name text not null,
  code text unique not null,
  main_phone text,
  address text,
  contact_name text,
  status text not null default 'active',
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);

create table if not exists groups_tbl (
  id integer generated always as identity primary key,
  branch_id integer not null references branches(id),
  parent_group_id integer references groups_tbl(id),
  name text not null,
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);

create table if not exists users (
  id integer generated always as identity primary key,
  login_id text unique not null,
  password_hash text not null,
  name text not null,
  phone text,
  role text not null check (role in ('admin', 'branch_manager', 'client')),
  branch_id integer references branches(id),
  group_id integer references groups_tbl(id),
  grade text,                       -- leader | member (role=client 인 경우만 사용)
  status text not null default 'active',
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);

create table if not exists payment_methods (
  id integer generated always as identity primary key,
  name text unique not null,
  is_active integer not null default 1
);

create table if not exists orders (
  id integer generated always as identity primary key,
  uid text unique not null,
  branch_id integer not null references branches(id),
  requester_group_id integer references groups_tbl(id),
  origin_address text not null,
  origin_contact text,
  waypoint_address text,
  destination_address text not null,
  destination_contact text,
  vehicle_number text,
  reserved_date text not null,
  reserved_time text not null,
  payment_method_id integer references payment_methods(id),
  fare_amount integer not null default 0,
  status text not null default '오더등록',
  memo_customer text,
  memo_admin text,
  created_by integer references users(id),
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);

create table if not exists order_status_history (
  id integer generated always as identity primary key,
  order_id integer not null references orders(id),
  actor_user_id integer references users(id),
  old_status text,
  new_status text,
  note text,
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);

create index if not exists idx_groups_branch_id on groups_tbl(branch_id);
create index if not exists idx_users_branch_id on users(branch_id);
create index if not exists idx_users_group_id on users(group_id);
create index if not exists idx_orders_branch_id on orders(branch_id);
create index if not exists idx_orders_requester_group_id on orders(requester_group_id);
create index if not exists idx_orders_status on orders(status);
create index if not exists idx_orders_reserved_date on orders(reserved_date);
create index if not exists idx_order_status_history_order_id on order_status_history(order_id);

-- 이 앱은 자체 세션 인증(express-session)으로 접근을 통제하며, PostgREST/Supabase Auth를
-- 거치지 않고 백엔드에서 직접 Postgres 커넥션(postgres 롤)으로 접속한다. RLS를 켜서
-- anon/authenticated 롤(PostgREST 경유)로부터의 우회 접근을 원천 차단한다.
alter table branches enable row level security;
alter table groups_tbl enable row level security;
alter table users enable row level security;
alter table payment_methods enable row level security;
alter table orders enable row level security;
alter table order_status_history enable row level security;
