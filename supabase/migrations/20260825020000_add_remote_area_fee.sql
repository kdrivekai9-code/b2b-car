-- 오지요금(추가요금) — 법인별 탁송 요금표.
--
-- 행정지명이 "리"로 끝나는 곳(법정리)은 도심에서 멀고 진입로가 좁아 같은 거리라도 시간이 더
-- 걸린다. 거리 기반 구간요금만으로는 그 차이를 담을 수 없어, 해당 구간에 정액을 더한다.
--
-- 지사 요금표(fare_extra_settings)에는 넣지 않았다. 법인별로 요구가 갈리는 항목이라 법인 표에만
-- 두고, 지사 표가 선택된 경우에는 값이 없으므로 0으로 동작한다(lib/branchPolicy.js calculateFare).
--
-- 금액 범위는 1,000~10,000원(사용자 확정). 0은 "오지요금 안 받음"이다.
alter table group_fare_extra_settings
  add column if not exists remote_area_fee integer;
