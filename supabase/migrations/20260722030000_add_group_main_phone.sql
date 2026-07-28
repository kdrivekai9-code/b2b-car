-- 오더 리스트 '대표번호' 컬럼은 요청 그룹(고객사)의 대표번호다.
alter table groups_tbl add column if not exists main_phone text;
