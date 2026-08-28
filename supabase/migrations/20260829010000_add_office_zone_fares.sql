-- 지점 구간요금표 — 거점(지점)과 지역 사이의 고정 요금.
--
-- 지금까지 탁송 요금은 거리 구간표(group_fare_rules / fare_rules) 하나로만 냈다. 그런데 실제
-- 계약은 "강남지점 ↔ 서울 강남구 = 20,000원"처럼 **거점과 지역 쌍마다 정해진 표**로 맺는 경우가
-- 많다(첨부한 단가표가 그 형태다). 거리로 환산하면 계약서와 금액이 어긋난다.
--
-- 그래서 이 표가 있으면 거리 구간표보다 **먼저** 본다(사용자 확정). 없으면 예전처럼 거리로 낸다.

-- ── 지점(거점) ──────────────────────────────────────────────────────────────
-- 좌표를 반드시 갖는다. 주소 문자열만으로 "이 오더의 출발지가 그 지점인가"를 판정하면
-- "서울 강남구 언주로 30"과 "서울특별시 강남구 언주로 30"이 다른 곳이 된다. 좌표로 본다.
create table if not exists group_branch_offices (
  id             bigserial primary key,
  group_id       bigint not null references groups_tbl(id) on delete cascade,
  name           text   not null,
  address        text   not null,
  address_detail text,
  lat            numeric,
  lon            numeric,
  -- orders와 같은 표기 규칙(시도는 약어, 시군구는 붙여쓰기 — lib/kakaoRegion.js).
  -- 표기가 갈리면 지역 매칭이 조용히 빗나간다.
  sido           text,
  sigugun        text,
  seq            integer not null default 1,
  created_at     text not null default to_char((now() at time zone 'Asia/Seoul'), 'YYYY-MM-DD HH24:MI:SS')
);
create index if not exists group_branch_offices_group_idx on group_branch_offices(group_id, seq, id);
-- 같은 법인에 같은 이름의 지점이 둘이면 엑셀 업로드가 어느 쪽인지 못 고른다.
create unique index if not exists group_branch_offices_name_idx
  on group_branch_offices(group_id, lower(name));

-- ── 지점 × 지역 요금 ────────────────────────────────────────────────────────
-- distance_km은 안내용이다. 요금은 fare 그대로 쓰고 거리로 다시 계산하지 않는다 —
-- 계약 금액이 거리에 따라 흔들리면 이 표를 두는 의미가 없다.
create table if not exists group_office_zone_fares (
  id          bigserial primary key,
  office_id   bigint  not null references group_branch_offices(id) on delete cascade,
  sido        text    not null,
  sigugun     text    not null,
  fare        integer not null default 0,
  distance_km numeric,
  created_at  text not null default to_char((now() at time zone 'Asia/Seoul'), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at  text not null default to_char((now() at time zone 'Asia/Seoul'), 'YYYY-MM-DD HH24:MI:SS')
);
-- 같은 지역이 두 줄이면 어느 금액을 청구할지 알 수 없다. 재업로드는 덮어쓴다(ON CONFLICT).
create unique index if not exists group_office_zone_fares_zone_idx
  on group_office_zone_fares(office_id, sido, sigugun);
