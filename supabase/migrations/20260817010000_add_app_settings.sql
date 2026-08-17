-- 화면에서 바꿀 수 있는 전역 설정 저장소.
--
-- 왜: 지금까지 전역 설정은 전부 환경변수였다(ACCESS_LOG_RETENTION_MONTHS 등). 환경변수는
-- 배포해야 바뀌고 관리자가 직접 손댈 수 없다. AI 사용량 제한처럼 "운영하면서 조정하는 값"은
-- 화면에서 바꿀 수 있어야 한다(사용자 요청).
--
-- 지사·법인별로 갈리는 설정은 각자 테이블이 따로 있다(branch_*, group_*). 여기 두는 것은
-- 시스템 전체에 하나뿐인 값이다.
create table if not exists app_settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now(),
  updated_by bigint
);
