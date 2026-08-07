-- 외부 연동 오류 통합 로그.
--
-- 지금까지 연동 실패는 세 갈래로 흩어져 있었다.
--   1) 콜마너 오더접수 실패 → orders.callmaner_last_error (화면에 배지로도 보임)
--   2) MCP 도구 호출 실패   → mcp_tool_calls.ok = false
--   3) 카카오 수신 이벤트    → kakao_consult_events.handled = false
-- 문제는 이 셋 어디에도 안 남는 실패가 있다는 것이다 — 콜마너 상태동기화 크론 실패, 카카오
-- 발신 실패(고객에게 답장이 안 갔는데 대화창에는 남아 정상처럼 보인다), 지오코딩 실패 등은
-- console.error로만 남아 Vercel 함수 로그를 뒤져야 했고 보존기간도 짧다.
--
-- 이 테이블은 "어디서 무엇이 왜 실패했는가"를 한 곳에 모으는 용도다. 기존 세 갈래를 대체하지
-- 않고 보완한다(각자 고유한 컬럼/화면 연동이 있으므로).
create table if not exists integration_errors (
  id integer generated always as identity primary key,
  source text not null,              -- callmaner | mcp | kakao | geocode
  operation text not null,           -- 예: sync, send, order_receipt, tool_call
  ref_type text,                     -- order | chat_session | branch
  ref_id integer,
  error_code text,
  message text not null,
  context_json text,
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);
create index if not exists idx_integration_errors_created on integration_errors(created_at desc);
create index if not exists idx_integration_errors_source on integration_errors(source, created_at desc);
alter table integration_errors enable row level security;
