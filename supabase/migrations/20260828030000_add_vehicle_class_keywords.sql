-- 차종 자동 판정 사전에 운영자가 낱말을 더할 수 있게 한다.
--
-- 지금까지 판정 사전(수입 브랜드 125개 등)은 lib/vehicleClass.js에만 있었다. 그래서 빠진
-- 브랜드를 발견해도(쿠프라 · DS · 볼보 EX30 …) 운영자가 손쓸 방법이 없고 배포를 기다려야 했다.
-- 그동안 그 차종에는 할증이 안 붙는다 — 요금이 **적게** 나가는 쪽이라 고객은 항의하지 않고,
-- 정산할 때까지 아무도 모른다.
--
-- 그렇다고 사전을 통째로 DB로 옮기지는 않는다. 옮기면 이 표가 비었을 때(마이그레이션 누락,
-- 신규 환경) 모든 차가 국산·일반으로 떨어져 할증이 통째로 사라진다 — 조용히 요금이 틀어지는
-- 최악의 실패 양식이다. 코드 사전이 바닥을 받치고, 이 표는 그 위에 **더하기만** 한다.
--
-- 그래서 삭제는 이 표에 넣은 낱말만 가능하다. 코드 사전의 낱말은 여기서 지울 수 없다.
create table if not exists vehicle_class_keywords (
  id         bigserial primary key,
  -- 코드 사전의 묶음 이름과 같은 값을 쓴다(lib/vehicleClass.js).
  --   import_brand | import_model | ev | large | domestic
  kind       text not null,
  word       text not null,
  note       text,
  created_by bigint references users(id),
  created_at text not null default to_char((now() at time zone 'Asia/Seoul'), 'YYYY-MM-DD HH24:MI:SS')
);

-- 같은 낱말을 두 번 넣어도 판정은 같지만 목록이 지저분해진다.
create unique index if not exists vehicle_class_keywords_kind_word_idx
  on vehicle_class_keywords(kind, lower(word));
