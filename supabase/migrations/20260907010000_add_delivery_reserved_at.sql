-- 도착지 인도시간 기준으로 접수한 건의 "원래 요청 시각".
--
-- 왜 필요한가: 지금 orders.reserved_date/time에는 **픽업 시각**이 들어간다. 고객이 "18시 30분
-- 도착"으로 접수해도, 콜마너는 예약시각을 출발 기준으로 받기 때문에 경로 소요시간을 역산한
-- 픽업 시각(예: 16시 20분)으로 바꿔서 저장하고 그 값을 콜마너로 보낸다
-- (routes/orders.js의 pickup_reserved_date || reserved_date).
--
-- 그 순간 고객이 말한 "18시 30분 도착"은 어디에도 남지 않는다. 오더 상세를 열면 16시 20분만
-- 보이고, 수정 화면은 기준 라디오가 '출발지 픽업'으로 되돌아간다(order.reservation_basis를
-- 읽는데 그런 칸이 없어서 늘 undefined였다). 고객이 다시 물으면 대조할 근거가 없다.
--
-- 유일한 흔적이 기사메모에 붙는 한 줄이었는데(public/js/order-form.js), 그건 자유 입력칸이라
-- 누가 지우면 사라지고 콜마너 적요1(100Byte)에서는 잘릴 수도 있다. 근거로 삼을 값이 아니다.
--
-- 기준(reservation_basis) 칸을 따로 두지 않는 이유: 이 값이 있으면 곧 "도착지 인도시간 기준"
-- 이라는 뜻이라 파생이 가능하다. 같은 사실을 두 칸에 담으면 둘이 어긋나는 날이 온다.
alter table orders add column if not exists delivery_reserved_date text;
alter table orders add column if not exists delivery_reserved_time text;
