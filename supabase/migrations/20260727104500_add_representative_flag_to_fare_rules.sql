-- 거리 구간별 요금 규칙(fare_rules) 각 행에 대표요금제 선택 플래그 추가

alter table fare_rules
  add column if not exists is_representative integer not null default 0;

create index if not exists idx_fare_rules_representative
  on fare_rules(branch_id, is_representative);
