-- 고객 요청사항에서 찾아낸 부대비용 후보.
--
-- 왜 필요한가: 법인 고객에게는 접수 화면의 부대비용 입력이 보이지 않는다(청구 금액 설정이라
-- 요금 칸과 같은 규칙으로 가린다). 그래서 고객이 "주유 가득 채워주세요"를 전할 수 있는 곳은
-- 요청사항 본문뿐이고, 그 본문을 아무도 읽지 않으면 기사에게 지시가 안 닿고(차가 빈 채로
-- 도착한다) 실비를 썼어도 청구할 줄이 없다.
--
-- 후보일 뿐 확정이 아니다. 탁송 오더는 고객이 접수해도 콜마너에는 대기로 들어가고 관리자가
-- 확인해야 기사에게 가는 '접수'로 바뀐다 — 그 확인 자리에 후보를 올려놓고 사람이 고른다.
-- 자동으로 줄을 만들면 LLM이 잘못 읽었을 때 없는 청구가 생긴다.
--
-- 모양: [{ code, chargeType, label, settleMode, billable, evidence, amount }]
-- evidence는 그렇게 판단한 원문 조각이다 — 관리자가 "왜 이게 잡혔나"를 보고 판단한다.
alter table orders add column if not exists memo_extra_json text;

-- 분석을 이미 돌렸는지. NULL이면 아직 안 돌린 것이고, 값이 있는데 memo_extra_json이
-- 빈 배열이면 "돌렸고 후보가 없다"는 뜻이다. 둘을 구분해야 매번 다시 돌리지 않는다.
alter table orders add column if not exists memo_extra_checked_at text;
