-- 사용자가 캡처해준 한일고속 공식 운항시간표(2026-07-31)를 그대로 반영한다.
-- 골드스텔라: 완도 02:30→05:10, 15:00→17:40 / 제주 08:40→11:20, 19:30→22:10, 정기휴항 토 15:00·일 02:30
-- 실버클라우드: 완도 09:20→12:00 / 제주 16:00→18:40, 정기휴항 둘째·넷째주 일요일
-- 이전 마이그레이션에서 가는편(완도발) 선박명은 이미 정정했지만, 오는편(제주발)은 선박명이
-- 여전히 뒤바뀐 채였고 도착시각도 일부 틀려서 이번에 같이 정정한다.
-- 정기휴항은 표에 오는편까지 별도로 안 적혀 있지만, 같은 배가 그날 왕복을 도는 구조라
-- 가는편이 쉬면 그 배의 짝이 되는 오는편도 같이 쉰다고 보고 요일 플래그를 맞춘다
-- (토 15:00편 휴항 -> 19:30 귀항도 같이 휴항, 일 02:30편 휴항 -> 08:40 귀항도 같이 휴항).

-- 완도발(가는편) 도착시각/소요시간 보정 — 골드스텔라 02:30/15:00은 이미 맞고, 실버클라우드
-- 09:20의 도착시각만 11:50으로 잘못 들어가 있었다(맞는 값 12:00).
update ferry_schedules
  set arrival_time = '12:00', duration_minutes = 160,
      note = '한일고속 공식 운항시간표(사용자 확인, 2026-07-31): 둘째·넷째주 일요일 휴항.'
  where route_code = 'WANDO_JEJU' and ship_name = '실버클라우드' and origin_port = '완도항' and departure_time = '09:20';

update ferry_schedules
  set note = '한일고속 공식 운항시간표(사용자 확인, 2026-07-31).'
  where route_code = 'WANDO_JEJU' and ship_name = '골드스텔라' and origin_port = '완도항';

-- 오는편(제주발) 선박명/도착시각 정정.
update ferry_schedules
  set ship_name = '골드스텔라', arrival_time = '11:20', duration_minutes = 160, runs_sun = 0,
      note = '한일고속 공식 운항시간표(사용자 확인, 2026-07-31): 완도발 02:30편의 귀항 — 일요일 휴항.'
  where route_code = 'WANDO_JEJU' and origin_port = '제주항' and departure_time = '08:40';

update ferry_schedules
  set ship_name = '골드스텔라', arrival_time = '22:10', duration_minutes = 160, runs_sat = 0,
      note = '한일고속 공식 운항시간표(사용자 확인, 2026-07-31): 완도발 15:00편의 귀항 — 토요일 휴항.'
  where route_code = 'WANDO_JEJU' and origin_port = '제주항' and departure_time = '19:30';

-- 이 행은 원래 골드스텔라로 잘못 들어가 있어서(202607311.._add_ferry_schedule_weekday_flags.sql이
-- "골드스텔라는 일요일 전체 휴항"으로 runs_sun=0을 걸어놨었다) 선박명만 바꾸면 그 값이 그대로
-- 남는다 — 실버클라우드는 매주 일요일이 아니라 둘째·넷째주만 쉬므로 runs_sun을 다시 1로 되돌린다.
update ferry_schedules
  set ship_name = '실버클라우드', arrival_time = '18:40', duration_minutes = 160, runs_sun = 1,
      note = '한일고속 공식 운항시간표(사용자 확인, 2026-07-31): 둘째·넷째주 일요일 휴항(ferry_schedule_exceptions 참고).'
  where route_code = 'WANDO_JEJU' and origin_port = '제주항' and departure_time = '16:00';
