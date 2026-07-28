-- 문의 단일 관리 테이블
-- 유형은 단일(inquiry)로 두고 category로 분류(fare/general)한다.

create table if not exists inquiries (
  id integer generated always as identity primary key,
  chat_session_id integer references chat_sessions(id) on delete set null,
  user_id integer not null references users(id) on delete cascade,
  branch_id integer references branches(id) on delete set null,
  requester_group_id integer references groups_tbl(id) on delete set null,

  category text not null default 'general' check (category in ('fare', 'general')),
  status text not null default 'new' check (status in ('new', 'in_progress', 'waiting_customer', 'answered', 'converted_to_order', 'closed')),

  inquiry_text text not null,
  origin_text text,
  destination_text text,
  vehicle_type text,

  resolved_origin text,
  resolved_destination text,
  estimated_distance_km numeric,
  estimated_fare integer,
  fare_source text,
  has_ferry_leg boolean not null default false,
  ferry_legs_json text,

  converted_order_id integer references orders(id) on delete set null,
  assigned_agent_id integer references users(id) on delete set null,
  handled_at text,
  closed_at text,

  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);

create index if not exists idx_inquiries_status on inquiries(status);
create index if not exists idx_inquiries_category on inquiries(category);
create index if not exists idx_inquiries_user_id on inquiries(user_id);
create index if not exists idx_inquiries_branch_id on inquiries(branch_id);
create index if not exists idx_inquiries_requester_group_id on inquiries(requester_group_id);
create index if not exists idx_inquiries_chat_session_id on inquiries(chat_session_id);

alter table inquiries enable row level security;
