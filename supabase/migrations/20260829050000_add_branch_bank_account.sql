-- 지사 입금계좌 — 청구서에 찍는다.
--
-- 지금까지 청구서에 계좌가 없어서, 받는 쪽이 어디로 입금해야 하는지 별도로 물어야 했다.
-- 법인 계좌(회사 정보)라 청구서에 공개되는 값이다.
--
-- 세 칸으로 나눈다. "국민 123-45-678 (주)씨엠엔피" 한 줄로 받으면 은행만 바꾸려 해도 전체를
-- 다시 쓰게 되고, 예금주가 빠진 채 저장돼도 알 수 없다.
alter table branches add column if not exists bank_name text;
alter table branches add column if not exists bank_account text;
alter table branches add column if not exists bank_holder text;
