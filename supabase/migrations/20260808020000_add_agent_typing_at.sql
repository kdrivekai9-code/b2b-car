-- 상담원 부재 시 AI 초안 자동 발송 — 타이핑 감지용 컬럼.
--
-- 상담원이 응대 중(agent_active)인 세션에서 봇 초안(chat_suggestions)이 승인 대기로 뜬 뒤
-- 일정 시간 상담원이 아무 반응이 없으면 초안을 자동 발송한다. 다만 상담원이 답을 "쓰고 있는"
-- 중에 봇이 먼저 나가면 같은 질문에 답이 두 번 가고, 카카오는 발송 취소가 안 된다.
-- 그래서 상담원 입력창의 타이핑 신호를 여기에 기록해두고, 최근에 타이핑이 있었으면 자동
-- 발송을 건너뛴다.
--
-- 메시지를 보낸 시각(chat_messages)만으로는 부족하다 — 긴 답변을 1분째 작성 중인 상담원은
-- 마지막 발송 시각이 한참 전이라 "부재"로 오판된다.
alter table chat_sessions
  add column if not exists agent_typing_at text;

-- chat_suggestions.status에는 CHECK 제약이 없어 값만 추가하면 된다:
--   pending → approved(상담원 승인) | dismissed(무시) | auto_sent(상담원 무응답으로 자동 발송)
-- auto_sent는 decided_by가 null이다(사람이 결정하지 않았다는 뜻). 화면은 이걸로 "자동 발송됨"
-- 배지를 띄우고, 상담원이 이어서 정정 메시지를 보낼 수 있게 한다.
