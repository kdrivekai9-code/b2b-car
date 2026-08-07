-- 상담원 도우미(답변 채택 대기) — 상담원이 응대 중(agent_active)인 세션에서도 봇이 고객
-- 메시지를 계속 분석해 답변 초안을 만들어 두고, 상담원이 승인해야 실제로 나가는 구조.
--
-- 지금까지는 상담원이 붙는 순간(routes/chat.js, routes/kakaoConsult.js의 status ==='agent_active'
-- 분기) 봇을 통째로 껐다. 그래서 접수 폼 파서(실사용 재생 98.2%)·FAQ 검색·배차 도우미가
-- 정작 사람이 수작업을 가장 많이 하는 구간에서 놀고 있었다.
--
-- 핵심 안전 규칙: 제안은 chat_messages에 넣지 않는다. 거기 넣으면 실시간 브로드캐스트를 타고
-- 고객 위젯/카카오로 그대로 새어나간다. 승인된 제안만 chat_messages에 'agent'로 기록된다.
create table if not exists chat_suggestions (
  id integer generated always as identity primary key,
  session_id integer not null references chat_sessions(id) on delete cascade,
  -- 어떤 고객 메시지에 대한 제안인지 — 화면에서 그 말풍선 바로 아래에 붙여 보여준다.
  user_message_id integer references chat_messages(id) on delete set null,
  -- intake(접수 폼 파싱) | faq(지식베이스) — 종류에 따라 상담원이 신뢰도를 다르게 본다.
  kind text not null,
  suggested_text text not null,
  -- 접수 폼에서 뽑은 슬롯(우측 접수장 프리필용). intake일 때만 채워진다.
  intake_json text,
  -- pending | approved | dismissed. 승인 시 상담원이 고친 최종 문구는 sent_text에 남겨,
  -- "봇 초안을 얼마나 고쳐 쓰는가"로 제안 품질을 측정할 수 있게 한다(자동 발송 승격 근거).
  status text not null default 'pending',
  sent_text text,
  decided_by integer references users(id) on delete set null,
  decided_at text,
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);
create index if not exists idx_chat_suggestions_session on chat_suggestions(session_id, status);

alter table chat_suggestions enable row level security;
