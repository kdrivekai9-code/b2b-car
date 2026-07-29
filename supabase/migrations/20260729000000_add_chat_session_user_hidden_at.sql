-- 사용자가 최근 항목에서만 세션을 숨길 수 있도록 저장한다.
alter table chat_sessions
  add column if not exists user_hidden_at text;
