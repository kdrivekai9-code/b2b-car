-- 대형/화물 할증을 차종별로 등록한다.
--
-- 단가표의 대형/화물 할증이 "+5,000원 ~ 10,000원"인 것은 차종마다 부담이 다르기 때문이다
-- (RV 카니발과 1톤 화물 탑차를 같은 금액으로 받을 이유가 없다). 지금은 지사/법인마다 한
-- 금액(large_car_fee)뿐이라 그 차이를 담지 못한다.
--
-- large_car_fee는 지우지 않고 **기본값**으로 남긴다. 차종별 행이 없으면 그 금액을 쓴다 —
-- 안 그러면 대형 차종을 하나하나 등록하기 전까지 대형 할증이 통째로 사라진다.
CREATE TABLE IF NOT EXISTS fare_large_car_fees (
  id               bigserial PRIMARY KEY,
  branch_id        integer REFERENCES branches(id) ON DELETE CASCADE,
  group_id         integer REFERENCES groups_tbl(id) ON DELETE CASCADE,
  vehicle_model_id bigint NOT NULL REFERENCES vehicle_models(id) ON DELETE CASCADE,
  fee              integer NOT NULL DEFAULT 0,
  seq              integer NOT NULL DEFAULT 1,
  created_at       text DEFAULT to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
  -- 지사/법인 중 한쪽에만 값이 들어간다(fare_place_surcharges와 같은 규칙).
  CONSTRAINT fare_large_car_fees_scope CHECK (
    (branch_id IS NOT NULL AND group_id IS NULL) OR (branch_id IS NULL AND group_id IS NOT NULL)
  )
);

-- 같은 차종을 한 스코프에 두 번 넣으면 어느 금액이 맞는지 알 수 없다. DB에서 막는다.
CREATE UNIQUE INDEX IF NOT EXISTS fare_large_car_fees_branch_model_idx
  ON fare_large_car_fees(branch_id, vehicle_model_id) WHERE branch_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fare_large_car_fees_group_model_idx
  ON fare_large_car_fees(group_id, vehicle_model_id) WHERE group_id IS NOT NULL;
