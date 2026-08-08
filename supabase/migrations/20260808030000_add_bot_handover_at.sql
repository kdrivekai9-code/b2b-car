-- 상담원 무응답으로 봇이 응대를 이어받은 시점.
--
-- 자동 개입(routes/chat.js autoSendPendingSuggestions)은 세션 status를 'bot'으로 되돌리는데,
-- 그것만으로는 "처음부터 봇이 응대한 세션"과 "상담원이 응답을 못 해 봇이 대신 받은 세션"을
-- 구분할 수 없다. 고객 입장에서는 그 차이가 크다 — 사람과 대화하다가 갑자기 AI로 바뀐 것을
-- 모른 채 계속 이야기하게 되기 때문이다. 이 값이 있으면 그 구간의 봇 응답에 표시를 붙인다.
--
-- 상담원이 다시 답장하면(deliverAgentReply) NULL로 지운다 — 사람이 돌아왔다는 뜻이다.
alter table chat_sessions
  add column if not exists bot_handover_at text;
