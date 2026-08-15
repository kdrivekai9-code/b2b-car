-- 고객용 사진 모아보기 링크(/photos/:token).
--
-- 왜 필요한가: 탁송사진이 한 건에 13장(운행전) + 13장(운행후)이라 카카오톡 본문에 링크를 그대로
-- 나열하면 13줄이 된다. 그리고 카카오 평문은 앵커 텍스트를 지원하지 않아 "1, 2, 3…" 같은
-- 글자에 링크를 걸 수 없다(날 URL만 자동 링크된다). 그래서 링크 하나로 모아보는 페이지를 두고,
-- 카카오는 그 페이지를 여는 버튼 하나만 붙인다.
--
-- 업로드 토큰(photo_upload_token)과 분리한다 — 업로드 권한과 열람 권한은 다르다. 기사에게 준
-- 업로드 링크가 고객에게 넘어가면 고객이 사진을 올릴 수 있게 되고, 반대로 고객 열람 링크로
-- 업로드가 되어서도 안 된다.
--
-- gen_random_uuid()는 volatile이라 기존 행마다 각각 다른 값이 채워진다(20260722010000의
-- photo_upload_token과 같은 방식).
alter table orders
  add column if not exists photo_view_token text unique default gen_random_uuid()::text;
