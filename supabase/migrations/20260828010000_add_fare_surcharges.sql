-- 탁송 특화 할증 + 부대비용(실비) 정산 설정
--
-- 기존 오지요금(20260825020000)은 법인 설정에만 넣었는데, 법인이 "이 요금표 사용"을 끄면
-- 지사 요금표(fare_extra_settings)로 떨어지면서 할증이 통째로 사라진다. 같은 함정을 반복하지
-- 않도록 이번 항목들은 **두 테이블 모두**에 넣고, 지사 쪽에 빠져 있던 remote_area_fee도 같이 맞춘다.

-- ── 할증 금액(원). 0 = 그 할증 안 받음. 받을 때는 1,000~20,000원(화면·계산 양쪽에서 가둔다) ──
ALTER TABLE group_fare_extra_settings ADD COLUMN IF NOT EXISTS imported_car_fee integer DEFAULT 0;
ALTER TABLE group_fare_extra_settings ADD COLUMN IF NOT EXISTS large_car_fee integer DEFAULT 0;
ALTER TABLE group_fare_extra_settings ADD COLUMN IF NOT EXISTS ev_fee integer DEFAULT 0;
ALTER TABLE group_fare_extra_settings ADD COLUMN IF NOT EXISTS night_fee integer DEFAULT 0;
ALTER TABLE group_fare_extra_settings ADD COLUMN IF NOT EXISTS document_fee integer DEFAULT 0;
ALTER TABLE group_fare_extra_settings ADD COLUMN IF NOT EXISTS predelivery_wash_fee integer DEFAULT 0;

ALTER TABLE fare_extra_settings ADD COLUMN IF NOT EXISTS remote_area_fee integer DEFAULT 0;
ALTER TABLE fare_extra_settings ADD COLUMN IF NOT EXISTS imported_car_fee integer DEFAULT 0;
ALTER TABLE fare_extra_settings ADD COLUMN IF NOT EXISTS large_car_fee integer DEFAULT 0;
ALTER TABLE fare_extra_settings ADD COLUMN IF NOT EXISTS ev_fee integer DEFAULT 0;
ALTER TABLE fare_extra_settings ADD COLUMN IF NOT EXISTS night_fee integer DEFAULT 0;
ALTER TABLE fare_extra_settings ADD COLUMN IF NOT EXISTS document_fee integer DEFAULT 0;
ALTER TABLE fare_extra_settings ADD COLUMN IF NOT EXISTS predelivery_wash_fee integer DEFAULT 0;

-- ── 야간/조조 판정 시간대. 자정을 넘는 구간(22:00~01:00)이라 시작>종료인 경우를 허용한다 ──
ALTER TABLE group_fare_extra_settings ADD COLUMN IF NOT EXISTS night_start_hm text DEFAULT '22:00';
ALTER TABLE group_fare_extra_settings ADD COLUMN IF NOT EXISTS night_end_hm text DEFAULT '01:00';
ALTER TABLE group_fare_extra_settings ADD COLUMN IF NOT EXISTS early_start_hm text DEFAULT '06:00';
ALTER TABLE group_fare_extra_settings ADD COLUMN IF NOT EXISTS early_end_hm text DEFAULT '09:00';

ALTER TABLE fare_extra_settings ADD COLUMN IF NOT EXISTS night_start_hm text DEFAULT '22:00';
ALTER TABLE fare_extra_settings ADD COLUMN IF NOT EXISTS night_end_hm text DEFAULT '01:00';
ALTER TABLE fare_extra_settings ADD COLUMN IF NOT EXISTS early_start_hm text DEFAULT '06:00';
ALTER TABLE fare_extra_settings ADD COLUMN IF NOT EXISTS early_end_hm text DEFAULT '09:00';

-- ── 오지 판정 범위. 'ri' = 리만 / 'ri_eup_myeon' = 리·읍·면 ──
-- 기본값을 'ri'로 두는 이유: 이미 오지요금을 쓰고 있는 법인의 판정 범위가 마이그레이션만으로
-- 넓어지면 안 된다. 읍/면을 받으려면 화면에서 명시적으로 바꾸게 한다.
ALTER TABLE group_fare_extra_settings ADD COLUMN IF NOT EXISTS remote_area_scope text DEFAULT 'ri';
ALTER TABLE fare_extra_settings ADD COLUMN IF NOT EXISTS remote_area_scope text DEFAULT 'ri';

