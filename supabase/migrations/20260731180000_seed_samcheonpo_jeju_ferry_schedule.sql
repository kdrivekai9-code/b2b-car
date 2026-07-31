-- 삼천포신항-제주항 노선(현성MCT 오션비스타제주호) 운항 시간표.
-- 사용자 확인: 매주 일~금 운항, 토요일 정기휴항이 맞음(단, 아래 ferry_schedule_exceptions에
-- 등록된 특정 토요일은 예외적으로 운항함 — 2026-07-31 사용자 확인).
insert into ferry_schedules
  (route_code, ship_name, origin_port, destination_port, departure_time, arrival_time, duration_minutes, operating_days, note, source_title, source_url, is_active)
select v.route_code, v.ship_name, v.origin_port, v.destination_port, v.departure_time, v.arrival_time, v.duration_minutes, v.operating_days, v.note, v.source_title, v.source_url, v.is_active
from (values
  ('SAMCHEONPO_JEJU', '오션비스타제주', '삼천포신항', '제주항', '23:30', '06:00', 390, '일~금(매주 토요일 정기휴항, 예외일은 ferry_schedule_exceptions 참고)', '야간운항(당일 밤 출발, 다음날 새벽 도착).', '오션비스타제주 운항 정보 요약 자료', 'https://oh-my-gat.com/samcheonpo-jeju-ferry/', 1),
  ('SAMCHEONPO_JEJU', '오션비스타제주', '제주항', '삼천포신항', '14:30', '21:00', 390, '일~금(매주 토요일 정기휴항, 예외일은 ferry_schedule_exceptions 참고)', NULL, '오션비스타제주 운항 정보 요약 자료', 'https://oh-my-gat.com/samcheonpo-jeju-ferry/', 1)
) as v(route_code, ship_name, origin_port, destination_port, departure_time, arrival_time, duration_minutes, operating_days, note, source_title, source_url, is_active)
where not exists (
  select 1 from ferry_schedules existing where existing.route_code = 'SAMCHEONPO_JEJU'
);
