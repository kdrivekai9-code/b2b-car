-- Vertex AI 호출의 소요 시간과 성패를 남긴다.
--
-- 왜: 지금까지 고객이 실제로 얼마나 기다리는지를 숫자로 볼 방법이 전혀 없었다. DB 조회는
-- 실측했지만(0.1~0.3초) 고객 체감을 지배하는 것은 제미나이 호출이고, 그 시간은 어디에도
-- 기록되지 않았다. integration_errors는 "실패"만 남기므로 성공한 호출이 몇 초 걸렸는지는
-- 알 수 없다 — 느려도 성공하면 흔적이 없다.
--
-- 오류 테이블과 합치지 않은 이유: 성격이 다르다. integration_errors는 사람이 읽고 조치하는
-- 예외 기록이라 건수가 적어야 정상이고, 이 테이블은 모든 호출을 남겨 분포를 보는 계측이라
-- 건수가 많은 것이 정상이다. 섞으면 오류 화면이 정상 호출로 뒤덮인다.
create table if not exists ai_call_logs (
  id bigserial primary key,
  -- vertex(제미나이) 외에 다른 공급자가 생기면 여기서 갈린다.
  provider text not null default 'vertex',
  -- 어떤 용도의 호출인지. 호출부가 넘기는 이름이다(intake_extract, faq_answer, odometer_ocr 등).
  -- 이 값이 없으면 "느리다"까지만 알고 "무엇이 느린지"를 모른다.
  op text not null default 'unknown',
  model text,
  duration_ms integer not null,
  ok boolean not null,
  -- 실패 사유. 성공이면 null.
  error_message text,
  -- 입력·출력 크기(문자 수). 지연이 길 때 "프롬프트가 커서인지"를 가르는 데 쓴다.
  input_chars integer,
  output_chars integer,
  -- 이미지 첨부 호출(계기판 OCR)은 텍스트 호출보다 느린 것이 정상이라 따로 센다.
  image_count integer not null default 0,
  created_at timestamptz not null default now()
);

-- 조회는 "최근 것부터" 그리고 "용도별로"가 전부다.
create index if not exists idx_ai_call_logs_created on ai_call_logs(created_at desc);
create index if not exists idx_ai_call_logs_op on ai_call_logs(op, created_at desc);

alter table ai_call_logs enable row level security;
