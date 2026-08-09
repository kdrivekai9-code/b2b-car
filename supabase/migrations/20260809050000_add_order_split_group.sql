-- 나눠 접수한 오더들의 묶음.
--
-- 실제 운영 규칙(사용자 확인, 2026-08-09): 경유지가 있거나 · 왕복콜이거나 · 구간마다 수행일이
-- 다르면 오더 하나로 받지 않고 구간마다 별도 오더로 접수한다.
--   경유지: 출발→경유 1건, 경유→최종목적지 1건
--   왕복:   출발→도착 1건, 도착→출발 1건
--
-- 그동안 시스템은 이 규칙을 몰라서, 카카오 접수는 경유지가 보이면 자동 등록을 포기하고 상담원에게
-- 넘겼다(경유지를 그대로 등록하면 조용히 사라지기 때문). 상담원이 손으로 2건을 만들고 있었다.
--
-- 나눈 뒤에는 두 건이 서로 남남이 된다 — 목록에서 나란히 보이지도 않고, 한쪽을 취소할 때 다른
-- 쪽이 남아 있다는 것도 알 수 없다. 같은 요청에서 나왔다는 사실을 남긴다.
alter table orders
  -- 같은 요청에서 나온 건들이 공유하는 값. 한 건짜리 접수는 NULL(대부분의 오더).
  add column if not exists split_group_id text,
  -- 묶음 안에서 몇 번째인지 / 전부 몇 건인지. "1/2건"으로 보여주기 위한 값이다.
  add column if not exists split_seq integer,
  add column if not exists split_total integer;

create index if not exists idx_orders_split_group
  on orders(split_group_id) where split_group_id is not null;
