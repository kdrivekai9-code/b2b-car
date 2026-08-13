-- 오더취소 능동 통보를 끈다(사용자 확정).
--
-- 왜: 콜마너의 '취소'를 그대로 믿을 수 없다는 것이 실측으로 확인됐다. 기사가 배차를 취소하면
-- 콜마너가 잠깐 '취소'를 준 뒤 1분쯤 뒤에 '접수'로 되돌려 재배차를 진행한다.
--   OID1237(conf_slip 179804643) 실측:
--     18:36:29 배차 → 18:41:29 취소 → 18:42:30 접수(재배차 대기)
-- 이 상태에서 취소 통보가 나가면, 멀쩡히 진행 중인 오더를 "취소되었습니다"라고 알리는
-- 오발신이 된다. 고객은 오지 않을 줄 알고 다른 수단을 찾는다.
--
-- 코드 기본값도 함께 껐다(lib/kakaoOrderNotify.js DEFAULT_EVENT_SETTINGS.cancelled.enabled).
-- 설정 화면에는 그대로 남겨둬서, 진짜 취소를 안내하고 싶은 지사는 직접 켤 수 있다.
--
-- 이미 저장된 지사 설정도 끈다 — 코드 기본값만 바꾸면 행이 있는 지사는 계속 켜진 채로 나간다.
update branch_customer_notifications
   set enabled = false,
       updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
 where event_type = 'cancelled';

-- 아직 안 나간 취소 통보 예약도 정리한다. 위 실측 사례처럼 이미 되살아난 오더의 취소 통보가
-- 크론이 되살아나는 순간 뒤늦게 나가면 안 된다.
update kakao_order_notifications
   set status = 'skipped',
       detail = '오더취소 통보가 꺼져 있습니다(콜마너 취소가 재배차 전 일시 상태일 수 있음).'
 where event_type = 'cancelled' and status = 'pending';
