-- 운행시작 상태 + 탁송사진(콜마너 ConsPicture) + 계기판 주행거리 + 통보 확장.
--
-- 컬럼/테이블만 늘린다. branch_customer_notifications에 'started' 기본 설정 행은 만들지
-- 않는다 — 행이 없는 지사는 코드 기본값으로 동작하는 옵트아웃 구조라
-- (lib/kakaoOrderNotify.js DEFAULT_EVENT_SETTINGS), 여기서 지사마다 행을 심으면 나중에
-- 기본 문구를 고쳐도 옛 문구가 DB에 굳어 남는다.

-- ---------------- 1) 운행시작 상태를 지사별 상태설정에 채워준다 ----------------
-- order_status_config에 이미 행이 있는 지사는 새 상태가 빠져 있어서 오더상세 상태
-- 드롭다운에 '운행시작'이 안 뜬다(lib/branchPolicy.js getEffectiveStatuses는 행이
-- 하나라도 있으면 그 목록만 쓴다). 기사배정 바로 뒤 순서로 끼워 넣는다.
insert into order_status_config (branch_id, status_code, is_customer_visible, is_backoffice_only, sort_order)
select c.branch_id, '운행시작', 1, 0,
       (select coalesce(max(sort_order), 0) from order_status_config x
         where x.branch_id = c.branch_id and x.status_code = '기사배정')
  from (select distinct branch_id from order_status_config) c
 where not exists (
   select 1 from order_status_config y
    where y.branch_id = c.branch_id and y.status_code = '운행시작'
 );

-- ---------------- 2) 사건별 사진 첨부 스위치 ----------------
-- 문구 토큰이 아니라 스위치다(사진은 텍스트가 아니고, 카카오는 이미지가 본문과 별도
-- 섹션이라 "문구 중간"이라는 위치를 지킬 수 없다). 실제 발송은 지사 사진설정
-- (branch_photo_settings.client_can_view)도 함께 켜져 있어야 한다.
alter table branch_customer_notifications
  add column if not exists attach_photos boolean not null default false;

-- (여기에 배차 지연을 1분 → 2분으로 올리는 UPDATE가 있었으나 되돌렸다 —
--  20260814030000_restore_dispatch_delay_default.sql 참고. 지연은 관리자가 화면에서 정하는
--  값이라 마이그레이션이 저장된 값을 덮어쓰면 안 된다.)

-- ---------------- 3) 통보 큐 — 채널과 미룬 횟수 ----------------
-- channel: 어느 채널로 나갔는지(kakao/web) 사후 추적용.
-- defer_count: 고객이 접수 대화 중이면 끼어들지 않고 미루는데, 무한히 미루면 통보가
--   영영 안 나가므로 횟수를 센다(lib/kakaoOrderNotify.js MAX_DEFERS).
alter table kakao_order_notifications
  add column if not exists channel text,
  add column if not exists defer_count integer not null default 0;

-- ---------------- 4) 웹챗 첨부(사진 썸네일+링크) ----------------
-- 카카오는 이미지 메시지로 나가므로 이 컬럼을 쓰지 않는다.
-- [{ "url": "...", "caption": "..." }] 형태의 JSON 문자열.
alter table chat_messages
  add column if not exists attachments_json text;

-- ---------------- 5) 계기판 주행거리 ----------------
-- 콜마너 탁송사진 중 계기판 사진을 제미나이로 읽은 결과를 오더에 못박아 둔다.
-- 통보 발송 경로가 매분 돌면서 orders 한 행만 읽으면 되도록 비정규화했다.
-- NULL은 "아직 못 읽었다"는 뜻이고, 그 자리는 통보 문구에서 통째로 사라진다.
alter table orders
  add column if not exists odometer_start integer,
  add column if not exists odometer_end integer,
  add column if not exists distance_total integer;

-- 계기판이 몇 번째 사진인지 — 현재 관측값은 13번째지만 콜마너가 순서를 바꿀 수 있어
-- 지사별로 조정할 수 있게 둔다(1-based). 0 이하면 주행거리 계산을 건너뛴다.
alter table branches
  add column if not exists odometer_photo_index integer not null default 13;

-- ---------------- 6) 콜마너 탁송사진 (링크만 보관) ----------------
-- 우리 버킷으로 복사하지 않는다(사용자 확정). order_photos와 섞지 않는 이유:
-- order_photos는 오더상세 갤러리·고객 사진요청 응답·주행거리 답변(lib/kakaoOrderPhotos.js
-- summarizeOdometer)이 모두 읽고 있어서, 외부 링크를 그 안에 섞으면 그 세 기능의 동작이
-- 함께 바뀐다.
create table if not exists order_callmaner_photos (
  id bigserial primary key,
  order_id bigint not null references orders(id) on delete cascade,
  -- start(운행전) / end(운행후) — ConsPicture 응답의 before/after에 대응한다.
  phase text not null,
  -- 콜마너가 준 순번(1-based). 계기판 사진을 순번으로 찾으므로 반드시 보존한다.
  seq integer not null,
  url text not null,
  odometer_km integer,
  -- pending / done / failed / skipped — 같은 사진을 매분 다시 읽지 않기 위한 표시.
  ocr_status text,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_order_callmaner_photos
  on order_callmaner_photos(order_id, phase, seq);
create index if not exists idx_order_callmaner_photos_order
  on order_callmaner_photos(order_id, phase);
alter table order_callmaner_photos enable row level security;
