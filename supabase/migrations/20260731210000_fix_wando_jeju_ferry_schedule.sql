-- 사용자 확인(2026-07-31)에 따른 완도-제주 시간표 정정:
-- - 블루펄은 이 노선을 운항하지 않음 -> 삭제.
-- - 완도 출발 02:30/15:00편은 골드스텔라, 09:20편은 실버클라우드였음(반대로 잘못 들어가 있었음).
-- - 골드스텔라: 토요일 15:00편, 일요일 02:30편 휴항(요일 고정 — 기존 컬럼 그대로 유지).
-- - 실버클라우드 09:20편: 매주가 아니라 "둘째·넷째주 일요일"만 휴항 — 요일 컬럼으로는 표현이
--   안 되므로 runs_sun을 다시 1로 되돌리고, ferry_schedule_exceptions에 2026년 하반기
--   둘째/넷째주 일요일을 개별 등록한다(제주 왕복 시간표라 2027년 이후는 그때 다시 추가해야 함).
delete from ferry_schedules where route_code = 'WANDO_JEJU' and ship_name = '블루펄';

update ferry_schedules
  set ship_name = '골드스텔라',
      note = '사용자 확인(2026-07-31): 완도발 02:30편, 일요일 휴항.'
  where route_code = 'WANDO_JEJU' and origin_port = '완도항' and departure_time = '02:30';

update ferry_schedules
  set ship_name = '골드스텔라',
      note = '사용자 확인(2026-07-31): 완도발 15:00편, 토요일 휴항.'
  where route_code = 'WANDO_JEJU' and origin_port = '완도항' and departure_time = '15:00';

update ferry_schedules
  set ship_name = '실버클라우드',
      runs_sun = 1,
      note = '사용자 확인(2026-07-31): 완도발 09:20편, 둘째·넷째주 일요일 휴항(ferry_schedule_exceptions 참고).'
  where route_code = 'WANDO_JEJU' and origin_port = '완도항' and departure_time = '09:20';

insert into ferry_schedule_exceptions (route_code, ship_name, exception_date, runs, note) values
  ('WANDO_JEJU', '실버클라우드', '2026-08-09', 0, '둘째주 일요일 휴항(사용자 확인)'),
  ('WANDO_JEJU', '실버클라우드', '2026-08-23', 0, '넷째주 일요일 휴항(사용자 확인)'),
  ('WANDO_JEJU', '실버클라우드', '2026-09-13', 0, '둘째주 일요일 휴항(사용자 확인)'),
  ('WANDO_JEJU', '실버클라우드', '2026-09-27', 0, '넷째주 일요일 휴항(사용자 확인)'),
  ('WANDO_JEJU', '실버클라우드', '2026-10-11', 0, '둘째주 일요일 휴항(사용자 확인)'),
  ('WANDO_JEJU', '실버클라우드', '2026-10-25', 0, '넷째주 일요일 휴항(사용자 확인)'),
  ('WANDO_JEJU', '실버클라우드', '2026-11-08', 0, '둘째주 일요일 휴항(사용자 확인)'),
  ('WANDO_JEJU', '실버클라우드', '2026-11-22', 0, '넷째주 일요일 휴항(사용자 확인)'),
  ('WANDO_JEJU', '실버클라우드', '2026-12-13', 0, '둘째주 일요일 휴항(사용자 확인)'),
  ('WANDO_JEJU', '실버클라우드', '2026-12-27', 0, '넷째주 일요일 휴항(사용자 확인)')
on conflict (route_code, exception_date) do update set ship_name = excluded.ship_name, runs = excluded.runs, note = excluded.note;
