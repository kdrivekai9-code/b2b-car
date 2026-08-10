-- 상담원 상태로 붙잡힌 세션을 봇으로 되돌리기까지의 유휴 시간(지사별).
--
-- 고객이 상담원 연결을 한 번 요청하면 세션이 계속 needs_agent/agent_active로 남았다. 자동
-- 개입(routes/chat.js의 autoSendPendingSuggestions)은 "초안이 대기 중일 때"만 도는데, 고객이
-- 말을 멈추면 초안도 안 생기니 아무것도 세션을 되돌리지 않는다. 그러면 한참 뒤 고객이 다시
-- 말을 걸어도 봇이 답하지 않고 계속 사람을 기다린다.
--
-- 적정 시간은 지사마다 다르다 — 상담원이 상주하는 지사는 길게, 야간에 사람이 없는 지사는 짧게
-- 두고 싶어 한다. NULL이면 코드 기본값(30분)을 쓴다. 0으로 두면 자동 복귀를 하지 않는다
-- (상담원이 직접 종료할 때까지 붙잡아 두는 운영 방식).
alter table branches
  add column if not exists agent_idle_release_minutes integer;
