-- 구간별 사진 업로드 링크.
--
-- 구간 릴레이(order_legs)는 한 오더를 여러 기사가 나눠 운행하는데, 사진 업로드 토큰은
-- orders에 하나뿐이었다(20260722010000). 그래서 세 기사에게 같은 링크를 주게 되고, 올라온
-- 사진이 어느 구간 것인지 구분할 방법이 없었다 — 인수 시점 사진과 인도 시점 사진이 뒤섞인다.
-- 구간 릴레이 슬라이스에서 "나중에"로 미뤄둔 부분이다.
--
-- 오더 토큰은 그대로 둔다. 구간이 없는 오더(단일 배정, 마이그레이션 이전 오더)는 지금처럼
-- 오더 토큰 하나로 계속 동작해야 한다.
alter table order_legs
  add column if not exists photo_upload_token text default gen_random_uuid()::text;

-- 이미 있는 구간 행에도 채운다. volatile default라 행마다 다른 값이 들어가지만, 컬럼 추가
-- 시점에 따라 NULL로 남는 경우가 있어 명시적으로 한 번 더 채운다.
update order_legs set photo_upload_token = gen_random_uuid()::text where photo_upload_token is null;

-- 링크는 로그인 없이 접근하는 통로다. 토큰이 겹치면 남의 오더 사진을 올리거나 볼 수 있다.
create unique index if not exists uq_order_legs_photo_upload_token
  on order_legs(photo_upload_token) where photo_upload_token is not null;

-- 어느 구간에서 올린 사진인지. 구간이 없는 오더에서 올린 사진은 NULL로 남는다(정상).
alter table order_photos
  add column if not exists leg_seq integer;

create index if not exists idx_order_photos_leg on order_photos(order_id, leg_seq);
