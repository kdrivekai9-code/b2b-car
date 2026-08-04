-- 콜마너가 발급하는 providerId는 콜마너 자체 지사코드/대표번호를 포함한 완전한 문자열이고
-- (예: B100-12345-AP12345), 우리 branches.code/main_phone과는 무관하다 — 즉 우리 자체 코드/
-- 전화번호와 이어붙여 조립할 수 없다. callmaner_app_code 컬럼에 "관련어플코드 부분값"만
-- 들어간다고 잘못 설계했던 걸 바로잡아, providerId 전체 문자열을 그대로 저장하는 용도로
-- 컬럼명을 바꾼다(rename이라 기존에 입력된 값은 그대로 유지됨).
alter table branches rename column callmaner_app_code to callmaner_provider_id;
