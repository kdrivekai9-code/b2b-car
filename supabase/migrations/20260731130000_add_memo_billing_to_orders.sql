-- 기사요청사항(memo_customer: 실제 탁송 수행/서류요청 등 운행 관련)과 업체요청사항
-- (memo_billing: 계산서/내역서/명세서 발행 시 참고할 내용, 예: "비고란에 판촉비로 기재")을
-- 분리해서 저장하기 위한 컬럼.
alter table orders
  add column if not exists memo_billing text;
