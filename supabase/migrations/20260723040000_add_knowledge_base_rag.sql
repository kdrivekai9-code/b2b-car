-- 지식관리(RAG) 지식베이스: pgvector 기반 유사도 검색용
create extension if not exists vector;

create table if not exists knowledge_base (
  id integer generated always as identity primary key,
  category text not null default '기타',
  question text not null,
  answer text not null,
  embedding vector(768),
  created_by integer references users(id),
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);
