-- express-session 저장소 표(connect-pg-simple).
--
-- 지금까지 이 표는 마이그레이션이 아니라 connect-pg-simple의 createTableIfMissing이 만들었다.
-- 그게 실제로 서비스를 멈췄다: 그 옵션은 세션을 처음 건드릴 때 "표가 있나"를 확인하는데,
-- 확인 결과를 약속(Promise) 하나에 캐시해두고 **실패한 약속도 지우지 않는다**
-- (node_modules/connect-pg-simple/index.js:197). 부팅 순간에 DB가 잠깐 안 닿으면 그 거부된
-- 약속이 프로세스가 사는 내내 재사용되어, DB가 멀쩡해진 뒤에도 세션을 쓰는 모든 요청이
-- "Connection terminated due to connection timeout"으로 영구히 실패한다. 재기동 말고는 길이 없다.
--
-- 그래서 표를 여기서 만들고 그 옵션을 끈다(server.js). 표 정의는 connect-pg-simple의
-- table.sql 그대로다 — 라이브러리가 읽고 쓰는 표라 모양이 갈리면 안 된다.
create table if not exists "session" (
  "sid"    varchar not null collate "default",
  "sess"   json not null,
  "expire" timestamp(6) not null
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'session_pkey'
  ) then
    alter table "session" add constraint "session_pkey" primary key ("sid") not deferrable initially immediate;
  end if;
end $$;

create index if not exists "IDX_session_expire" on "session" ("expire");
