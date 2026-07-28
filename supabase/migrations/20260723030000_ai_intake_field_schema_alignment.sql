-- "탁송접수 AI 자동입력 설계" 문서(TransportOrderData)와 스키마를 맞춘다.
-- 상세주소(층수/주차 위치 등)는 지금까지 출발지/도착지 주소에 합쳐진 뒤 버려졌는데,
-- 별도 컬럼으로 보존해서 이후(챗봇 등)에서도 구조화된 채로 참조할 수 있게 한다.
alter table orders add column if not exists origin_address_detail text;
alter table orders add column if not exists destination_address_detail text;

-- 요금 안내 문구를 이미 1회 노출했는지 — 다회차 대화형 접수(향후 LLM 연동)에서 중복 안내 방지용.
alter table orders add column if not exists fare_announced boolean not null default false;

-- 경유지도 출발지/도착지와 동일하게 상세주소를 별도 보존한다 (문서에는 없지만 동일한 이유로 일관성 있게 추가).
alter table order_waypoints add column if not exists address_detail text;
