-- 그룹(고객사) 관리를 법인 관리로 확장하기 위한 컬럼 추가
-- 내부 테이블명(groups_tbl)은 하위 호환을 위해 유지하고, 화면/업무 용어는 '법인'으로 사용한다.

alter table groups_tbl add column if not exists business_registration_number text;
alter table groups_tbl add column if not exists company_phone text;
alter table groups_tbl add column if not exists contact_name text;
alter table groups_tbl add column if not exists contact_phone text;
alter table groups_tbl add column if not exists business_address text;
alter table groups_tbl add column if not exists tax_email text;
alter table groups_tbl add column if not exists tax_invoice_issue_day integer;
alter table groups_tbl add column if not exists payment_due_day integer;
alter table groups_tbl add column if not exists settlement_method text;
