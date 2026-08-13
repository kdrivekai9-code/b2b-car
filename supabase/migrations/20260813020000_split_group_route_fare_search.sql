-- 경로탐색/요금검색을 각각 따로 켜고 끌 수 있게 나눈다(실사용 요청).
-- 직전 마이그레이션(20260813010000)의 route_fare_search_enabled는 둘을 묶은 단일 토글이었다.
--
-- 기존 값을 그대로 물려받아 시작한다 — 묶여 있던 법인이 이 마이그레이션 하나로 설정이
-- 바뀌면 안 된다(꺼둔 법인은 둘 다 꺼짐, 켜둔 법인은 둘 다 켜짐).
alter table groups_tbl add column if not exists route_search_enabled boolean not null default true;
alter table groups_tbl add column if not exists fare_search_enabled boolean not null default true;

update groups_tbl
   set route_search_enabled = route_fare_search_enabled,
       fare_search_enabled = route_fare_search_enabled
 where route_fare_search_enabled is not null;

-- route_fare_search_enabled는 일부러 남겨둔다 — 이 SQL을 새 코드 배포 전에 실행해도
-- 그 순간 떠 있는 예전 코드가 계속 읽을 수 있어야 한다(expand-and-contract).
-- 배포가 안정된 뒤 별도로 지우면 된다:
--   alter table groups_tbl drop column route_fare_search_enabled;
