-- 법인대리(프리미엄) 편도 요금표 — **탁송과 같은 거리 구간 방식.**
--
-- 왜 필요한가: 프리미엄대리는 요금표가 없었다. 화면에도 그렇게 적혀 있었다
-- ("프리미엄(대리) 요금 체계가 아직 정해지지 않아 자리만 만들어 두었습니다").
--
-- 그런데 표가 없다고 청구가 멈추지는 않았다. 실측한 실제 동작은 이렇다:
--   · 오더 등록 화면: /orders/fare-preview가 **오더구분을 안 봐서 탁송 요금표로** 계산했다.
--     즉 프리미엄 오더에 탁송 금액이 들어갔다.
--   · 챗봇/상담톡 접수: fareAmount 0으로 등록한다(lib/webPremiumIntakeService.js) — 이건
--     탁송 챗봇 접수도 같은 정책이다(상담원이 확정할 때까지 비워둠, 사용자 확정 2026-08-24).
--   · 화면 안내문은 "일일기사 요금표를 그대로 쓴다"고 적혀 있었지만 **그렇게 동작한 적은 없다**
--     (/orders/premium-fare-preview는 호출하는 화면이 없었다).
-- 실측: order_type='premium' 1건(OID1459, 카카오 접수) fare_amount=0.
--
-- 사용자 확정(2026-09-08): 법인대리(프리미엄)는 편도 서비스이고 요금은 탁송처럼 거리 기준으로
-- 만든다. 시간 기준(5시간 90,000원 …)은 **일일기사** 상품이고 그건 이미 별도 표가 있다
-- (premium_fare_rules / group_daily_driver_fare_rules).
--
-- ⚠ 이름 함정: 기존 `premium_fare_rules`는 이름과 달리 **일일기사** 시간 구간표다. 법인 쪽
-- 이름이 `group_daily_driver_fare_rules`인 것이 그 증거다(routes/groups.js 주석에 경위가 있다).
-- 그 표를 건드리지 않고 새로 만든다 — 두 상품은 청구 기준이 다르므로 한 표를 공유할 수 없다.
-- 새 이름에 oneway를 넣은 이유가 그것이다. 지금 이름을 바꾸면 일일기사 청구가 멈춘다.
--
-- 열 구성은 탁송(fare_rules / group_fare_rules)과 같게 맞췄다. 계산도 같은 함수를 쓴다
-- (lib/branchPolicy.js fareFromTiers) — 두 상품이 같은 방식이면 계산을 두 벌 만들 이유가 없다.
--
-- 법인 표가 있으면 법인 것이 이기고, 없으면 지사 표를 쓴다(탁송·일일기사와 같은 순서).

create table if not exists premium_oneway_fare_rules (
  id serial primary key,
  branch_id integer not null references branches(id) on delete cascade,
  tier_seq integer not null,
  base_distance_km numeric not null,
  base_fare integer not null,
  surcharge_unit_km numeric not null,
  surcharge_fare integer not null,
  -- 상한. null이면 상한 없음(탁송 표와 같은 뜻).
  max_distance_km numeric,
  max_fare numeric,
  round_unit integer not null default 1000,
  round_method text not null default 'round',
  note text,
  created_at text default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);

create table if not exists group_premium_oneway_fare_rules (
  id serial primary key,
  group_id bigint not null references groups_tbl(id) on delete cascade,
  tier_seq integer not null,
  base_distance_km numeric not null,
  base_fare numeric not null,
  surcharge_unit_km numeric not null,
  surcharge_fare numeric not null,
  max_distance_km numeric,
  max_fare numeric,
  round_unit integer not null default 1000,
  round_method text not null default 'round',
  note text,
  created_at text default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);

-- 구간을 순서대로 읽는다(요금 계산이 tier_seq로 정렬해 가져간다).
create index if not exists premium_oneway_fare_rules_branch_seq
  on premium_oneway_fare_rules (branch_id, tier_seq);
create index if not exists group_premium_oneway_fare_rules_group_seq
  on group_premium_oneway_fare_rules (group_id, tier_seq);

-- **값은 넣지 않는다.** 빈 표가 요금 계산에 끼어들면 안 된다 —
-- 등록된 구간이 없으면 계산이 { enabled: false }를 돌려주고, 요금 문의는 "등록되어 있지
-- 않습니다"로 안내한다. 기본값을 넣어두면 관리자가 정한 적 없는 금액이 청구된다.
