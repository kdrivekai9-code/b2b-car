-- 번호판 대조 — 접수한 차량번호와 운행시작 사진의 번호판이 같은지 확인한다.
--
-- 왜 필요한가: 접수 차량번호가 틀리면(고객 오기재, 다른 차가 나옴) 그대로 탁송이 진행되고
-- 정산·보험·사고 처리가 전부 어긋난다. 기사가 운행시작에 찍는 전면 사진에 번호판이 있으니
-- 그걸 읽어 대조하면 출발 직후에 잡을 수 있다.

-- ── 사진별 인식 결과 ───────────────────────────────────────────────────────
-- 계기판(odometer_km / ocr_status)과 같은 자리에 둔다. 폴링이 매분 도는데 사진마다 매번
-- 제미나이를 부르면 비용이 계속 쌓이므로, 한 번 읽은 사진은 상태를 보고 건너뛴다.
ALTER TABLE order_callmaner_photos ADD COLUMN IF NOT EXISTS plate_text text;
ALTER TABLE order_callmaner_photos ADD COLUMN IF NOT EXISTS plate_ocr_status text;

-- ── 오더별 대조 결과 ───────────────────────────────────────────────────────
-- match      : 접수 번호와 같다
-- mismatch   : 다르다 — 화면에 표시하고 관리자에게 알린다
-- unreadable : 못 읽었다(사진 없음·흐림·확신도 부족). **상이가 아니다** —
--              이걸 상이로 묶으면 헛알림이 쌓여 진짜 상이 건까지 무시하게 된다.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS plate_check_status text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS plate_recognized text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS plate_photo_url text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS plate_checked_at text;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_plate_check_status_chk;
ALTER TABLE orders ADD CONSTRAINT orders_plate_check_status_chk
  CHECK (plate_check_status IS NULL OR plate_check_status IN ('match', 'mismatch', 'unreadable'));

-- 상이 건만 뽑아 보는 화면이 있으므로 부분 인덱스로 충분하다.
CREATE INDEX IF NOT EXISTS orders_plate_mismatch_idx
  ON orders(plate_check_status) WHERE plate_check_status = 'mismatch';

-- ── 어느 사진이 전면인지 ───────────────────────────────────────────────────
-- 계기판이 13번째인 것처럼(odometer_photo_index) 전면 사진의 순번도 지사마다 다를 수 있다.
-- 기본 1 — 기사가 보통 전면부터 찍는다. 틀리면 지사 설정에서 바꾼다.
--
-- 한 장만 읽는 이유: 13장을 전부 읽으면 오더 한 건에 제미나이 호출이 13번이다. 번호판이
-- 안 찍힌 사진에서 억지로 읽어내는 것도 원치 않는다.
ALTER TABLE branches ADD COLUMN IF NOT EXISTS plate_photo_index integer DEFAULT 1;

-- 관리자별 수신 여부. 기본 1(받음) — 상이는 놓치면 안 되는 사건이다.
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS notify_plate_mismatch integer DEFAULT 1;
UPDATE push_subscriptions SET notify_plate_mismatch = 1 WHERE notify_plate_mismatch IS NULL;
