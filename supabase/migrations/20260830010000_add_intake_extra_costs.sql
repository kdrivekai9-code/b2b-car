-- 접수 단계 부대비용 입력 — 충전비 항목 추가, 항목별 세부 선택, 도선료 정산구분.
--
-- 지금까지 부대비용은 **오더가 끝난 뒤** 관리자가 오더상세 정산입력에서 손으로 넣는 것이었다.
-- 그런데 "주유 가득 채워서 갖다주세요", "손세차 해주세요"는 접수할 때 정하는 일이다.
-- 접수 때 못 적으면 메모에 적히고, 메모는 정산에 안 잡힌다 — 청구 누락의 흔한 출처다.

-- ── 충전비 ─────────────────────────────────────────────────────────────────
-- 전기차 탁송이 늘면서 주유비와 나란히 필요해졌다. 주유비와 완전히 같은 규칙으로 돈다
-- (가득/금액입력 + 정산구분 3단계).
--
-- 옛 *_included(0/1)와 새 *_mode를 둘 다 만든다 — 나머지 항목과 컬럼 모양을 맞춰야
-- lib/fareSurcharge.js의 폴백 규칙(extraCostMode)이 항목을 가리지 않고 똑같이 돈다.
alter table group_fare_extra_settings add column if not exists charge_included integer;
alter table group_fare_extra_settings add column if not exists charge_mode text;
alter table fare_extra_settings add column if not exists charge_included integer;
alter table fare_extra_settings add column if not exists charge_mode text;

-- ── 항목별 세부 선택 ────────────────────────────────────────────────────────
-- 주유비/충전비의 '가득(full)', 세차비의 '자동세차/손세차'. 비고(note)에 글로 적지 않고
-- 코드로 남긴다 — 글로 적으면 집계도 검색도 안 되고, 기사에게 전달할 때마다 사람이 읽어야 한다.
--
-- '가득'은 접수 시점에 **금액을 모른다**. 그래서 amount 0인 줄이 생긴다. 0원 줄이 정산서에
-- 올라가면 안 되므로 집계 쪽(routes/groups.js loadSettlement)에서 amount > 0만 센다.
alter table order_extra_charges add column if not exists option_code text;

-- ── 도선료 정산구분 ─────────────────────────────────────────────────────────
-- 도선료 금액은 orders.ferry_fare_amount 하나에서 온다(경로탐색이 자동으로 채운다).
-- order_extra_charges에 줄을 만들면 두 번 청구되므로 만들지 않는다 — 그래서 정산구분을
-- 담을 곳이 orders에 있어야 한다. 비면 요금설정의 ferry_mode를 따른다.
alter table orders add column if not exists ferry_settle_mode text;
