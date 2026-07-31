-- 정기휴항일(예: 오션비스타제주의 매주 토요일)이지만 예외적으로 운항하는 날짜를 관리한다.
-- operating_hour_exceptions(지사 운영시간 예외)와 같은 취지 — 원칙(ferry_schedules.operating_days)과
-- 실제 예외를 분리해서 관리한다. 2026-07-31 사용자 확인: 아래 토요일들은 오션비스타제주가
-- 예외적으로 운항함(전부 실제 토요일 날짜로 검증됨).
create table if not exists ferry_schedule_exceptions (
  id serial primary key,
  route_code text not null,
  ship_name text,
  exception_date date not null,
  runs integer not null default 1,
  note text,
  created_at text default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
  unique (route_code, exception_date)
);

insert into ferry_schedule_exceptions (route_code, ship_name, exception_date, runs, note) values
  ('SAMCHEONPO_JEJU', '오션비스타제주', '2026-07-25', 1, '토요일이지만 예외 운항(사용자 확인)'),
  ('SAMCHEONPO_JEJU', '오션비스타제주', '2026-08-01', 1, '토요일이지만 예외 운항(사용자 확인)'),
  ('SAMCHEONPO_JEJU', '오션비스타제주', '2026-08-08', 1, '토요일이지만 예외 운항(사용자 확인)'),
  ('SAMCHEONPO_JEJU', '오션비스타제주', '2026-08-15', 1, '토요일(광복절)이지만 예외 운항(사용자 확인)'),
  ('SAMCHEONPO_JEJU', '오션비스타제주', '2026-09-26', 1, '토요일이지만 예외 운항(사용자 확인)'),
  ('SAMCHEONPO_JEJU', '오션비스타제주', '2026-10-03', 1, '토요일(개천절)이지만 예외 운항(사용자 확인)'),
  ('SAMCHEONPO_JEJU', '오션비스타제주', '2026-10-10', 1, '토요일이지만 예외 운항(사용자 확인)')
on conflict do nothing;
