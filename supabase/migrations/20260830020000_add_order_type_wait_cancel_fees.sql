-- 프리미엄대리 · 일일기사 전용 대기요금 / 취소요금.
--
-- 지금까지 wait_fee · cancel_before_fee · cancel_after_fee 한 벌을 **오더구분과 무관하게**
-- 모든 오더에 적용했다. 그런데 탁송(거리 기반)과 프리미엄/일일기사(시간 기반)는 요금 구조가
-- 아예 다르다 — 탁송 기준으로 정한 대기·취소요금이 시간제 오더에 그대로 붙으면 받지 말아야 할
-- 돈을 받는다.
--
-- 왜 컬럼을 나누나: 오더구분마다 값이 다르다는 것이 요구사항의 전부다. 한 벌을 두고 배수를
-- 곱하는 식으로 만들면 "프리미엄은 대기요금 안 받음"을 표현할 수 없다(0을 넣으면 탁송도 0이 된다).
--
-- 프리미엄과 일일기사를 또 나눈 이유: 요금표부터 따로다(premium_fare_rules는 지사,
-- group_daily_driver_fare_rules는 법인). 한 벌로 묶으면 한쪽을 고칠 때 다른 쪽이 같이 바뀐다.
alter table group_fare_extra_settings add column if not exists premium_wait_threshold_min integer;
alter table group_fare_extra_settings add column if not exists premium_wait_fee integer;
alter table group_fare_extra_settings add column if not exists premium_cancel_before_fee integer;
alter table group_fare_extra_settings add column if not exists premium_cancel_after_fee integer;
alter table group_fare_extra_settings add column if not exists daily_wait_threshold_min integer;
alter table group_fare_extra_settings add column if not exists daily_wait_fee integer;
alter table group_fare_extra_settings add column if not exists daily_cancel_before_fee integer;
alter table group_fare_extra_settings add column if not exists daily_cancel_after_fee integer;

alter table fare_extra_settings add column if not exists premium_wait_threshold_min integer;
alter table fare_extra_settings add column if not exists premium_wait_fee integer;
alter table fare_extra_settings add column if not exists premium_cancel_before_fee integer;
alter table fare_extra_settings add column if not exists premium_cancel_after_fee integer;
alter table fare_extra_settings add column if not exists daily_wait_threshold_min integer;
alter table fare_extra_settings add column if not exists daily_wait_fee integer;
alter table fare_extra_settings add column if not exists daily_cancel_before_fee integer;
alter table fare_extra_settings add column if not exists daily_cancel_after_fee integer;

-- 기본값을 채우지 않는다(NULL로 둔다). 0으로 채우면 "안 받음"과 "아직 안 정함"이 구별되지
-- 않는데, 지금 필요한 것은 **탁송 값이 새어 들어오지 않는 것**이고 그건 NULL로 충분하다
-- (lib/tripFees.js가 오더구분별 칸만 읽는다 — 비면 0원, 즉 안 받는다).
