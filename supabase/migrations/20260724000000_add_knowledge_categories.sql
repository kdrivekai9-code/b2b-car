-- 지식관리 카테고리 마스터 (지식 항목의 category 값을 관리)
create table if not exists knowledge_categories (
  id integer generated always as identity primary key,
  name text unique not null,
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);

insert into knowledge_categories (name) values ('기타') on conflict (name) do nothing;
