-- 카카오 상담톡으로 나가는 오더 상태 통보 이력.
--
-- Phase 2의 첫 조각 — 고객이 "배차됐나요?"라고 묻기 전에 먼저 알린다. 지금 다루는 사건은 둘이다.
--   dispatched         — 기사 배차 완료
--   dispatch_cancelled — 배차받은 기사가 취소해 다시 배차를 찾는 중
--
-- 이 표가 필요한 이유는 "오발신 0건"이 완료 기준이기 때문이다. 상태 동기화 크론은 1분마다 돌고,
-- 같은 전이를 두 경로(OrderAllStatus 전체조회 / conf_slip 단건조회)에서 볼 수 있어서, 발신 사실을
-- 어딘가 남겨두지 않으면 같은 통보가 여러 번 나간다.
--
-- 배차 통보는 감지 즉시 보내지 않고 scheduled_at(감지 + 1분)까지 미룬다. 배차 직후 취소되는
-- 경우가 있어서, 바로 보내면 "배차됐습니다" 다음에 곧장 "취소됐습니다"가 이어진다. 1분을 기다린
-- 뒤에도 여전히 배차 상태일 때만 내보낸다.
create table if not exists kakao_order_notifications (
  id bigserial primary key,
  order_id bigint not null references orders(id) on delete cascade,
  chat_session_id bigint,
  event_type text not null,
  -- 같은 오더가 취소 후 다시 배차될 수 있다. 기사가 바뀌면 새 통보여야 하므로 기사 식별값을
  -- 중복 판정에 함께 넣는다 — 이것 없이 (order_id, event_type)만 잠그면 재배차 통보가 막힌다.
  dedupe_key text not null default '',
  scheduled_at timestamptz not null default now(),
  sent_at timestamptz,
  -- pending: 발송 대기 / sent: 발송됨 / skipped: 보낼 이유가 사라짐(1분 사이 취소 등) / failed: 발신 실패
  status text not null default 'pending',
  detail text,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_kakao_order_notifications_event
  on kakao_order_notifications(order_id, event_type, dedupe_key);

create index if not exists idx_kakao_order_notifications_pending
  on kakao_order_notifications(scheduled_at) where status = 'pending';

-- 전이를 어디까지 훑었는지 기억하는 커서.
--
-- 상태 변경 지점이 세 곳(콜마너 전체조회·단건조회·관리자 수동 변경)인데, 셋 다 이미
-- order_status_history에 남긴다. 그래서 그 세 곳에 통보 코드를 심는 대신 이력을 읽어 전이를
-- 찾는다 — 나중에 상태를 바꾸는 경로가 하나 더 생겨도 통보가 저절로 따라온다.
create table if not exists kakao_notification_cursor (
  id int primary key default 1,
  last_history_id bigint not null default 0,
  updated_at timestamptz not null default now(),
  constraint kakao_notification_cursor_single_row check (id = 1)
);

-- 0이 아니라 "지금 여기"에서 시작한다. 0으로 두면 첫 실행이 과거 이력을 통째로 훑어, 이미
-- 끝난 오더의 옛 배차까지 지금 와서 통보로 나간다.
insert into kakao_notification_cursor (id, last_history_id)
  values (1, coalesce((select max(id) from order_status_history), 0))
  on conflict (id) do nothing;
