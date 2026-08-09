-- 경유지에서 다시 출발하는 일시.
--
-- 접수 분리 규칙(lib/orderSplit.js)은 "경유지 날짜가 출발 날짜와 다르면 오더를 나눈다"인데,
-- 정작 그 날짜를 받을 자리가 없었다 — LLM 추출은 경유지의 주소·연락처·차량번호만 뽑고
-- 예약일시는 오더 전체에 하나뿐이며, order_waypoints에도 날짜 컬럼이 없었다.
--
-- 대부분의 경유 운행은 같은 날 이어서 도니까 이 값은 비어 있는 게 정상이다(NULL = 같은 날).
-- 값이 있고 그것이 출발 날짜와 다를 때만 오더가 나뉜다.
alter table order_waypoints
  add column if not exists reserved_date text,
  add column if not exists reserved_time text;

-- 왕복 복귀편 일시. 왕복인데 복귀일이 가는 편과 다르면 오더를 나눈다.
-- trip_type은 이미 있다(프리미엄·일일기사에서 쓰던 값) — 복귀 일시를 담을 자리만 없었다.
alter table orders
  add column if not exists return_reserved_date text,
  add column if not exists return_reserved_time text;
