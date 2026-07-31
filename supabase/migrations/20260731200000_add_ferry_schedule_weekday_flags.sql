-- "다음 배편이 몇 시인지" 자동 계산(도착 예상 시각 산정)을 위해, 자유 텍스트였던
-- operating_days 대신 요일별 운항여부를 구조화된 컬럼으로 둔다. 예외(특정 날짜만 운항/휴항)는
-- 계속 ferry_schedule_exceptions로 처리한다.
alter table ferry_schedules
  add column if not exists runs_mon integer not null default 1,
  add column if not exists runs_tue integer not null default 1,
  add column if not exists runs_wed integer not null default 1,
  add column if not exists runs_thu integer not null default 1,
  add column if not exists runs_fri integer not null default 1,
  add column if not exists runs_sat integer not null default 1,
  add column if not exists runs_sun integer not null default 1;

-- 골드스텔라: 매일 운항, 일요일만 휴항.
update ferry_schedules set runs_sun = 0
  where route_code = 'WANDO_JEJU' and ship_name = '골드스텔라';

-- 실버클라우드 완도발 02:30편: 일요일 휴항.
update ferry_schedules set runs_sun = 0
  where route_code = 'WANDO_JEJU' and ship_name = '실버클라우드' and origin_port = '완도항' and departure_time = '02:30';

-- 실버클라우드 완도발 15:00편: 토요일 휴항.
update ferry_schedules set runs_sat = 0
  where route_code = 'WANDO_JEJU' and ship_name = '실버클라우드' and origin_port = '완도항' and departure_time = '15:00';

-- 오션비스타제주: 일~금 운항, 토요일 정기휴항(예외는 ferry_schedule_exceptions에서 별도 처리).
update ferry_schedules set runs_sat = 0
  where route_code = 'SAMCHEONPO_JEJU';
