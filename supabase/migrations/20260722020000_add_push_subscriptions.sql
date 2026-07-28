-- 브라우저 푸시 알림 구독 (기획서 5.6절). 콜패스/채팅 알림은 해당 기능 자체가 없어 이벤트에서 제외.

create table if not exists push_subscriptions (
  id integer generated always as identity primary key,
  user_id integer not null references users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  branch_id integer references branches(id), -- null = 전체 지사 구독
  notify_order_events integer not null default 1,
  notify_driver_assign integer not null default 1,
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);
create index if not exists idx_push_subscriptions_user_id on push_subscriptions(user_id);

alter table push_subscriptions enable row level security;
