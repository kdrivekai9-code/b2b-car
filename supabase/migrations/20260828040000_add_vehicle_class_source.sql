-- 차종 판정이 "무엇을 근거로" 나왔는지 오더에 남긴다.
--
-- 지금은 car_type/fuel_type만 저장해서, 판정이 확실한 건과 그냥 아무것도 안 걸린 건이
-- 구분되지 않는다. 둘 다 car_type='국산'으로 떨어지기 때문이다:
--   · "그랜저"       → 국산 브랜드 사전에 걸림      = 확실히 국산
--   · "토레스"       → 어느 사전에도 안 걸림        = 그냥 모름
-- 두 번째가 문제다. 사전에 없는 이름이라 수입차든 1톤 화물이든 할증이 통째로 빠지는데,
-- 화면에는 정상으로 보인다. 판정 함수는 이 차이를 이미 알고 있었지만(reasons가 비어 있음)
-- 저장하지 않아 버려지고 있었다.
--
--   registered : 차종 관리에 등록된 차종과 매칭됨 (사람이 확인한 값)
--   auto       : 자동 인식 사전에 걸림
--   unknown    : 어느 사전에도 안 걸림 — 할증이 빠졌을 수 있으니 눈에 띄어야 한다
--   NULL       : 차종이 비었거나 마이그레이션 이전에 접수된 건
ALTER TABLE orders ADD COLUMN IF NOT EXISTS vehicle_class_source text;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_vehicle_class_source_chk;
ALTER TABLE orders ADD CONSTRAINT orders_vehicle_class_source_chk
  CHECK (vehicle_class_source IS NULL OR vehicle_class_source IN ('registered', 'auto', 'unknown'));

-- 미확인 건만 뽑아 보는 화면이 있으므로 부분 인덱스로 충분하다(대부분의 행은 unknown이 아니다).
CREATE INDEX IF NOT EXISTS orders_vehicle_class_unknown_idx
  ON orders(vehicle_class_source) WHERE vehicle_class_source = 'unknown';
