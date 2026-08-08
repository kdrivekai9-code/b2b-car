-- 지사별 고객 통보 설정 — 어떤 상태 변화를, 언제, 어떤 문구로 알릴지.
--
-- 통보 자체는 20260809010000에서 시작했지만 문구와 시점이 코드에 박혀 있었다. 지사마다 안내
-- 문구도 다르고 "배차 통보를 몇 분 뒤에 보낼지"도 다르다(배차 직후 취소가 잦은 지사는 더 길게
-- 두고 싶어 한다). 지사관리 화면에서 고치도록 밖으로 뺀다.
--
-- 행이 없는 지사는 코드의 기본값으로 동작한다(lib/kakaoOrderNotify.js의 DEFAULT_EVENT_SETTINGS).
-- 그래야 지사를 새로 만들 때마다 설정을 넣어주지 않아도 통보가 나간다 — 옵트아웃 방식이다.
create table if not exists branch_customer_notifications (
  id integer generated always as identity primary key,
  branch_id integer not null references branches(id) on delete cascade,
  -- dispatched(배차완료) / completed(운행완료) / dispatch_cancelled(배차취소) / cancelled(오더취소)
  event_type text not null,
  enabled boolean not null default true,
  -- 상태 변화를 감지하고 이만큼 기다렸다가 보낸다. 0이면 곧바로.
  -- 배차완료를 기본 1분 미루는 이유는 배차 직후 취소가 있어서다 — 바로 보내면 "배차됐습니다"
  -- 다음에 곧장 "취소됐습니다"가 이어진다. 보내기 직전에 상태를 한 번 더 확인한다.
  delay_minutes integer not null default 0,
  -- 문구. {oid} {driver_name} {driver_phone} {origin} {destination} {reserved_at} 를 치환한다.
  message_template text not null,
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);

-- 한 지사에 같은 사건을 두 번 등록하지 못하게 한다(저장은 기존 행 갱신).
create unique index if not exists idx_branch_customer_notifications_event
  on branch_customer_notifications(branch_id, event_type);

alter table branch_customer_notifications enable row level security;
