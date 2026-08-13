-- 감사 로그(access_logs) 보관 정책 — 오래된 행을 아카이브 테이블로 옮긴다.
--
-- 왜: access_logs가 하루 896건씩 늘고 있다(실측: 19.2일에 17,169건 → 1년 32만 건). 지금은
-- 5.8MB로 작지만 이미 이 DB에서 가장 큰 테이블이고, 조회 화면·백업이 모두 이 테이블을 통째로
-- 이고 간다. 커지기 전에 조치하는 예방적 조치다.
--
-- 지우지 않고 '옮긴다'. 감사 로그는 함부로 삭제할 성격이 아니다 — 보관 의무나 사후 조사
-- 필요성을 우리가 단독으로 판단할 수 없다. 그래서 hot 테이블(access_logs)은 최근 것만 두고
-- 오래된 것은 archive로 옮겨, 조회·백업 비용만 낮추고 데이터는 그대로 남긴다.
-- 총 저장 용량이 줄지는 않는다는 점은 분명히 해둔다 — 줄이려면 아카이브를 외부로 내보내고
-- 지우는 별도 결정이 필요하다.
create table if not exists access_logs_archive (
  id bigint primary key,
  user_id integer,
  account text,
  event_type text,
  work_detail text,
  subject_info text,
  ip_address text,
  user_agent text,
  success boolean,
  created_at timestamptz,
  -- 언제 옮겨졌는지. 원본 created_at과 구분해야 "언제부터 아카이브가 돌았는지"를 알 수 있다.
  archived_at timestamptz not null default now()
);

-- 아카이브도 결국 조회 대상이다(사후 조사). 원본과 같은 축으로 찾는다.
create index if not exists idx_access_logs_archive_created on access_logs_archive(created_at desc);
create index if not exists idx_access_logs_archive_account on access_logs_archive(account);

alter table access_logs_archive enable row level security;
