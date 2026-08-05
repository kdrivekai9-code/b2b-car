-- 콜마너 연동 실패 시, 사람이 읽는 메시지(callmaner_last_error)와 별개로 콜마너 서버가
-- 실제로 응답한 에러코드(정의서의 rc — 예: E0)를 따로 보관한다. 메시지 문자열 안에도
-- "콜마너 API 오류: E0 ..." 형태로 코드가 섞여 들어가 있지만, 그 한글 문장을 파싱해서
-- 코드를 뽑아내는 것은 문구가 바뀌면 깨지므로 컬럼으로 분리해 저장한다.
-- 좌표 누락 같은 우리 쪽 사전검증 실패는 콜마너에 요청 자체가 나가지 않아 코드가 없다(NULL).
alter table orders add column if not exists callmaner_last_error_code text;
