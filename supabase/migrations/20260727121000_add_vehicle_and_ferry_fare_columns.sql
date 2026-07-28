alter table orders
  add column if not exists vehicle_type text,
  add column if not exists ferry_fare_amount integer not null default 0;

alter table inquiries
  add column if not exists estimated_ferry_fare integer;
