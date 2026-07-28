-- 상담원 온라인 여부(Supabase Realtime Presence) 판단용 캐시 테이블.
-- 관리자가 상담 관리 화면(세션 목록/상세)을 열어두는 동안 SSE 연결이 유지되고,
-- 그 연결이 Presence 채널(chat-agents-presence)에 track()한 상태를 이 테이블에 함께 반영한다.
-- 서버리스 환경에서는 요청마다 프로세스가 다를 수 있어, "지금 누가 접속해 있나"를
-- 매번 새로 Presence를 구독해서 확인하는 대신 이 테이블을 빠르게 조회하는 방식을 쓴다.
-- last_seen_at은 연결이 열려있는 동안 주기적으로 갱신되며, 비정상 종료로 행이 남아도
-- 일정 시간 후에는 조회 조건(last_seen_at 기준)에서 자연히 제외되어 "오프라인"으로 처리된다.
create table if not exists chat_agent_presence (
  id uuid primary key default gen_random_uuid(),
  user_id integer not null references users(id) on delete cascade,
  connected_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists idx_chat_agent_presence_last_seen on chat_agent_presence(last_seen_at);

-- 이 앱은 Supabase Auth를 쓰지 않고 자체 세션 인증을 쓰므로 auth.uid() 기반 정책은 의미가 없다.
-- RLS를 켜고 별도 정책을 추가하지 않아 anon/authenticated 롤의 PostgREST 직접 접근을 완전히 차단한다.
-- 서버는 DATABASE_URL(RLS 미적용 풀링 롤)로, Realtime(Broadcast/Presence)은 서비스 롤 키로
-- 각각 서버에서만 연결하므로 정상 동작에는 영향이 없다.
alter table chat_sessions enable row level security;
alter table chat_messages enable row level security;
alter table chat_agent_presence enable row level security;
