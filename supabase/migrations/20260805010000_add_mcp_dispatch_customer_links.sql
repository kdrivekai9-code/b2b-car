-- 챗봇의 콜마너 MCP 연동(배차 주문 조회/등록/수정/취소)에 필요한 권한/감사 테이블.
--
-- 권한 모델(사용자 확정 사항):
--  1) "등록된 고객" = 로그인한 b2b-car 사용자 본인. 본인 연락처(users.phone)가 MCP의 cid가 된다.
--     챗봇은 이 cid에 매인 주문만 조회/등록/취소/응답할 수 있다.
--  2) 등록된 고객이 "실제 이용한 고객"(제3자 — 예: 임직원/현장 담당자)의 전화번호로 주문을 접수하면,
--     그 번호를 아래 mcp_customer_links에 남긴다. 그 후로는 그 실제이용고객의 주문건도
--     같은 등록고객이 조회/수정/취소할 수 있다(등록 시점에 자동으로 링크가 생긴다).
-- 이 테이블에 없는 cid는 어떤 경로로도(LLM이 임의의 번호를 뱉어도) MCP 호출에 실려나가지 않는다.
create table if not exists mcp_customer_links (
  id integer generated always as identity primary key,
  owner_user_id integer not null references users(id) on delete cascade,
  cid text not null,                -- 실제이용고객 연락처(숫자만 정규화해서 저장)
  display_name text,                -- 실제이용고객 이름(알고 있을 때만)
  source text not null default 'chatbot_order',
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
  revoked_at text
);
create unique index if not exists idx_mcp_customer_links_owner_cid on mcp_customer_links(owner_user_id, cid);
alter table mcp_customer_links enable row level security;

-- MCP 도구 호출 감사 로그 — 특히 주문 등록/수정/취소는 되돌리기 어려운 외부 행위라
-- "누가, 어느 상담 세션에서, 어떤 인자로" 호출했는지 남겨야 사후 확인이 가능하다.
create table if not exists mcp_tool_calls (
  id integer generated always as identity primary key,
  user_id integer references users(id) on delete set null,
  session_id integer,
  tool_name text not null,
  arguments_json text,
  ok boolean,
  error text,
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);
create index if not exists idx_mcp_tool_calls_user_created on mcp_tool_calls(user_id, created_at desc);
alter table mcp_tool_calls enable row level security;

-- 주문 등록/수정/취소처럼 되돌리기 어려운 도구는 "확인 후 실행" 2단계로 동작한다. 그 확인 대기
-- 상태를 서버가 들고 있어야(LLM 판단에 맡기지 않아야) 모델이 스스로 confirmed=true를 만들어
-- 사용자 동의 없이 실행하는 일을 막을 수 있다. draft_json은 오더접수 FSM 전용이라 별도 컬럼을 쓴다.
alter table chat_sessions add column if not exists mcp_pending_json text;

-- 지사별 MCP 대표번호(repNo). 콜마너 providerId(B100-12345-AP12345)의 가운데 값이 대표번호라
-- 그걸로 유도할 수도 있지만, 지사마다 AI 인입번호/대표번호 운영이 다를 수 있어 별도 컬럼을 둔다
-- (비어 있으면 lib/mcpDispatchAccess.js가 providerId에서 유도 → 그다음 환경변수 기본값으로 폴백).
alter table branches add column if not exists mcp_rep_no text;
