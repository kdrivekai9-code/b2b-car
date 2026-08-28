-- 차종 분석 결과를 이름 있는 분류값으로 저장한다.
--
-- 지금까지는 판정 결과가 is_imported / is_large / is_ev 세 개의 boolean으로만 있었다. 계산에는
-- 그게 맞지만(수입이면서 대형인 차가 있어 두 할증이 함께 붙는다), 목록·정산·외부 연동에서
-- "이 차가 뭐냐"를 한 칸으로 보려면 분류값이 필요하다.
--
-- car_type은 한 칸이라 겹치는 차(수입 대형 SUV 등)를 다 담지 못한다. 그래서 boolean 세 개를
-- 그대로 두고 **요금 계산은 계속 boolean이 한다** — car_type을 계산에 쓰면 수입 대형차에
-- 할증이 하나만 붙는다. car_type은 보여주기·분류용이다.

-- ── 차종 마스터 ────────────────────────────────────────────────────────────
-- car_type  : '국산' | '수입' | '대형'  (우선순위 수입 → 대형 → 국산)
-- fuel_type : 'ev' | NULL              (이름만으로 가솔린·디젤·LPG는 구분할 수 없다)
ALTER TABLE vehicle_models ADD COLUMN IF NOT EXISTS car_type text;
ALTER TABLE vehicle_models ADD COLUMN IF NOT EXISTS fuel_type text;

ALTER TABLE vehicle_models DROP CONSTRAINT IF EXISTS vehicle_models_car_type_chk;
ALTER TABLE vehicle_models ADD CONSTRAINT vehicle_models_car_type_chk
  CHECK (car_type IS NULL OR car_type IN ('국산', '수입', '대형'));
ALTER TABLE vehicle_models DROP CONSTRAINT IF EXISTS vehicle_models_fuel_type_chk;
ALTER TABLE vehicle_models ADD CONSTRAINT vehicle_models_fuel_type_chk
  CHECK (fuel_type IS NULL OR fuel_type IN ('ev'));

-- 이미 등록된 차종은 boolean에서 그대로 채운다 — 화면을 한 번 저장해야 값이 생기면
-- 그 사이에 접수된 오더가 분류 없이 남는다.
UPDATE vehicle_models SET
  car_type = CASE WHEN is_imported THEN '수입' WHEN is_large THEN '대형' ELSE '국산' END,
  fuel_type = CASE WHEN is_ev THEN 'ev' ELSE NULL END
WHERE car_type IS NULL;

-- ── 오더 ───────────────────────────────────────────────────────────────────
-- 접수 시점의 판정을 그대로 박아둔다. 차종 판정은 나중에 바뀔 수 있는데(사전 보강, 관리자
-- 수정) 이미 청구한 오더의 근거까지 따라 바뀌면 "왜 이 할증이 붙었나"를 되짚을 수 없다.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS car_type text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fuel_type text;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_car_type_chk;
ALTER TABLE orders ADD CONSTRAINT orders_car_type_chk
  CHECK (car_type IS NULL OR car_type IN ('국산', '수입', '대형'));
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_fuel_type_chk;
ALTER TABLE orders ADD CONSTRAINT orders_fuel_type_chk
  CHECK (fuel_type IS NULL OR fuel_type IN ('ev'));

CREATE INDEX IF NOT EXISTS orders_car_type_idx ON orders(car_type);
CREATE INDEX IF NOT EXISTS orders_fuel_type_idx ON orders(fuel_type);
