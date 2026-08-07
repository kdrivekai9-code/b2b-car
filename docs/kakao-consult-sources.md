# 카카오 상담톡 연동 — 근거 문서 목록

`lib/kakaoConsult.js` / `routes/kakaoConsult.js` / `supabase/migrations/20260806030000_add_kakao_consult.sql`
주석이 "계획서 4.4", "계획서 8.3" 식으로 참조하는 문서들이다.

**PDF 원본은 저장소에 두지 않는다** — 세 개 합쳐 14MB라 클론 용량에 영구히 남는다. 대신
`pdftotext -layout` 추출본(.txt)만 커밋해 grep으로 규격을 찾을 수 있게 하고, 원본이 필요하면
아래 드라이브 링크에서 받는다.

| 텍스트 추출본 | 내용 | PDF 원본(드라이브) |
| --- | --- | --- |
| `kakao-consult-plan.html` | **카카오 상담톡 연동 계획서** — 주석에서 "계획서 N절"로 부르는 그 문서 | 이 저장소에서 작성 |
| `kakao-consult-api-spec-resale.txt` (72p) | **최신** — "상담톡 API 명세서 배포용_재판매사용". 개인정보제공동의 수신 규격(IF11004)은 이 문서에만 있다 | https://drive.google.com/file/d/1Wc2ciTBeCYO-YEyiA8m32oz1sPfrDuBN/view |
| `kakao-consult-api-spec.txt` (51p) | 카카오 상담톡 API 명세서(이전본) | https://drive.google.com/file/d/1v3LiyIZiwX7l_tqQkqp7alYaqI0FM67g/view |
| `kakao-consult-api-guide.txt` (23p) | 카카오 상담톡 API 문서 | https://drive.google.com/file/d/1a6NeaXfuzJIpGRqfIzdSOdb2ZyJdkm7P/view |

PDF를 다시 받아 추출하려면:

```bash
curl -sL -o spec.pdf "https://drive.google.com/uc?export=download&id=<파일ID>"
pdftotext -layout spec.pdf docs/kakao-consult-api-spec-resale.txt
```

- 원본 드라이브 폴더: https://drive.google.com/drive/u/0/folders/1qTqOhqpXZpdKsq5IhbMlmqr2UcKjBGQA
  (로그인이 필요해 폴더 목록은 못 읽는다 — 새 문서는 파일 단위 공유 링크로 받아야 한다.)
- **API 경로 버전**: 최신 명세서(72p)까지 포함해 모든 문서와 라이브 스펙이 `/api/v1/*`이고,
  실측으로도 alpha 서버는 v1만 응답한다(v3는 404). `CONSULTALK_API_VERSION`으로 전환만 가능하게
  해뒀다 — 자세한 근거는 `lib/kakaoConsult.js` 상단 주석.
- ConsulTalk 중계서버 API(스웨거): https://consultalk-alpha.callmaner.com/docs#/ — 문서가 아니라 라이브
  스펙이라 PDF 사본이 없다. 변경되면 계획서 5·6절과 어긋날 수 있으니 작업 전 확인할 것.
