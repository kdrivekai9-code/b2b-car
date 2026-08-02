# Next AI Intake 수동 E2E 체크리스트

## 목적
- Next AI intake 화면(`/orders/ai-intake`)의 단계 전환(collecting/confirming/choose_field/choose_address_candidate/offer_agent), 실시간 수신, 폼 자동반영, 등록 전 precheck를 빠르게 회귀 검증한다.
- 체크리스트는 `NEXT_STAGE3_AI_INTAKE_ENABLED=true` 전용이다.

## 사전 조건
- 브라우저에서 로그인된 `admin` 계정 1개.
- 가능하면 `admin` 계정 2개(상담원 호출 검증용).
- `/orders/ai-intake` 접속 시 상단에 `AI 챗봇` 페이지가 열릴 것.

## 공통 확인
- [ ] 페이지 진입 시 상단 연결 상태가 `실시간 연결중` 또는 잠시 후 `실시간 연결중`으로 전환된다.
- [ ] 복원 세션이 있으면 `RESTORE SNAPSHOT` 카드에 세션 ID/메시지/draft가 표시된다.
- [ ] 채팅 입력 후 사용자 말풍선이 1회만 표시된다(중복 표시 없음).

## 시나리오 A: 기본 수집 -> 확인
1. 채팅에 아래 예시 입력
- `내일 오후 3시 판교역에서 강남역까지 차량 이동 예약, 출발지 010-1111-1111, 도착지 010-2222-2222`
2. 기대 결과
- [ ] 봇이 요약 메시지를 만들고 마지막에 `위 내용으로 등록할까요?`를 표시한다.
- [ ] 상단 `Phase`가 `등록 확인`으로 바뀐다.
- [ ] 하단 오더 폼에 출발/도착/예약일시/연락처가 자동 반영된다.

## 시나리오 B: 확인 단계에서 수정 분기
1. 시나리오 A 직후 `수정` 입력
2. 기대 결과
- [ ] 수정 항목 질문이 표시된다.
- [ ] 상단 `Phase`가 `수정 항목 선택`으로 바뀐다.
3. `출발지 주소 수정` 입력 후 새 주소 입력
- [ ] 봇이 출발지 주소 재입력을 요청한다.
- [ ] 새 주소 입력 후 다시 `등록 확인` 단계로 돌아온다.
- [ ] 오더 폼 `출발지 주소`가 새 값으로 바뀐다.

## 시나리오 C: 차량번호 예외 규칙
1. 수정 항목에서 `차량번호 수정` 입력
2. 아래 값을 순서대로 입력
- `잘모름`
- `없음`
3. 기대 결과
- [ ] `없음` 입력 시 차량번호가 스킵 처리된다.
- [ ] 오더 폼 차량번호 값이 비워진다.
- [ ] 봇이 확인 단계로 복귀한다.

## 시나리오 D: 추가요청사항(메모) 규칙
1. 수정 항목에서 `기사 전달사항 수정` 입력
2. `없음` 입력
3. 기대 결과
- [ ] 메모가 빈 값으로 처리된다.
- [ ] 오더 폼 `메모(기사전달사항)`가 비워진다.

## 시나리오 E: 주소 후보선택
1. 의도적으로 모호한 주소 입력
- `출발지 중앙로 1`
2. 기대 결과
- [ ] 봇이 `1)`, `2)` 형식의 후보 선택 질문을 보여준다.
- [ ] `1번` 또는 `2번` 입력 시 선택 결과가 반영되고 다음 단계로 진행한다.
- [ ] 상단 `Phase`가 `주소 후보 선택`에서 다음 단계로 전환된다.

## 시나리오 F: 상담원 제안/연결
1. 같은 단계에서 의도적으로 이해하기 어려운 답변을 2회 연속 입력
2. 기대 결과
- [ ] `더 빠른 처리를 위해 상담원 연결을 해드릴까요?` 질문이 나온다.
- [ ] `네` 입력 시 세션이 `needs_agent`로 전환된다.
- [ ] `아니요` 입력 시 이전 단계로 복귀한다.

## 시나리오 G: needs_agent 대기 중 새 접수
1. 세션 상태가 `상담원 대기`일 때 신규 오더 의도 문장 입력
- `새 오더 접수할게요. 오늘 6시 출발...`
2. 기대 결과
- [ ] 기존 대기 세션이 종료되고 새 세션이 생성된다.
- [ ] 상단 세션 ID가 새 값으로 바뀐다.
- [ ] 새 세션에서 collecting 흐름이 진행된다.

## 시나리오 H: 등록 전 precheck
1. 필수값을 일부 비운 상태에서 오더 폼 `오더 등록` 클릭
2. 기대 결과
- [ ] 저장 전에 precheck가 실행되어 인라인 에러가 표시된다.
- [ ] 실패 시 실제 오더 저장 요청은 진행되지 않는다.

