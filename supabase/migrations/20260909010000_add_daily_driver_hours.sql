-- 일일기사 이용 시간 — **청구 근거다.**
--
-- 왜 필요한가: 일일기사 요금은 이용 시간 기준인데(기준 5시간 90,000원 + 초과 시간당 15,000원,
-- premium_fare_rules / group_daily_driver_fare_rules) 오더 등록 화면에 시간을 받는 칸이 없었다.
-- 그래서 오더구분을 '일일기사'로 골라도 요금은 **탁송 거리 구간표로** 계산됐다
-- (/orders/fare-preview가 그 상품을 몰랐다).
--
-- 이미 있는 reservation_hours_bracket으로는 청구할 수 없다. 그건 within_4h / within_8h /
-- over_8h 세 구간뿐이고, 프리미엄 → 일일기사 자동 승격 판정에만 쓴다
-- (lib/premiumUpgrade.js: over_8h면 승격). over_8h를 "10시간"으로 환산해 청구하면 그 숫자는
-- 우리가 지어낸 것이다 — 12시간을 쓴 고객도 10시간으로 청구된다.
--
-- 그래서 실제 시간을 따로 받는다. numeric인 이유는 5.5시간(5시간 30분)이 실제로 들어오기
-- 때문이다 — 챗봇 요금 문의도 같은 단위를 쓴다(lib/agentAssist.js parseUseHours).
--
-- 값이 없으면(탁송·프리미엄대리, 또는 시간을 안 받은 옛 오더) null이다. 요금 계산은 그때
-- { enabled:false }로 떨어져 수동 입력이 된다 — 없는 시간을 기본값으로 채우지 않는다.

alter table orders add column if not exists daily_driver_hours numeric;

comment on column orders.daily_driver_hours is
  '일일기사 이용 시간(시간 단위, 소수 가능). 요금 계산의 입력값. reservation_hours_bracket(구간)과 다른 값이다.';
