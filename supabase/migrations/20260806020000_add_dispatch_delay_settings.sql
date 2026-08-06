-- 배차지연 알림 설정 — 관리자(지사관리)에서 고객사별로 등록한다.
--
-- 챗봇이 "배차가 지연되고 있으니 요금을 올릴까요?"라고 먼저 제안하는 기능의 적용 대상과 기준을
-- 고객사 단위로 정한다. 여기에 등록되지 않은 고객사에는 챗봇이 먼저 제안하지 않는다(옵트인) —
-- 지연 여부 자체는 주문 조회 응답에 계속 표시되지만, 선제 안내는 등록된 곳에만 나간다.
--
-- call_types: 이 고객사의 어떤 콜 유형에만 적용할지(중복 선택). 쉼표로 이어 저장한다.
--   corporate_call(법인콜) → orders.order_type = 'premium'
--   daily_driver(일일기사) → orders.order_type = 'daily_driver'
--   dispatch(탁송)        → orders.order_type = 'dispatch'
create table if not exists dispatch_delay_settings (
  id integer generated always as identity primary key,
  branch_id integer not null references branches(id) on delete cascade,
  group_id integer not null references groups_tbl(id) on delete cascade,
  call_types text not null default 'corporate_call',
  delay_minutes integer not null default 5,      -- 접수 후 N분 미배차면 지연으로 본다
  raise_amount integer not null default 5000,    -- 제안할 요금 상향 금액(1,000원 단위)
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);
-- 같은 고객사를 두 번 등록하지 못하게 한다(수정은 기존 행을 갱신).
create unique index if not exists idx_dispatch_delay_settings_branch_group
  on dispatch_delay_settings(branch_id, group_id);
alter table dispatch_delay_settings enable row level security;
