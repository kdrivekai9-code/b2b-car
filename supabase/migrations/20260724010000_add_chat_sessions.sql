-- 하이브리드 챗봇: 상담원 개입/모니터링을 위한 대화 세션 영속화.
-- status: bot(봇 응대중) | needs_agent(상담원 호출됨) | agent_active(상담원 응대중) | closed(종료)
create table if not exists chat_sessions (
  id integer generated always as identity primary key,
  user_id integer references users(id),
  status text not null default 'bot',
  assigned_agent_id integer references users(id),
  requested_feature text,
  user_hidden_at text,
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);

-- sender: user | bot | agent
create table if not exists chat_messages (
  id integer generated always as identity primary key,
  session_id integer not null references chat_sessions(id) on delete cascade,
  sender text not null,
  message text not null,
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);
create index if not exists idx_chat_messages_session on chat_messages(session_id);

-- 상담원 호출 알림 opt-in (기본 on)
alter table push_subscriptions add column if not exists notify_agent_call integer not null default 1;
