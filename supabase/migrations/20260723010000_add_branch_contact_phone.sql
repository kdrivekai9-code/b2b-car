-- 지사 담당자 연락처 필드 추가
alter table branches add column if not exists contact_phone text;
