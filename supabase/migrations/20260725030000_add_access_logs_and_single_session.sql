alter table users
  add column if not exists active_session_hash text,
  add column if not exists active_session_expires_at timestamptz;

create table if not exists access_logs (
  id bigint generated always as identity primary key,
  user_id integer references users(id) on delete set null,
  account text not null,
  event_type text not null,
  work_detail text not null,
  subject_info text,
  ip_address text not null,
  user_agent text,
  success boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_access_logs_created_at on access_logs(created_at desc);
create index if not exists idx_access_logs_account on access_logs(account);
create index if not exists idx_access_logs_user_id on access_logs(user_id);
create index if not exists idx_users_active_session_hash on users(active_session_hash);

alter table access_logs enable row level security;