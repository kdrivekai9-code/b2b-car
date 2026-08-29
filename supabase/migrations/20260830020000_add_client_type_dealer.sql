-- 법인 계정 구분 — 법인 본사 직원 vs 개인 딜러.
--
-- 지금까지 법인(client) 계정은 전부 같았다. 같은 법인이면 서로의 오더를 다 볼 수 있었는데,
-- 개인 딜러는 사실상 독립 사업자라 남의 오더까지 보이면 안 된다. 정산도 따로 받는 경우가 있다.
--
--   hq     법인 본사 직원 — 소속 딜러의 오더까지 본다
--   dealer 개인 딜러      — **본인이 접수한 오더만** 본다(웹·챗봇·상담톡 모두)
--
-- 기본값을 'hq'로 두는 이유: 지금 있는 계정은 전부 본사 직원으로 쓰이고 있다. 마이그레이션만으로
-- 누군가의 화면에서 오더가 사라지면 안 된다 — 딜러 지정은 사람이 명시적으로 한다.
alter table users add column if not exists client_type text;
update users set client_type = 'hq' where role = 'client' and client_type is null;

alter table users drop constraint if exists users_client_type_chk;
alter table users add constraint users_client_type_chk
  check (client_type is null or client_type in ('hq', 'dealer'));

-- 개인 딜러에게 정산서를 따로 끊을지. 끄면 본사 정산서에 합쳐진다.
--
-- 딜러라고 무조건 따로 청구하는 것이 아니다 — 오더는 본인 것만 보되 정산은 본사가 한꺼번에
-- 받는 계약이 흔하다. 그 둘은 별개라서 칸을 나눈다.
alter table users add column if not exists separate_settlement boolean not null default false;

-- 정산 화면이 "이 법인의 딜러 목록"을 자주 뽑는다.
create index if not exists users_group_client_type_idx
  on users(group_id, client_type) where role = 'client';
