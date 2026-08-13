-- 배차 통보 지연을 원래대로 1분으로 되돌린다(사용자 확정).
--
-- 무엇이 잘못됐나: 20260814010000이 "옛 기본값(1분)인 행만" 2분으로 올렸다. 관리자가 직접
-- 바꾼 값은 안 건드린다는 의도였는데, 서울지사가 마침 기본값 1분이라 대상이 됐다. 그 결과
-- 관리자가 화면에서 설정한 적 없는 값이 2분으로 조용히 바뀌어 있었다.
--
-- 지연은 관리자가 지사 설정 화면에서 정하는 값이다. 마이그레이션이 저장된 값을 덮어쓰면
-- "내가 설정한 적 없는데 왜 이 값이지"가 된다 — 코드 기본값도 1분으로 되돌렸다
-- (lib/kakaoOrderNotify.js DEFAULT_EVENT_SETTINGS.dispatched.delayMinutes).
--
-- 2분으로 바뀐 행만 되돌린다. 그 값이 될 수 있는 경로는 위 마이그레이션뿐이었다(직전
-- 기본값이 1분이었고, 사용자가 화면에서 2분으로 설정한 적이 없음을 확인했다).
-- 앞으로 2분이 필요하면 지사 설정 화면에서 직접 지정하면 되고, 그 값은 이후 어떤
-- 마이그레이션도 건드리지 않는다.
update branch_customer_notifications
   set delay_minutes = 1,
       updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
 where event_type = 'dispatched' and delay_minutes = 2;
