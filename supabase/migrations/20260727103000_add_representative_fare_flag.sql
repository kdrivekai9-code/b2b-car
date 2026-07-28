-- 지사 요금표 중 대표요금 설정 플래그
-- 소속 지사가 없는 조회는 이 플래그가 켜진 지사의 요금표를 우선 사용한다.

alter table fare_extra_settings
  add column if not exists is_representative integer not null default 0;

create index if not exists idx_fare_extra_settings_representative
  on fare_extra_settings(is_representative);
