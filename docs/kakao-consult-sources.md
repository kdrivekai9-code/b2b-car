# 카카오 상담톡 연동 — 근거 문서 목록

`lib/kakaoConsult.js` / `routes/kakaoConsult.js` / `supabase/migrations/20260806030000_add_kakao_consult.sql`
주석이 "계획서 4.4", "계획서 8.3" 식으로 참조하는 문서가 이 폴더에 있다. (원본은 구글 드라이브 공유
링크였고, 임시 디렉터리에만 있던 사본을 2026-08-07에 여기로 옮겼다.)

| 파일 | 내용 | 원본 |
| --- | --- | --- |
| `kakao-consult-plan.html` | **카카오 상담톡 연동 계획서** — 주석에서 "계획서 N절"로 부르는 그 문서 | 이 저장소에서 작성 |
| `kakao-consult-api-guide.pdf` (23p) | 카카오 상담톡 API 문서 | https://drive.google.com/file/d/1a6NeaXfuzJIpGRqfIzdSOdb2ZyJdkm7P/view |
| `kakao-consult-api-spec.pdf` (51p) | 카카오 상담톡 API 명세서 | https://drive.google.com/file/d/1v3LiyIZiwX7l_tqQkqp7alYaqI0FM67g/view |
| `kakao-consult-api-guide.txt` / `-spec.txt` | 위 PDF 2개의 `pdftotext -layout` 추출본 (grep용) | — |

- 원본 드라이브 폴더: https://drive.google.com/drive/u/0/folders/1qTqOhqpXZpdKsq5IhbMlmqr2UcKjBGQA
- ConsulTalk 중계서버 API(스웨거): https://consultalk-alpha.callmaner.com/docs#/ — 문서가 아니라 라이브
  스펙이라 PDF 사본이 없다. 변경되면 계획서 5·6절과 어긋날 수 있으니 작업 전 확인할 것.
