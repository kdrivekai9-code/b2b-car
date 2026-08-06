-- 콜마너 쪽에서 실제 배정한 기사 정보(이름/사번/가상연락처) 저장 컬럼.
-- orders.assigned_driver_id(우리 자체 drivers 테이블 배정)와는 완전히 별개다 — 콜마너는
-- 자기 네트워크의 기사를 배차하며, 우리는 그 결과를 참고용으로만 보여준다.
--
-- callmaner_driver_name/sabun: OrderAllStatus 폴링 응답의 wk_name 필드("사번*이름" 형식)를
-- 분리해서 저장(routes/callmanerSync.js).
-- callmaner_driver_phone: 상태가 배차(status_code=02)로 바뀐 시점에 한 번, 별도 API인
-- 기사연락처조회(WkContactSearch)를 호출해 받아오는 기사 가상번호(wkVphone) — 문서상
-- "필수아님"이라 항상 오지는 않는다.
alter table orders add column if not exists callmaner_driver_name text;
alter table orders add column if not exists callmaner_driver_sabun text;
alter table orders add column if not exists callmaner_driver_phone text;
