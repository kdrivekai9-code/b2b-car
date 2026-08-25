-- 배차 요금 — 고객에게 청구하는 계약 요금과 분리한다(정책).
--
-- 지금까지 orders.fare_amount 하나가 두 가지를 겸했다: 고객 청구액이자, 콜마너로 보내는
-- 배차 금액(lib/callmaner.js buildOrderPayload의 price). 두 값은 성격이 다르다 —
-- 계약 요금은 거래처와 맺은 단가이고, 배차 요금은 기사를 붙이기 위해 콜마너에 거는 금액이다.
-- 하나로 묶여 있으면 계약 단가를 올리지 않고 배차만 서두르는 것이 불가능하다.
--
-- 고객 요금 안내는 계속 계약 요금(fare_amount)을 쓴다. 배차 요금은 화면에서 관리자만 본다.
alter table orders add column if not exists dispatch_fare_amount integer;

-- 지사별 배차용 요금표. 계약 요금표(fare_rules)와 같은 거리구간 구조다 — 화면·계산 규칙을
-- 그대로 재사용하려고 컬럼 구성을 맞췄다.
--
-- 왜 지사별인가: 배차 요금은 "이 지역에서 기사를 붙이는 데 얼마가 드는가"라 거래처와 무관하다.
-- 계약 요금은 법인별로 갈리지만(group_fare_rules) 이쪽은 그럴 이유가 없다.
create table if not exists branch_dispatch_fare_rules (
  id                bigserial primary key,
  branch_id         bigint not null references branches(id) on delete cascade,
  tier_seq          integer not null,
  base_distance_km  numeric not null default 0,
  base_fare         numeric not null default 0,
  surcharge_unit_km numeric not null default 1,
  surcharge_fare    numeric not null default 0,
  max_distance_km   numeric,
  max_fare          numeric,
  round_unit        integer not null default 1000,
  round_method      text    not null default 'round'
);
create index if not exists idx_branch_dispatch_fare_rules_branch
  on branch_dispatch_fare_rules(branch_id, tier_seq);

-- 요금표를 등록하지 않은 지사는 배차 요금이 비어 있다(계산하지 않는다). 그 경우 콜마너에는
-- 예전과 같이 0이 나간다 — 없는 값을 지어내지 않는다.
