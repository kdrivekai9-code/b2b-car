-- 콜마너 연동 초기 시험 오더 10건 정리 (2026-09-04)
--
-- 마이그레이션이 아니라 **일회성 데이터 정리**라 supabase/manual/에 둔다.
-- 스키마를 바꾸지 않으므로 scripts/check-migrations.js가 보는 대상이 아니고,
-- 다른 환경에서 자동으로 다시 실행되면 안 된다(그 환경의 id 118~130은 다른 오더다).
--
-- 대상: OID1118 ~ OID1130. 2026-08-04 20:18 ~ 08-05 11:11 사이 약 15시간에 걸쳐 한 계정
-- (서울모터스 채정식)이 만든 건들이다. 출발지가 "탐앤탐스 사당역점"으로 반복되고 차량번호가
-- 48조9416 / 49조9416으로 한 자리만 다르다. 실패 사유가 순서대로 바뀌는 것(좌표 없음 →
-- providerId 설정 없음 → 지사캐시 부족)도 하나씩 고쳐가며 재시도한 흔적이다.
-- source_channel이 비어 있는데, 그 칸이 채워지기 시작한 것은 2026-08-08부터다.
--
-- 왜 정리하나: 오더 리스트의 "전송 실패" 표시가 **처리할 일이 있는 건만** 가리켜야 한다.
-- 손댈 필요 없는 10건이 매일 떠 있으면 눈에 익어 무시하게 되고, 그때부터 진짜 실패도 안 보인다.
-- 배지의 값어치는 "뜨면 반드시 볼 일이 있다"에서 나온다.
--
-- 안전: 대상 10건은 콜마너에 올라간 적이 없다(callmaner_conf_slip IS NULL). 취소해도 콜마너
-- 쪽에는 아무 영향이 없다. 아래 조건절이 그 사실을 매번 다시 확인하므로, 혹시 그 사이에
-- 등록된 건이 있으면 그 건만 조용히 빠진다.
--
-- 되돌리려면: order_status_history에 이전 상태가 남는다. 아래 문서 맨 아래 주석 참고.

BEGIN;

-- 되돌릴 수 있게 원래 상태를 먼저 기록한다.
INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note)
SELECT id, NULL, status, '취소',
       '콜마너 연동 초기 시험 오더 정리(2026-09-04). 전송 실패 표시가 실제 처리 대상만 가리키도록 정리.'
  FROM orders
 WHERE id IN (118, 119, 120, 121, 122, 123, 124, 125, 129, 130)
   AND callmaner_conf_slip IS NULL
   AND status NOT IN ('완료', '취소');

UPDATE orders SET status = '취소'
 WHERE id IN (118, 119, 120, 121, 122, 123, 124, 125, 129, 130)
   AND callmaner_conf_slip IS NULL
   AND status NOT IN ('완료', '취소');

COMMIT;

-- 확인: 아래가 0이면 끝난 것이다.
SELECT COUNT(*) AS "남은 전송 실패"
  FROM orders
 WHERE callmaner_conf_slip IS NULL
   AND callmaner_last_error IS NOT NULL
   AND status NOT IN ('완료', '취소');

-- 되돌리기(필요할 때만):
--   UPDATE orders o SET status = h.old_status
--     FROM order_status_history h
--    WHERE h.order_id = o.id
--      AND h.note LIKE '콜마너 연동 초기 시험 오더 정리(2026-09-04)%'
--      AND o.status = '취소';
