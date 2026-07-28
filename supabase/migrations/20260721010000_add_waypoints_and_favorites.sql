-- 오더 등록 화면 보완: 다중 경유지 지원 + 즐겨찾기 주소
-- 기존 orders.waypoint_address(단일 텍스트)를 order_waypoints 하위 테이블로 이전한다.

create table if not exists order_waypoints (
  id integer generated always as identity primary key,
  order_id integer not null references orders(id) on delete cascade,
  seq integer not null,
  address text not null
);
create index if not exists idx_order_waypoints_order_id on order_waypoints(order_id);

insert into order_waypoints (order_id, seq, address)
  select id, 1, waypoint_address from orders
  where waypoint_address is not null and waypoint_address <> '';

alter table orders drop column if exists waypoint_address;

create table if not exists favorite_addresses (
  id integer generated always as identity primary key,
  user_id integer not null references users(id) on delete cascade,
  label text not null,
  address text not null,
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);
create index if not exists idx_favorite_addresses_user_id on favorite_addresses(user_id);

alter table order_waypoints enable row level security;
alter table favorite_addresses enable row level security;
