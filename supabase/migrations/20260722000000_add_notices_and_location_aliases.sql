-- 공지사항 + 거점 별칭 사전 (기획서 4절 IA)

create table if not exists notices (
  id integer generated always as identity primary key,
  title text not null,
  content text not null,
  author_id integer references users(id),
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);

create table if not exists location_aliases (
  id integer generated always as identity primary key,
  branch_id integer not null references branches(id) on delete cascade,
  canonical_name text not null,
  address text not null,
  aliases text,
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);
create index if not exists idx_location_aliases_branch_id on location_aliases(branch_id);

alter table notices enable row level security;
alter table location_aliases enable row level security;
