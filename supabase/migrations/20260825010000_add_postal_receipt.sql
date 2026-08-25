-- 우편발송(등기) 요청 건의 인수증 업로드.
--
-- 왜: 상담 로그에 서류를 우편으로 보내달라는 요청이 반복해서 나온다("인감, 차량등록증 있으며
-- 서울지점으로 등기발송부탁드립니다"). 그런데 기사가 등기를 부치고 나면 등기번호와 인수증이
-- 어디에도 남지 않아, 고객이 "보냈나요?"라고 물으면 상담원이 기사에게 따로 확인해야 했다.
--
-- 콜마너로 배차된 기사는 우리 기사 앱을 쓰지 않는다. 그래서 접수 시 업로드 링크를 만들어
-- 기사메모(콜마너 적요1)에 실어 보내고, 기사가 그 링크로 등기번호와 인수증 사진을 올린다.

-- 이 오더가 우편발송 요청 건인가. 요청사항 문구로 판정한다(lib/postalReceipt.js).
alter table orders
  add column if not exists postal_requested boolean;

-- 업로드 페이지 토큰. 짧아야 한다 — 적요1이 100Byte뿐인데 차량번호와 기사 전달사항이 이미
-- 그 안에 들어 있다. UUID(36자)면 링크만 71Byte라 기사 전달사항에 4글자밖에 안 남는다.
-- 8자면 링크가 38Byte가 되어 15글자쯤 남는다(lib/postalReceipt.js generateReceiptToken).
alter table orders
  add column if not exists receipt_upload_token text;

create unique index if not exists idx_orders_receipt_upload_token
  on orders(receipt_upload_token)
  where receipt_upload_token is not null;

-- 올라온 인수증. 등기번호는 여러 건을 나눠 부치는 경우가 있어 사진과 함께 행 단위로 둔다
-- (오더 컬럼 하나로 두면 두 번째 등기번호가 첫 번째를 덮어쓴다).
create table if not exists order_receipts (
  id serial primary key,
  order_id integer not null references orders(id) on delete cascade,
  -- 등기번호. 사진만 올리고 번호를 모르는 경우가 있어 필수로 두지 않는다.
  tracking_no text,
  -- 인수증 사진. Supabase Storage 공개 URL(lib/storage.js) — 사진 없이 번호만 올릴 수도 있다.
  url text,
  created_at timestamptz not null default now()
);

create index if not exists idx_order_receipts_order
  on order_receipts(order_id, id);
