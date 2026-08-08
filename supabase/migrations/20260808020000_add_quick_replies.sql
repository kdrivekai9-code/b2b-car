-- 상담원 빠른 답변(상용구) — 상담원이 매번 손으로 치던 반복 문구를 등록해 두고 골라 넣는다.
--
-- 상담톡 로그 분석에서 상담원 발화의 17.2%가 "네 접수하겠습니다" 한 마디였고, 인사·대기 안내처럼
-- 토씨까지 같은 문장이 반복된다. AI 초안(chat_suggestions)은 고객 발화를 이해해야 만들 수 있는
-- 반면, 이건 상담원이 언제든 즉시 꺼내 쓰는 고정 문구라 성격이 다르다 — 둘은 같이 쓴다.
--
-- body에는 치환 토큰을 쓸 수 있다. 지금 지원하는 건 {상담원} 하나 —
-- "안녕하세요 {상담원} 상담원입니다"가 보낼 때 로그인한 상담원 이름으로 바뀐다. 이름을 매번
-- 고쳐 넣게 하면 결국 손으로 치는 것과 같아서, 인사말을 공용으로 쓰려면 이게 있어야 한다.
create table if not exists quick_replies (
  id integer generated always as identity primary key,
  -- 인사 | 대기 | 접수 | 완료 | 안내 — 입력창 옆 목록에서 묶어 보여주는 용도다.
  category text not null default '기타',
  -- 목록에서 고를 때 보이는 짧은 이름. 본문 전체를 다 읽지 않고 찾을 수 있어야 한다.
  title text not null,
  body text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_by integer references users(id) on delete set null,
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at text
);
create index if not exists idx_quick_replies_active on quick_replies(is_active, category, sort_order, id);

alter table quick_replies enable row level security;

-- 기본 문구 — 실제 상담톡 로그에서 반복된 표현을 그대로 옮겼다. 운영하면서 수정·삭제할 수 있다.
-- 이미 같은 제목이 있으면 넣지 않는다(마이그레이션 재실행 대비).
insert into quick_replies (category, title, body, sort_order)
select v.category, v.title, v.body, v.sort_order
from (values
  ('인사', '첫 인사',        '안녕하세요, {상담원} 상담원입니다. 무엇을 도와드릴까요?', 10),
  ('인사', '연결 인사',      '안녕하세요, 상담원 연결되었습니다. 말씀해주세요.', 20),
  ('대기', '확인 후 답변',   '잠시만 기다려주세요. 확인 후 답변드리겠습니다.', 30),
  ('대기', '조회 중',        '조회 중입니다. 잠시만 기다려주세요.', 40),
  ('대기', '기사 확인 중',   '담당 기사님께 확인 중입니다. 확인되는 대로 알려드리겠습니다.', 50),
  ('접수', '접수 완료',      '접수되었습니다.', 60),
  ('접수', '접수 진행',      '네, 접수하겠습니다.', 70),
  ('접수', '추가 요청 확인', '추가 요청사항이 있으신가요?', 80),
  ('접수', '출발지 확인',    '출발지 주소와 연락처를 알려주시겠어요?', 90),
  ('접수', '도착지 확인',    '도착지 주소와 연락처를 알려주시겠어요?', 100),
  ('접수', '차량 확인',      '차량번호와 차종을 알려주시겠어요?', 110),
  ('접수', '일시 확인',      '출발 희망 일시를 알려주시겠어요? (즉시 출발도 가능합니다)', 120),
  ('접수', '서류 확인',      '자동차등록증과 매도용 인감증명서는 차량에 함께 두시면 됩니다.', 130),
  ('완료', '처리 완료',      '처리되었습니다.', 140),
  ('완료', '배차 완료',      '기사 배정되었습니다. 배정 정보는 곧 안내드리겠습니다.', 150),
  ('완료', '탁송 완료',      '탁송 완료되었습니다. 이용해주셔서 감사합니다.', 160),
  ('안내', '마무리 인사',    '더 궁금하신 점 있으시면 언제든 말씀해주세요. 감사합니다.', 170),
  ('안내', '지연 안내',      '확인이 늦어져 죄송합니다. 최대한 빠르게 처리하겠습니다.', 180)
) as v(category, title, body, sort_order)
where not exists (select 1 from quick_replies q where q.title = v.title);
