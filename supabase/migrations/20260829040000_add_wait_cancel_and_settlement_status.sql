-- 대기요금 · 취소요금 저장, 부대비용 정산 방식 3단계, 정산완료 상태.
--
-- 셋 다 정산과 직결된다. 한 마이그레이션에 묶은 이유는 셋이 같은 화면(정산내역)에서 함께
-- 쓰이기 때문이다 — 따로 배포하면 화면이 반쪽 상태로 도는 구간이 생긴다.

-- ── 대기요금 · 취소요금 ─────────────────────────────────────────────────────
-- 설정(group_fare_extra_settings.wait_fee / cancel_before_fee / cancel_after_fee)은 이미
-- 있었는데 **계산도 저장도 없었다.** 설정한 사람은 청구되는 줄 알지만 한 푼도 안 나갔다.
--
-- fare_amount에 합치지 않고 따로 둔다. 정산서에서 구간요금·할증과 나란히 보여야 하고
-- (사용자 지시), 합쳐두면 어느 것이 얼마인지 되짚을 수 없다.
alter table orders add column if not exists wait_fee_amount integer;
alter table orders add column if not exists cancel_fee_amount integer;
-- 왜 그 금액인지 — "대기 32분(기준 15분 초과)", "배차 후 취소" 같은 근거를 남긴다.
-- 금액만 남기면 거래처 문의에 답할 수 없다.
alter table orders add column if not exists wait_fee_note text;
alter table orders add column if not exists cancel_fee_note text;

-- ── 부대비용 정산 방식 3단계 ────────────────────────────────────────────────
-- 기존 *_included(0/1)를 셋으로 늘린다.
--   included    기본요금 포함 — 따로 청구하지 않는다
--   monthly     제외 · 실비 월정산 — 월 정산서에 모아 청구
--   individual  제외 · 실비 개별정산 — 건별로 따로 청구
--
-- 기존 컬럼을 그대로 두고 새 컬럼을 더한다. 값을 옮기는 마이그레이션은 되돌리기 어렵고,
-- 새 컬럼이 비면 기존 0/1에서 읽어 예전과 똑같이 돈다(lib/fareSurcharge.js extraCostMode).
alter table group_fare_extra_settings add column if not exists toll_normal_mode text;
alter table group_fare_extra_settings add column if not exists toll_special_mode text;
alter table group_fare_extra_settings add column if not exists parking_mode text;
alter table group_fare_extra_settings add column if not exists fuel_mode text;
alter table group_fare_extra_settings add column if not exists wash_mode text;
alter table group_fare_extra_settings add column if not exists ferry_mode text;

alter table fare_extra_settings add column if not exists toll_normal_mode text;
alter table fare_extra_settings add column if not exists toll_special_mode text;
alter table fare_extra_settings add column if not exists parking_mode text;
alter table fare_extra_settings add column if not exists fuel_mode text;
alter table fare_extra_settings add column if not exists wash_mode text;
alter table fare_extra_settings add column if not exists ferry_mode text;

-- ── 정산완료 상태 ───────────────────────────────────────────────────────────
-- 사용자 확정: "정산완료"와 "결재완료"는 같은 것이다. 상태는 하나만 둔다 — 둘로 나누면
-- 어느 것이 입금 기준인지 매번 물어야 한다.
--
-- 완료 시각과 처리한 계정을 함께 남긴다. 시각만 남기면 "누가 확정했나"를 못 찾고, 입금
-- 대사에서 문제가 생겼을 때 되짚을 수 없다.
alter table orders add column if not exists settled_at text;
alter table orders add column if not exists settled_by bigint references users(id);

-- 기타 정산은 항목마다 따로 확정한다 — 주유비는 영수증이 왔는데 주차비는 아직인 경우가 흔하다.
alter table order_extra_charges add column if not exists settled_at text;
alter table order_extra_charges add column if not exists settled_by bigint references users(id);
-- 이 줄을 월정산으로 청구할지 개별정산으로 청구할지. 설정에서 정해지지만, 청구한 뒤 설정이
-- 바뀌어도 이미 청구한 건의 구분이 따라 바뀌면 안 되므로 줄에 박아둔다.
alter table order_extra_charges add column if not exists settle_mode text;

create index if not exists orders_settled_idx on orders(requester_group_id, settled_at);