## 시나리오 I: 스트림/보충 회귀
1. 다른 탭(또는 다른 admin 계정)에서 같은 세션에 메시지 추가
2. 기대 결과
- [ ] 현재 화면에 실시간으로 메시지가 수신된다.
- [ ] 네트워크 잠깐 끊김 후 복구 시 누락 메시지가 보충된다.

## 판정
- [ ] PASS
- [ ] FAIL
- 실행일:
- 실행자:
- 메모:

## 자동 실행 결과 (2026-08-02)
- 실행 명령:
	- `PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers E2E_BASE_URL=http://127.0.0.1:3000 npx playwright test tests/manual/ai-intake-address-merge.playwright.spec.js --reporter=line --workers=1`
- 결과:
	- `2 passed (4.1s)`
- 실행 화면 판별:
	- 로컬 `/orders/ai-intake`는 marker 확인 결과 `NEXT_MARKER=false`, `LEGACY_MARKER=true` (legacy EJS 렌더 기준)
- 대상 스펙:
	- `tests/manual/ai-intake-address-merge.playwright.spec.js`
- 자동 검증으로 확인된 항목:
	- 주소 상세 부속어(예: 주차장) 병합 반영
	- 주소 후보 선택(1번/2번) 이후 반영 유지
- 자동 검증만으로는 미포함(수동 계속 필요):
	- needs_agent 신규 세션 전환
	- precheck 실패 인라인 오류
	- SSE 끊김 후 catch-up 보충
	- confirming/choose_field 전체 대화 분기

메모(2026-08-02): precheck 실패 자동화 케이스는 대화 분기 변동으로 불안정하여 이번 배치에서 제외했고,
주소 병합 회귀 2케이스만 유지했다(스테이징 재실행 `2 passed`).

추가(2026-08-02): precheck 실패 경로는 대화 UI 분기와 분리한 독립 스펙으로 자동화했다.
- 스펙 파일: `tests/manual/ai-intake-precheck.playwright.spec.js`
- 검증 내용: `/orders/ai-intake/submit-precheck`에 지사 미선택으로 요청 시 `400` + `지사를 선택해주세요.`
- 스테이징 실행 결과: `1 passed (1.7s)`

추가(2026-08-02): needs_agent 전환 경로와 catch-up 보충도 독립 스펙으로 자동화했다.
- 스펙 파일: `tests/manual/ai-intake-session-behaviors.playwright.spec.js`
- 검증 내용 1: `needs_agent` 이후 기존 세션 `closeSession` 종료 + 신규 `/chat/session` 생성(세션 ID 변경, 신규 상태 `bot`) 확인
- 검증 내용 2: `/chat/:id/messages?since=`가 기준 ID 이후 메시지만 반환(catch-up 보충) 확인
- 스테이징 실행 결과: `2 passed (4.4s)`

추가(2026-08-02): AI intake 전용 통합 실행 스크립트를 추가했다.
- npm 스크립트: `npm run e2e:ai-intake`
- 실행 대상: 주소 병합(2) + precheck(1) + 세션 동작(2) = 총 5개 테스트
- 스테이징 실행 결과: `5 passed (8.2s)`

## 로컬 Next 단독 검증 메모 (2026-08-02)
- 시도: `NEXT_STAGE3_AI_INTAKE_ENABLED=true npx next dev -p 3100`
- 관찰:
	- `/orders/ai-intake` 진입 전 로그인 단계에서 `/login`이 404로 응답
	- 로컬 Next 단독 서버에서는 legacy fallback(`/:path* -> /api/index`) 경로가 실사용 배포와 동일하게 동작하지 않아 인증 플로우 재현이 불가
- 결론:
	- **Next 화면 기준 E2E는 통합 런타임(Preview/Staging)에서 수행**해야 한다.

## 스테이징 통합 런타임 결과 (2026-08-02)
- 대상: `https://b2bcarkr-staging.vercel.app`
- 로그인 체크: `admin / Admin!2345` 성공(302 -> `/`)
- 렌더 판별:
	- `NEXT_MARKER=false`
	- `LEGACY_MARKER=true`
	- 결론: 해당 시점 스테이징 `/orders/ai-intake`는 legacy EJS 렌더
- 자동 스펙 실행:
	- `E2E_BASE_URL='https://b2bcarkr-staging.vercel.app' E2E_LOGIN_ID='admin' E2E_PASSWORD='Admin!2345' PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers npx playwright test tests/manual/ai-intake-address-merge.playwright.spec.js --reporter=line --workers=1`
	- 결과: `2 passed (3.5s)`

## Preflight 스크립트 보정 (2026-08-02)
- 문제:
	- `npm run check:login:all`의 health check가 `/`, `/orders`에서 `302`만 허용해, 스테이징의 `307` 리다이렉트를 FAIL로 오판정함.
- 조치:
	- `scripts/check-login-all.js`에서 health check 허용 상태를 `[302, 307]`으로 확장.
- 재검증:
	- `LOGIN_BASE_URL='https://b2bcarkr-staging.vercel.app' npm run check:login:all`
	- 결과: `pass=true`
