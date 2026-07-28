-- 지식관리(RAG) 카테고리 마스터 테이블: 카테고리를 별도로 등록/관리하고
-- 지식 항목(knowledge_base) 등록 시 등록된 카테고리 중에서 선택하도록 한다.
create table if not exists knowledge_categories (
  id integer generated always as identity primary key,
  name text not null unique,
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);

-- 기존 knowledge_base에 이미 쓰이고 있는 카테고리 값들을 마스터 테이블로 이관
insert into knowledge_categories (name)
select distinct category from knowledge_base
on conflict (name) do nothing;

insert into knowledge_categories (name)
values ('기타')
on conflict (name) do nothing;
