-- 마지막으로 확인된 기사 좌표.
--
-- 왜 필요한가(실측 2026-09-09, OID2211): 콜마너 TrackingDriver가 배차 단계에서는 좌표를
-- 주다가 운행시작 뒤에는 rc=00(정상처리)로 응답하면서 lat/lng를 **빈 문자열**로 준다.
-- 파라미터 문제가 아니다 — userHp를 지사대표·출발지연락처·기사번호로 바꿔 세 번 다 같았다.
-- 그래서 화면에서 위치가 통째로 사라지고 "신호가 아직 잡히지 않았습니다"만 남았다.
--
-- 좌표는 지금까지 인메모리에만 있었다(lib/driverLocation.js 30초 캐시). 서버리스라
-- 인스턴스마다 따로 쌓이고 재시작에 사라져서, 신호가 끊기면 마지막 위치도 같이 잃었다.
--
-- 시각은 이 저장소 관례대로 KST 문자열이다(orders.callmaner_status_at과 같은 방식).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_last_lat numeric;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_last_lon numeric;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_last_fix_at text;
