-- AI 접수: 경유지도 연락처/차량번호를 가질 수 있도록 컬럼 추가 (경유지가 실제 차량 인수 지점이 되는 경우)
alter table order_waypoints add column if not exists contact_phone text;
alter table order_waypoints add column if not exists vehicle_number text;