-- ── 부대비용 포함/제외. 1 = 기본요금 포함(청구 불가) / 0 = 제외(실비 정산) ──
-- 기본값은 단가표 기준: 일반 고속도로 통행료만 포함, 나머지는 실비.
ALTER TABLE group_fare_extra_settings ADD COLUMN IF NOT EXISTS toll_normal_included integer DEFAULT 1;
ALTER TABLE group_fare_extra_settings ADD COLUMN IF NOT EXISTS toll_special_included integer DEFAULT 0;
ALTER TABLE group_fare_extra_settings ADD COLUMN IF NOT EXISTS parking_included integer DEFAULT 0;
ALTER TABLE group_fare_extra_settings ADD COLUMN IF NOT EXISTS fuel_included integer DEFAULT 0;
ALTER TABLE group_fare_extra_settings ADD COLUMN IF NOT EXISTS wash_included integer DEFAULT 0;

ALTER TABLE fare_extra_settings ADD COLUMN IF NOT EXISTS toll_normal_included integer DEFAULT 1;
ALTER TABLE fare_extra_settings ADD COLUMN IF NOT EXISTS toll_special_included integer DEFAULT 0;
ALTER TABLE fare_extra_settings ADD COLUMN IF NOT EXISTS parking_included integer DEFAULT 0;
ALTER TABLE fare_extra_settings ADD COLUMN IF NOT EXISTS fuel_included integer DEFAULT 0;
ALTER TABLE fare_extra_settings ADD COLUMN IF NOT EXISTS wash_included integer DEFAULT 0;

-- ── 목적지 주소 포함 장소 할증(예: "유원지") ────────────────────────────────
-- 지사/법인 중 한쪽에만 값이 들어간다. 두 테이블로 나누면 조회·저장 코드가 두 벌이 되어
-- 한쪽만 고치는 사고가 나므로 한 테이블에 담고 scope로 가른다.
CREATE TABLE IF NOT EXISTS fare_place_surcharges (
  id          bigserial PRIMARY KEY,
  branch_id   integer REFERENCES branches(id) ON DELETE CASCADE,
  group_id    integer REFERENCES groups_tbl(id) ON DELETE CASCADE,
  keyword     text NOT NULL,
  fee         integer NOT NULL DEFAULT 0,
  seq         integer NOT NULL DEFAULT 1,
  created_at  text DEFAULT to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
  CONSTRAINT fare_place_surcharges_scope CHECK (
    (branch_id IS NOT NULL AND group_id IS NULL) OR (branch_id IS NULL AND group_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS fare_place_surcharges_branch_idx ON fare_place_surcharges(branch_id);
CREATE INDEX IF NOT EXISTS fare_place_surcharges_group_idx ON fare_place_surcharges(group_id);

-- ── 특수 구간 통행료(민자 교량 등) ──────────────────────────────────────────
-- 이름으로 경로/주소를 훑어 걸리면 실비를 자동으로 정산 항목에 얹는다.
-- fee는 "보통 이 금액"이라는 기본값이고, 실제 청구는 영수증 금액으로 덮어쓸 수 있다.
CREATE TABLE IF NOT EXISTS fare_special_tolls (
  id          bigserial PRIMARY KEY,
  branch_id   integer REFERENCES branches(id) ON DELETE CASCADE,
  group_id    integer REFERENCES groups_tbl(id) ON DELETE CASCADE,
  name        text NOT NULL,
  fee         integer NOT NULL DEFAULT 0,
  seq         integer NOT NULL DEFAULT 1,
  created_at  text DEFAULT to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
  CONSTRAINT fare_special_tolls_scope CHECK (
    (branch_id IS NOT NULL AND group_id IS NULL) OR (branch_id IS NULL AND group_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS fare_special_tolls_branch_idx ON fare_special_tolls(branch_id);
CREATE INDEX IF NOT EXISTS fare_special_tolls_group_idx ON fare_special_tolls(group_id);

-- ── 차종 마스터 ────────────────────────────────────────────────────────────
-- 수입차/대형·화물/전기차 할증은 "이 차가 어디에 해당하는가"를 알아야 붙는다. 접수 때마다
-- 사람이 고르게 하면 같은 차가 사람마다 다르게 분류되므로, 차종을 한 번 등록할 때 자동으로
-- 판정하고(lib/vehicleClass.js) 필요하면 손으로 고쳐 고정한다.
--
-- auto_* 는 자동 판정 결과를 그대로 남긴 것이다. 사람이 고친 값(is_*)과 갈리는 차종을 뽑아
-- 판정 사전을 개선하는 데 쓴다 — 안 남기면 사전이 틀렸는지 알 방법이 없다.
CREATE TABLE IF NOT EXISTS vehicle_models (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL,
  norm_name     text NOT NULL,
  is_imported   boolean NOT NULL DEFAULT false,
  is_large      boolean NOT NULL DEFAULT false,
  is_ev         boolean NOT NULL DEFAULT false,
  auto_imported boolean,
  auto_large    boolean,
  auto_ev       boolean,
  note          text,
  created_at    text DEFAULT to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at    text DEFAULT to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_models_norm_name_idx ON vehicle_models(norm_name);
