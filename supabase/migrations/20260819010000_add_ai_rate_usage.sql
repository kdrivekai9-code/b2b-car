-- AI 사용량 카운터.
--
-- 왜 DB에 두나: 지금까지는 express-rate-limit의 기본 저장소(프로세스 메모리)를 썼다. 서버리스는
-- 인스턴스가 여럿이라 그 카운터가 인스턴스마다 따로 산다 — 실제 허용량이 설정값의 몇 배가 되고,
-- 콜드스타트마다 0으로 돌아간다. 즉 화면에 "분당 60"이라고 적혀 있어도 실제로는 그렇지 않았다.
--
-- 게다가 메모리 카운터는 조회할 수가 없어서, 관리자가 "지금 얼마나 쓰고 있는지"를 볼 방법이
-- 없었다(사용자 요청). 한 곳에 모아 세면 두 문제가 같이 풀린다.
--
-- subject는 세는 단위다 — 로그인 계정이면 'u:<id>', 로그인 전이면 'ip:<주소>'.
create table if not exists ai_rate_usage (
  subject      text        not null,
  window_kind  text        not null,          -- 'minute' | 'hour'
  window_start timestamptz not null,
  count        integer     not null default 0,
  primary key (subject, window_kind, window_start)
);

-- 지난 창을 지우고(정리), 현재 창을 화면에 보여줄 때 쓴다.
create index if not exists idx_ai_rate_usage_window on ai_rate_usage(window_start);
