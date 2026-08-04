-- 콜마너 외부연동(오더접수 등록 + 상태동기화)을 위한 컬럼/테이블 추가.
-- 1. 오더접수(OrderReceipt) API가 요구하는 좌표/행정구역(시도/시구군/동)을 저장한다.
--    origin_lat/origin_lon/destination_lat/destination_lon은 routes/orders.js의 §7-2
--    자동승격 판정 코드가 이미 참조하고 있던 컬럼명이라 그대로 맞춘다(그동안 컬럼이 없어
--    해당 분기가 항상 폴백 경로로만 빠지고 있었음 — 이번 추가로 함께 정상 동작하게 된다).
alter table orders add column if not exists origin_lat numeric;
alter table orders add column if not exists origin_lon numeric;
alter table orders add column if not exists destination_lat numeric;
alter table orders add column if not exists destination_lon numeric;
alter table orders add column if not exists origin_sido text;
alter table orders add column if not exists origin_sigugun text;
alter table orders add column if not exists origin_dong text;
alter table orders add column if not exists destination_sido text;
alter table orders add column if not exists destination_sigugun text;
alter table orders add column if not exists destination_dong text;

-- §7-2 자동승격 로직(routes/orders.js)이 참조하는 경유지 좌표 컬럼(콜마너 viaList 연동은 이번 범위 밖).
alter table order_waypoints add column if not exists lat numeric;
alter table order_waypoints add column if not exists lon numeric;

-- 2. 콜마너 오더접수/상태동기화 결과 저장
alter table orders add column if not exists callmaner_conf_slip text;
alter table orders add column if not exists callmaner_status text;
alter table orders add column if not exists callmaner_status_code text;
alter table orders add column if not exists callmaner_synced_at text;
alter table orders add column if not exists callmaner_last_error text;
create index if not exists idx_orders_callmaner_conf_slip on orders(callmaner_conf_slip);

-- 3. 지사별 콜마너 사용여부/연동코드 — providerId = {branches.code}-{branches.main_phone}-{callmaner_app_code}
alter table branches add column if not exists callmaner_enabled boolean not null default false;
alter table branches add column if not exists callmaner_app_code text;

-- 4. 지사별 OrderAllStatus 폴링 커서(lastUpDate) 보관
create table if not exists callmaner_sync_state (
  branch_id integer primary key references branches(id),
  last_up_date text not null default '0',
  updated_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);
alter table callmaner_sync_state enable row level security;
