-- 정산서에서 할증을 어떻게 보여줄지 — 법인별 설정.
--
-- 할증(수입차·대형·전기차·야간·오지·장소)은 지금도 orders.fare_amount에 **이미 더해져**
-- 청구된다(lib/branchPolicy.js: fare += surcharge.total). 문제는 청구가 아니라 설명이다 —
-- 거래처가 "이 건은 왜 비싸냐"고 물으면 되짚을 자료가 없다. 계산 시점에 만들어진 내역이
-- 저장되지 않고 그대로 버려지기 때문이다.
--
-- 계약서 형태가 거래처마다 달라 표시 방식을 법인별로 고른다(사용자 지시).
--   included  운행요금 한 줄로 청구하고 내역만 괄호로 밝힌다 (지금 동작)
--   itemized  운행요금에서 할증을 떼어 별도 줄로 보여준다
--
-- **어느 쪽이든 총 청구액은 같다.** 모드는 표시 방식일 뿐이고, 저장된 금액(fare_amount)은
-- 하나다. 그래야 모드를 바꿔도 과거 정산서의 총액이 흔들리지 않는다.

-- 계산 시점의 할증 내역. JSON 배열: [{code,label,amount,reason}, ...]
--
-- 왜 오더에 박아두나: 요금설정은 나중에 바뀐다(할증 금액 조정, 차종 판정 수정). 정산 화면이
-- 매번 다시 계산하면 이미 청구를 끝낸 건의 근거까지 따라 바뀌어 "그때 왜 이 금액이었나"를
-- 되짚을 수 없다. car_type/fuel_type을 접수 시점 값으로 박아두는 것과 같은 이유다.
alter table orders add column if not exists fare_surcharges_json text;

-- 기본값은 included — 지금 동작 그대로다. 마이그레이션만으로 기존 거래처의 청구서 모양이
-- 바뀌면 안 된다(줄 구성이 바뀌면 문의가 온다).
alter table groups_tbl add column if not exists settlement_surcharge_mode text default 'included';
