-- 기사 사진 업로드(기획서 5.5절) + 관련 지사 설정(사진 업로드 안내/안내 이미지/사진 보기 권한)

create table if not exists drivers (
  id integer generated always as identity primary key,
  branch_id integer not null references branches(id) on delete cascade,
  name text not null,
  phone text,
  status text not null default 'active',
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);
create index if not exists idx_drivers_branch_id on drivers(branch_id);

alter table orders add column if not exists assigned_driver_id integer references drivers(id);
alter table orders add column if not exists photo_upload_token text unique default gen_random_uuid()::text;

create table if not exists order_photos (
  id integer generated always as identity primary key,
  order_id integer not null references orders(id) on delete cascade,
  url text not null,
  uploaded_by_driver_id integer references drivers(id),
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);
create index if not exists idx_order_photos_order_id on order_photos(order_id);

create table if not exists branch_photo_settings (
  id integer generated always as identity primary key,
  branch_id integer not null references branches(id) on delete cascade unique,
  guide_text text,
  guide_image_url text,
  client_can_view integer not null default 0,
  branch_manager_can_view integer not null default 0
);

alter table drivers enable row level security;
alter table order_photos enable row level security;
alter table branch_photo_settings enable row level security;
