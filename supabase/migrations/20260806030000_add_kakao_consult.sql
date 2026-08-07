-- 카카오 상담톡(ConsulTalk 중계서버) 연동 — "카카오 상담톡 연동 계획서" 7절(DB 변경사항).
-- chat_sessions.user_id는 이미 nullable이라(로그인 없는 카카오 고객), 채널 식별자와 카카오 발신에
-- 재사용할 인증 키 3종만 추가하면 된다. 카카오 쪽은 상담 메시지를 3일만 보관하므로(계획서 4.4) 별도
-- kakao_consult_events 감사로그가 3일 이후 유일하게 남는 원본 수신 기록이다.
alter table chat_sessions
  add column if not exists channel text not null default 'web',
  add column if not exists external_user_key text,
  add column if not exists external_phone text,
  add column if not exists kakao_service_key text,
  add column if not exists kakao_user_key text,
  add column if not exists kakao_event_key text;

create index if not exists idx_chat_sessions_external_user_key
  on chat_sessions(external_user_key) where external_user_key is not null;

create table if not exists kakao_consult_events (
  id integer generated always as identity primary key,
  session_id integer references chat_sessions(id) on delete set null,
  event_type text not null,
  user_key text,
  service_key text,
  event_key text,
  payload_json text,
  handled boolean not null default false,
  error_message text,
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);
create index if not exists idx_kakao_consult_events_session on kakao_consult_events(session_id);
create index if not exists idx_kakao_consult_events_user_key on kakao_consult_events(user_key);
