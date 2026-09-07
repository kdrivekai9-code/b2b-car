-- 진행 중으로 남아 있는 시험 오더 36건 정리 (2026-09-07)
--
-- 마이그레이션이 아니라 일회성 데이터 정리라 supabase/manual/에 둔다.
--
-- 왜 필요한가: 진행 중 오더 39건 중 36건이 시험 데이터다. 목록의 92%가 실제 일이 아니면
-- 화면을 봐도 지금 무엇이 진행 중인지 읽을 수 없다. 실제로 살아 있는 건은 3건뿐이다
-- (2026-09-07 / 08-24 / 08-06 — 전부 좌표가 있고 콜마너로 전송됐다).
--
-- 36건의 공통점: 좌표가 없고(origin_lat 또는 destination_lat), 콜마너로 한 번도 안 갔고
-- (callmaner_synced_at IS NULL), 2026-08-31 이전에 만들어졌다. 좌표가 없으면 콜마너
-- 오더접수가 애초에 불가능하므로 이 건들은 배차될 수 없는 상태로 목록만 채우고 있었다.
--
-- 지우지 않고 '취소'로 바꾼다. order_status_history에 원래 상태를 먼저 남겨 되돌릴 수 있게
-- 하고, 정산·통계에서 사라지지 않게 한다. 2026-09-04 정리(20260904-cancel-test-orders.sql)와
-- 같은 방식이다.
--
-- id를 나열하지만 조건을 UPDATE에도 다시 붙인다. 사이에 데이터가 바뀌었으면(누군가 그 오더를
-- 되살려 주소를 확정했거나 콜마너로 보냈으면) 건드리지 않고 지나간다 — id만 믿으면 그 사이의
-- 변화를 덮어쓴다.

BEGIN;

-- ── A. 검사 스크립트가 남긴 잔해 25건 ──────────────────────────────────────
-- 주소가 전부 '서울 강남구 검사로 1', 요금이 전부 100,000원, 접수자(created_by)가 없다.
-- 사람이 만들 수 있는 모양이 아니다.
--
-- 오더를 만드는 검사 13개는 모두 끝에 DELETE를 갖고 있다. 그런데도 남은 것은 스크립트가
-- 중간에 죽어 정리 코드에 못 닿았기 때문이다(2026-08-29~30, 동기화 순환 사고 기간).
-- 근본 해결은 검사가 죽어도 쓸려나가게 하는 것이지 이 정리가 아니다 — 아래 주석 참고.
CREATE TEMP TABLE _stale_a (id integer) ON COMMIT DROP;
INSERT INTO _stale_a (id) VALUES
  (701),(702),(703),(704),(719),(720),(746),(747),(761),(762),
  (831),(832),(856),(857),(900),(901),(902),(920),(921),(929),
  (930),(941),(942),(961),(962);

-- ── B. 초기 시험 오더 11건 ─────────────────────────────────────────────────
-- 데모 고객 계정(seoulmotors), 자동화 계정(qa_test_client), 관리자 계정으로
-- 2026-07-21 ~ 08-03에 만든 건들이다. 주소는 실제 주소 모양이지만 좌표를 확정한 적이 없고
-- 콜마너로 보낸 적도 없다 — 화면을 만들면서 눌러본 흔적이다.
--
-- seoulmotors는 지금도 쓰는 계정이라(가장 최근 접수 2026-09-07) 계정을 건드리지 않는다.
-- 그 계정의 최근 오더도 좌표가 있어 아래 조건에 걸리지 않는다.
CREATE TEMP TABLE _stale_b (id integer) ON COMMIT DROP;
INSERT INTO _stale_b (id) VALUES (1),(16),(21),(70),(71),(72),(73),(74),(75),(81),(116);

-- ── 되돌릴 수 있게 원래 상태를 먼저 기록한다 ───────────────────────────────
INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note)
SELECT o.id, NULL, o.status, '취소',
       '진행 중으로 남은 시험 오더 정리(2026-09-07). 좌표 없음 + 콜마너 미전송 + 2026-08-31 이전 접수.'
  FROM orders o
 WHERE o.id IN (SELECT id FROM _stale_a UNION ALL SELECT id FROM _stale_b)
   AND o.status NOT IN ('완료', '취소')
   AND o.callmaner_synced_at IS NULL
   AND o.callmaner_conf_slip IS NULL
   AND (o.origin_lat IS NULL OR o.destination_lat IS NULL)
   AND o.created_at < '2026-08-31';

UPDATE orders o SET status = '취소'
 WHERE o.id IN (SELECT id FROM _stale_a UNION ALL SELECT id FROM _stale_b)
   AND o.status NOT IN ('완료', '취소')
   AND o.callmaner_synced_at IS NULL
   AND o.callmaner_conf_slip IS NULL
   AND (o.origin_lat IS NULL OR o.destination_lat IS NULL)
   AND o.created_at < '2026-08-31';

COMMIT;

-- ── 확인 ───────────────────────────────────────────────────────────────────
-- 36이 나와야 한다(위 조건에 안 걸려 지나간 건이 있으면 그만큼 적다).
SELECT COUNT(*) AS "정리된 건"
  FROM order_status_history
 WHERE note LIKE '진행 중으로 남은 시험 오더 정리(2026-09-07)%';

-- 3이 나와야 한다. 실제로 살아 있는 오더만 남는다.
SELECT id, oid, status, substr(created_at, 1, 10) AS 접수일
  FROM orders
 WHERE status NOT IN ('완료', '취소')
 ORDER BY id;

-- 되돌리기(필요할 때만):
--   UPDATE orders o SET status = h.old_status
--     FROM order_status_history h
--    WHERE h.order_id = o.id
--      AND h.note LIKE '진행 중으로 남은 시험 오더 정리(2026-09-07)%'
--      AND o.status = '취소';
