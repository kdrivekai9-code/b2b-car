-- 요금표·고객통보를 지사별에서 법인별로 관리할 수 있게 한다(정책 변경).
--
-- 왜: 같은 지사에 소속된 법인이라도 계약 조건이 달라 요금과 통보 문구가 갈린다. 지금까지는
-- 지사 하나에 표가 하나뿐이라 법인마다 다른 조건을 담을 수 없었다.
--
-- 지사 표를 없애지는 않는다. 법인 표가 없으면 지사 표를 그대로 쓴다(폴백) — 기존에 지사별로
-- 만들어 둔 설정이 그대로 살아 있어야 하고, 법인마다 같은 내용을 다시 입력하게 만들 이유도 없다.
--
-- 배차지연 알림(dispatch_delay_settings)은 이미 group_id 컬럼이 있어 새 테이블을 만들지 않는다 —
-- 지사 화면에서만 관리하던 것을 법인 화면에서도 관리할 수 있게 하는 UI 작업이다.

-- ---------------- 탁송 요금표 (지사의 fare_rules / fare_extra_settings와 같은 모양) ----------------
create table if not exists group_fare_rules (
  id                 bigserial primary key,
  group_id           bigint not null references groups_tbl(id) on delete cascade,
  tier_seq           integer not null,
  base_distance_km   numeric not null default 0,
  base_fare          numeric not null default 0,
  surcharge_unit_km  numeric not null default 1,
  surcharge_fare     numeric not null default 0,
  max_distance_km    numeric,
  max_fare           numeric,
  round_unit         integer not null default 1000,
  round_method       text    not null default 'round',
  is_representative  integer not null default 0
);
create index if not exists idx_group_fare_rules_group on group_fare_rules(group_id, tier_seq);

create table if not exists group_fare_extra_settings (
  group_id                bigint primary key references groups_tbl(id) on delete cascade,
  round_trip_ratio        integer not null default 180,
  wait_threshold_min      integer not null default 15,
  wait_fee                integer not null default 0,
  cancel_before_fee       integer not null default 0,
  cancel_after_fee        integer not null default 0,
  fare_table_enabled      integer not null default 0,
  fare_visible_to_client  integer not null default 1,
  fare_editable_by_client integer not null default 0
);

-- ---------------- 일일기사 요금표 ----------------
-- 지사의 premium_fare_rules와 같은 시간구간 구조다. 이름을 일일기사로 바꾸는 이유: 이 표는 원래
-- "프리미엄/일일기사 공용"으로 만들어졌는데(lib/branchPolicy.js calculatePremiumFare 주석),
-- 실제로 등록해 쓰는 것은 일일기사다. 프리미엄(대리)은 요금 체계가 따로 나올 예정이라
-- 그때 별도 표를 만든다 — 지금 한 표에 두 상품을 계속 겹쳐두면 나중에 갈라내기 어렵다.
create table if not exists group_daily_driver_fare_rules (
  id             bigserial primary key,
  group_id       bigint not null references groups_tbl(id) on delete cascade,
  tier_seq       integer not null,
  base_hours     numeric not null default 0,
  fare_amount    numeric not null default 0,
  extra_per_hour numeric not null default 0,
  note           text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_group_daily_driver_fare_group on group_daily_driver_fare_rules(group_id, tier_seq);

-- ---------------- 고객 통보 ----------------
-- branch_customer_notifications와 같은 컬럼 구성. event_type은 lib/kakaoOrderNotify.js의
-- DEFAULT_EVENT_SETTINGS 키(dispatched/started/completed/dispatch_cancelled/cancelled)다.
create table if not exists group_customer_notifications (
  id               bigserial primary key,
  group_id         bigint not null references groups_tbl(id) on delete cascade,
  event_type       text   not null,
  enabled          boolean not null default true,
  delay_minutes    integer not null default 0,
  message_template text,
  attach_photos    boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (group_id, event_type)
);
