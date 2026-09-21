-- 카카오로 못 나간 봇 말풍선을 기억해 두고 나중에 다시 보낸다.
--
-- 왜 필요한가(사용자 확정 2026-09-21): 오래 쉰 뒤 첫 발신이 중계서버에서 502로 거부되는 일이
-- 반복됐다. 봇 답변은 우리 DB(chat_messages)에 저장되므로 **상담관리 화면에는 정상으로
-- 답한 것처럼 보이고**, 고객만 아무것도 못 받는다.
--
-- 그 자리에서 몇 번 다시 보내는 것(lib/kakaoConsult.js SEND_RETRY_DELAYS_MS)으로는 부족했다.
-- 실측:
--   09-17  실패 → 4초 뒤 성공        (그 자리 재시도로 건질 수 있는 폭)
--   09-21  3초간 세 번 다 실패 → 2분 뒤 성공  (건질 수 없는 폭)
-- 회복까지 수 초에서 수 분까지 들쭉날쭉해서, 요청 안에서 기다리는 방식으로는 덮을 수 없다.
-- 몇 분을 기다리려고 서버리스 함수를 붙잡아 두는 것도 낭비고, 인스턴스가 죽으면 사라진다.
--
-- 그래서 **보낼 것을 남겨두고 매분 크론이 다시 보낸다.** 말풍선 자체는 이미 저장돼 있으니
-- 새 표를 만들지 않고 그 행에 배달 상태만 붙인다.
--
-- kakao_send_state
--   NULL      이 경로와 무관하거나(고객 발화·웹 세션) 처음에 바로 나간 것
--   'pending' 발신이 실패해 다시 보내야 하는 것
--   'sent'    다시 보내 성공한 것 (처음에 성공한 것과 구분해 두면 얼마나 늦게 닿았는지 보인다)
--   'failed'  한도까지 시도하고 포기한 것 — 사람이 봐야 한다
--
-- 기존 행은 전부 NULL로 남는다. 지난 실패를 소급해 다시 보내지 않는다 — 며칠 지난 답을
-- 이제 와서 보내면 고객에게는 맥락 없는 말이 된다.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kakao_send_state text;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kakao_send_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kakao_send_last_at text;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kakao_send_error text;

-- 크론이 "다시 보낼 것"만 빠르게 집는다. 대상은 극히 일부라 부분 인덱스로 둔다 —
-- chat_messages는 계속 커지는 표이고, 전체 인덱스를 만들 이유가 없다.
CREATE INDEX IF NOT EXISTS idx_chat_messages_kakao_pending
  ON chat_messages (id) WHERE kakao_send_state = 'pending';
