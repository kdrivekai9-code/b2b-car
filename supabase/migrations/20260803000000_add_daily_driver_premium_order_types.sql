-- 일일기사(daily_driver) / 프리미엄(premium) 오더 타입 지원을 위한 스키마 확장.
-- 설계 문서: docs/ai-daily-driver-intake-design.md §9 참고.

-- 1. orders 테이블 — 오더 타입 및 일일기사/프리미엄 전용 필드 추가
alter table orders
  add column if not exists order_type text not null default 'dispatch'
    check (order_type in ('dispatch', 'premium', 'daily_driver')),
  add column if not exists trip_type text
    check (trip_type is null or trip_type in ('round_trip', 'one_way')),
  add column if not exists final_destination_address text,
  add column if not exists final_destination_address_detail text,
  add column if not exists destination_wait_minutes integer,
  add column if not exists reservation_hours_bracket text
    check (reservation_hours_bracket is null or reservation_hours_bracket in ('within_4h', 'within_8h', 'over_8h'));

-- 기존 오더는 전부 탁송(dispatch)으로 백필 — default로 이미 채워지지만 명시적으로 업데이트.
update orders set order_type = 'dispatch' where order_type is null or order_type = '';

-- 2. order_waypoints 테이블 — 경유지별 대기시간 추가
alter table order_waypoints
  add column if not exists wait_minutes integer;

-- 3. 프리미엄 구간 요금표 (시간 구간 기반, 지사별)
create table if not exists premium_fare_rules (
  id integer generated always as identity primary key,
  branch_id integer not null references branches(id) on delete cascade,
  tier_seq integer not null default 1,
  base_hours numeric(6,2) not null default 0,
  fare_amount integer not null default 0,
  extra_per_hour integer not null default 0,
  note text,
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
  unique (branch_id, tier_seq)
);
create index if not exists idx_premium_fare_rules_branch_id on premium_fare_rules(branch_id);
alter table premium_fare_rules enable row level security;
