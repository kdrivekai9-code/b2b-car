-- 법인 공유 피드 — 같은 법인 소속 사용자들이 서로의 접수·취소·변경 요청을 볼 수 있게 한다
-- (실사용 요청: 카카오/웹톡이 "고객 1 : 상담원 다수" 구조라, 같은 법인 동료끼리는 서로의
-- 요청 흐름을 놓치기 쉽다). 법인별 옵트인이라 기본은 꺼져 있다 — 켠 법인만 기록이 쌓인다.
--
-- 대화 원문은 담지 않는다. 접수/취소/변경 시점에 이미 만들어지는 한 줄 요약(접수 확인 문구,
-- 오더 수정이력 note와 같은 문장)만 저장한다 — 잡담이 새지 않고, 저장량도 작다.
create table if not exists group_activity_feed (
  id integer generated always as identity primary key,
  group_id integer not null references groups_tbl(id) on delete cascade,
  order_id integer references orders(id) on delete set null,
  oid text,
  -- created: 신규 접수, cancelled: 취소, updated: 경로/일시/차량/요금/요청사항 변경.
  kind text not null check (kind in ('created', 'cancelled', 'updated')),
  summary text not null,
  actor_user_id integer references users(id) on delete set null,
  actor_label text,
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);
create index if not exists idx_group_activity_feed_group on group_activity_feed(group_id, id desc);

-- 법인별 옵트인 스위치. 관리자가 법인 관리 화면에서 켠다.
alter table groups_tbl add column if not exists share_activity_feed boolean not null default false;
