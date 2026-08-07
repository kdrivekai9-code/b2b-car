-- 카카오 개인정보 제공 동의 수신값 저장 (상담톡 API 명세서 v1.5.6 "8. 개인 정보 제공 동의").
--
-- 카카오 고객은 b2b-car 계정이 없어 어느 거래처인지 알 수 없다. 채널 단위 매핑
-- (kakao_consult_accounts)으로도 풀 수 있지만 한 채널을 여러 거래처가 쓰면 구분되지 않는다.
-- 동의를 받으면 카카오가 프로필 닉네임과 카카오계정 전화번호를 보내주므로
-- (/receive/personal_info), 그 번호로 users.phone 또는 orders.origin_contact를 찾아
-- 거래처를 특정할 수 있다.
--
-- routes/kakaoConsult.js의 /receive/personal_info 처리와 상담 목록의 고객명 표시가 이 두 컬럼을
-- 이미 참조하고 있다(컬럼이 없으면 동의를 받아도 저장 단계에서 실패한다).
--
-- 참고 — 명세서 제약 두 가지:
--   · 동의 말풍선은 상담 세션당 1회만 발송 가능 (지금은 "새 세션의 첫 응답"에서만 보내 지킨다)
--   · 동의 절차는 말풍선 발송 시점으로부터 3일간만 유효
alter table chat_sessions
  add column if not exists external_name text,
  add column if not exists personal_info_at text,
  -- 말풍선을 언제 보냈는지 — 세션당 1회 제한을 지키고, 3일 유효기간이 지났는지 판단한다.
  add column if not exists personal_info_requested_at text;
