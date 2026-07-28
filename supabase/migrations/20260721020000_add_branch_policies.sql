-- 지사 관리 하위 정책(기획서 4.1절): 결제방식/운영시간/오더상태/요금표를 지사 단위로 오버라이드

create table if not exists branch_payment_methods (
  id integer generated always as identity primary key,
  branch_id integer not null references branches(id) on delete cascade,
  payment_method_id integer not null references payment_methods(id) on delete cascade,
  is_default integer not null default 0,
  unique (branch_id, payment_method_id)
);
create index if not exists idx_branch_payment_methods_branch_id on branch_payment_methods(branch_id);

create table if not exists operating_hours (
  id integer generated always as identity primary key,
  branch_id integer not null references branches(id) on delete cascade,
  day_type text not null check (day_type in ('weekday', 'weekend')),
  open_time text,
  close_time text,
  is_closed integer not null default 0,
  unique (branch_id, day_type)
);

create table if not exists operating_hour_exceptions (
  id integer generated always as identity primary key,
  branch_id integer not null references branches(id) on delete cascade,
  date text not null,
  is_closed integer not null default 1,
  open_time text,
  close_time text,
  note text,
  unique (branch_id, date)
);
create index if not exists idx_operating_hour_exceptions_branch_id on operating_hour_exceptions(branch_id);

create table if not exists order_status_config (
  id integer generated always as identity primary key,
  branch_id integer not null references branches(id) on delete cascade,
  status_code text not null,
  is_customer_visible integer not null default 1,
  is_backoffice_only integer not null default 0,
  sort_order integer not null default 0,
  unique (branch_id, status_code)
);
create index if not exists idx_order_status_config_branch_id on order_status_config(branch_id);

create table if not exists fare_rules (
  id integer generated always as identity primary key,
  branch_id integer not null references branches(id) on delete cascade,
  tier_seq integer not null,
  base_distance_km numeric not null default 0,
  base_fare integer not null default 0,
  surcharge_unit_km numeric not null default 1,
  surcharge_fare integer not null default 0,
  max_distance_km numeric,
  max_fare integer,
  round_unit integer not null default 1000,
  round_method text not null default 'round' check (round_method in ('up', 'round', 'down')),
  unique (branch_id, tier_seq)
);
create index if not exists idx_fare_rules_branch_id on fare_rules(branch_id);

create table if not exists fare_extra_settings (
  id integer generated always as identity primary key,
  branch_id integer not null references branches(id) on delete cascade unique,
  round_trip_ratio integer not null default 180,
  wait_threshold_min integer not null default 15,
  wait_fee integer not null default 0,
  cancel_before_fee integer not null default 0,
  cancel_after_fee integer not null default 0,
  fare_table_enabled integer not null default 0,
  fare_visible_to_client integer not null default 1,
  fare_editable_by_client integer not null default 0
);

alter table branch_payment_methods enable row level security;
alter table operating_hours enable row level security;
alter table operating_hour_exceptions enable row level security;
alter table order_status_config enable row level security;
alter table fare_rules enable row level security;
alter table fare_extra_settings enable row level security;
