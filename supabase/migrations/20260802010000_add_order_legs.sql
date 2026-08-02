-- 구간 릴레이 슬라이스 1: 구간(leg)별 기사 배정. 주소 텍스트는 저장하지 않는다 —
-- 오더는 생성 후 수정 불가라 orders.origin_address + order_waypoints(seq순) +
-- orders.destination_address 조합이 절대 안 바뀌므로, 매번 그 조합에서 구간을 조립해서
-- 보여주고 이 테이블은 "구간별 기사 배정" 그 자체만 저장한다. 마이그레이션 이전에 생성된
-- 기존 오더는 이 테이블에 행이 없고, 그런 오더는 계속 orders.assigned_driver_id 단일
-- 배정 화면을 그대로 쓴다(routes/orders.js, views/orders/detail.ejs에서 legs.length로 분기).

create table if not exists order_legs (
  id integer generated always as identity primary key,
  order_id integer not null references orders(id) on delete cascade,
  seq integer not null,
  driver_id integer references drivers(id),
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
  unique (order_id, seq)
);
create index if not exists idx_order_legs_order_id on order_legs(order_id);

alter table order_legs enable row level security;
