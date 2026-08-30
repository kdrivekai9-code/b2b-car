-- 기사 위치 추적 공개 링크 토큰.
--
-- 고객이 카카오 상담톡에서 받는 링크라 로그인 없이 열려야 한다(사진 모아보기 /photos/:token과
-- 같은 이유·같은 방식). 추측할 수 없어야 하므로 uuid를 쓴다.
--
-- photo_view_token을 재사용하지 않는 이유: 유효 기간이 정반대다. 사진 링크는 **운행이 끝난 뒤**
-- 오래 살아 있어야 하고, 이 링크는 **운행 중에만** 열려야 한다(완료되면 기사 위치를 더는
-- 수집하지 않으므로 보여줄 것도 없다). 한 토큰에 두 수명을 담으면 둘 중 하나는 틀린다.
alter table orders
  add column if not exists tracking_token text unique default gen_random_uuid()::text;
