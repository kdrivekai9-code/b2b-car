-- 상담 메시지 읽음 상태(고객/상담원)를 저장한다.
-- sender='user' 메시지는 read_by_agent_at, sender='agent' 메시지는 read_by_user_at를 사용한다.
alter table chat_messages
  add column if not exists read_by_user_at text,
  add column if not exists read_by_agent_at text;
