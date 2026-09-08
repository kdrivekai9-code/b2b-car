-- 기사가 누른 운행 단계 기록.
--
-- 지금까지 진행 상황은 콜마너에서 흘러들어온 상태값(기사배정 → 운행시작 → 완료) 하나뿐이었다.
-- 그 값은 출발지 도착과 경유지 대기를 구분하지 못한다. 경유지가 있는 건은 기사가 어디서
-- 무엇을 기다리는지 아무도 모르고, "지금 어디예요"를 전화로 물어야 했다.
--
-- 기사 화면 아래에 단계 버튼을 순서대로 깔고(출발지 도착 → 운행 시작 → 경유지N 대기 →
-- 운행 시작 → … → 운행 완료), 누른 시각을 여기 남긴다.
--
-- 왜 orders에 컬럼으로 안 넣나: 단계 수가 경유지 개수에 따라 달라진다. 컬럼으로 두면
-- 경유지 3개짜리 오더를 위해 컬럼을 여섯 개 만들어야 하고, 네 개짜리가 오면 또 늘려야 한다.
--
-- 왜 order_status_history에 안 넣나: 그 표는 "오더 상태가 무엇에서 무엇으로 바뀌었나"를
-- 담는다. 이 단계들은 오더 상태를 바꾸지 않는다(배차 상태는 콜마너가 주인이다 —
-- 사용자 확정 규칙). 성격이 다른 것을 같은 표에 섞으면 상태 이력 화면이 읽기 어려워진다.
create table if not exists order_trip_steps (
  id bigserial primary key,
  order_id bigint not null references orders(id),
  -- origin_arrived | drive_started | waypoint_wait | waypoint_resume | trip_completed
  step_key text not null,
  -- 경유지 번호(1부터). 경유지와 무관한 단계는 0.
  seq integer not null default 0,
  -- waypoint_resume에만 채운다: 그 경유지에서 실제로 기다린 분.
  --
  -- order_waypoints.wait_minutes에 쓰지 않는다. 그 값은 접수 때 정한 **예정** 대기이고
  -- 오더타입 자동승격 판정(lib/premiumUpgrade.js)에 들어가는 요금성 값이다 — 실제 대기로
  -- 덮으면 기사가 버튼을 누르는 것만으로 오더 타입이 바뀔 수 있다.
  wait_minutes integer,
  -- 누른 기사. 오더에 배차된 기사가 바뀔 수 있어(재배차) 누가 눌렀는지 남긴다.
  driver_id bigint references drivers(id),
  -- KST 'YYYY-MM-DD HH:MM:SS'. 이 저장소의 다른 시각 컬럼과 같은 형식이다(text·KST).
  occurred_at text not null,
  created_at text not null default now()::text
);

-- 같은 단계를 두 번 남기지 않는다. 기사 손가락이 두 번 닿거나(장갑) 네트워크가 느려 다시
-- 눌렀을 때 대기시간이 두 번 계산되면 기록이 못 쓰게 된다.
create unique index if not exists order_trip_steps_uniq
  on order_trip_steps(order_id, step_key, seq);

create index if not exists order_trip_steps_order_idx on order_trip_steps(order_id);
