-- 기타 정산 내역 — 운행요금과 별도로 청구하는 실비(주유비 · 주차요금 · 톨게이트).
--
-- 지금까지 이 금액을 담을 곳이 없었다. orders에는 fare_amount(계약 요금)와
-- ferry_fare_amount(도선료)뿐이라, 기사가 대신 낸 주유비·주차비·통행료는 메모에 적거나
-- 정산 담당자가 따로 표를 만들어 관리했다.
--
-- 왜 orders 컬럼이 아니라 별도 표인가: 한 오더에서 같은 항목이 여러 번 생긴다(톨게이트를
-- 두 번 지나고, 주차를 두 곳에서 한다). 컬럼 세 개로는 그 각각의 일자와 금액을 남길 수 없다.
create table if not exists order_extra_charges (
  id          bigserial primary key,
  order_id    bigint  not null references orders(id) on delete cascade,
  -- 값을 코드가 아니라 한글 그대로 둔다 — 화면·정산서에 그대로 나가는 이름이고, 항목이
  -- 늘어날 때 대응표를 같이 고쳐야 하는 일을 만들지 않는다. 허용값은 애플리케이션에서 막는다
  -- (lib/extraCharges.js EXTRA_CHARGE_TYPES).
  charge_type text    not null,
  amount      integer not null default 0,
  -- 발생 일자. orders.reserved_date와 같은 text('YYYY-MM-DD')다 — 이 저장소의 날짜 컬럼은
  -- 전부 KST 문자열이고, 여기만 date로 두면 조인·비교에서 타입이 갈린다.
  charged_on  text,
  -- 별도 청구할 것인지. 거래처에 청구하지 않고 지사가 부담하는 실비도 있어서(기사 과실
  -- 주차위반 등) 기록은 남기되 정산서에는 안 올린다.
  billable    boolean not null default true,
  note        text,
  created_by  bigint  references users(id),
  created_at  text    not null default to_char((now() at time zone 'Asia/Seoul'), 'YYYY-MM-DD HH24:MI:SS')
);

-- 정산 화면은 "이 법인의 이 달 오더들"로 먼저 좁힌 뒤 그 오더의 실비를 끌어온다.
create index if not exists idx_order_extra_charges_order
  on order_extra_charges(order_id);
