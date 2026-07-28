-- AI 챗봇 세션 복원 시 대화 내용뿐 아니라 오더접수 진행 상태(입력된 필드 값/현재 phase 등)까지
-- 이어갈 수 있도록, 매 턴마다 클라이언트가 보내는 진행 상태 스냅샷을 저장한다.
alter table chat_sessions
  add column if not exists draft_json text;
