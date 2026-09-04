-- 팀 접수 현황 안내에서 관리자가 만든 항목 정리 (2026-09-04)
--
-- 마이그레이션이 아니라 일회성 데이터 정리라 supabase/manual/에 둔다.
--
-- 왜 생겼나: 이 피드는 "같은 법인 **동료가** 무엇을 요청했는지"를 나누는 자리인데, 작성자가
-- 그 법인 소속인지 확인하지 않았다. 그래서 관리자가 오더를 손보면 그 요약이 법인 피드에
-- 쌓이고, 고객에게 "시스템관리자님이 오더 내용을 변경했습니다"가 카카오톡으로 나갔다.
-- 고객은 자기가 부탁한 적 없는 변경을 통보받고 무슨 일인지 되묻게 된다.
--
-- 코드는 고쳤다(lib/groupActivityFeed.js isGroupMember). 이미 쌓인 항목은 화면에 그대로
-- 남아 있으므로 여기서 지운다 — 통보는 이미 나갔고 되돌릴 수 없지만, 화면에 계속 보이면
-- 볼 때마다 같은 질문이 반복된다.
--
-- 지우는 대상은 **작성자가 그 법인 소속 client가 아닌 항목**뿐이다. 실제 동료가 남긴 기록은
-- 건드리지 않는다.

BEGIN;

DELETE FROM group_activity_feed f
 USING users u
 WHERE u.id = f.actor_user_id
   AND (u.role <> 'client' OR u.group_id IS DISTINCT FROM f.group_id);

-- 작성자를 알 수 없는 항목(사람이 한 일이 아니거나 계정이 지워진 경우)도 같은 이유로 뺀다.
DELETE FROM group_activity_feed
 WHERE actor_user_id IS NULL;

COMMIT;

-- 확인: 아래가 0이면 끝난 것이다.
SELECT COUNT(*) AS "법인 소속이 아닌 작성자 항목"
  FROM group_activity_feed f
  LEFT JOIN users u ON u.id = f.actor_user_id
 WHERE u.id IS NULL OR u.role <> 'client' OR u.group_id IS DISTINCT FROM f.group_id;
