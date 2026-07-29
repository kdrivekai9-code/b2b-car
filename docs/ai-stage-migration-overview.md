# AI 전환 단계 오케스트레이션

이 문서는 AI 전환을 3단계로 나누고, 각 단계가 통과해야 다음 단계로 넘어가도록 하는 운영 기준을 정의한다.

## 단계 흐름
- 1단계: 읽기 전용 화면 전환
- 2단계: 오더 등록/수정 폼 전환
- 3단계: 상담관리/실시간 플로우 전환

## 공통 원칙
- 기존 Express + EJS + 정적 JS 계약을 먼저 보존한다.
- 화면만 바꾸고 API 계약은 유지한다.
- DB 스키마 변경이 필요한 경우, 역호환 가능한 상태에서만 진행한다.
- 각 단계는 계약 테스트, 스테이징 실사용 검증, 롤백 리허설을 모두 통과해야 한다.
- 통과 판정은 기능 완료가 아니라 운영 투입 가능성을 의미한다.

## 단계별 게이트

### 1단계 완료 조건
- [ ] 계약 테스트 100% 통과
- [ ] 스테이징 실사용 검증 통과
- [ ] 롤백 경로 확인 완료
- [ ] 승인자 확인 완료

### 2단계 완료 조건
- [ ] 계약 테스트 100% 통과
- [ ] 스테이징 실사용 검증 통과
- [ ] 롤백 경로 확인 완료
- [ ] 승인자 확인 완료
- [ ] 오더 생성/수정 업무가 기존과 동등하게 수행됨

### 3단계 완료 조건
- [ ] 계약 테스트 100% 통과
- [ ] 스테이징 실사용 검증 통과
- [ ] 롤백 경로 확인 완료
- [ ] 승인자 확인 완료
- [ ] 실시간 상담 운영에 영향 없음

## 단계 진행 규칙
- 1단계 실패 시 2단계 착수 금지
- 2단계 실패 시 3단계 착수 금지
- 운영자가 승인하지 않은 상태에서는 다음 단계 문서만 준비하고 구현은 보류
- 회귀가 발견되면 직전 안정 단계로 즉시 롤백

## 참조 문서
- [1단계 체크리스트](ai-stage-1-checklist.md)
- [2단계 체크리스트](ai-stage-2-checklist.md)
- [3단계 체크리스트](ai-stage-3-checklist.md)

## 최종 판정
- 판정 결과: [ ] PASS  [x] FAIL (미착수)
- 판정일시: 2026-07-29
- 판정자: (재검증 필요 — 아래 정정 사유 참고)
- 비고(정정): 이전 판정(2026-07-27, "GitHub Copilot" 명의 PASS)은 무효화한다. 실제 코드베이스에
  Next.js/Vite 관련 코드·의존성·config가 전혀 없고(package.json에 next/vite 미포함), 1단계
  체크리스트 본문 항목이 전부 미체크 상태로 남아있는 등 판정과 실제 산출물이 불일치했다.
  이전 판정에 기재된 점검(대시보드/오더/문의/상담 화면 응답, 필터, CRUD, preflight 등)은
  **기존 Express+EJS 앱에 대한 정상 동작 회귀 점검**으로는 유효하지만, Next 전환 자체의
  완료를 의미하지 않는다. 1~3단계는 모두 "미착수"로 되돌리고, 실제 전환 작업 시작 시
  이 문서를 다시 갱신한다.

## 운영 전환 체크 (참고: 기존 Express 앱 회귀 점검 기록, Next 전환 검증 아님)
- 웹 세션 기준 주요 화면 접근 정상: 상담 관리 리스트/상세 확인 완료
- 핵심 엔드포인트 응답 확인: `/`, `/orders`, `/chat/sessions` 모두 302(인증 리다이렉트) 응답 정상
- 테스트 데이터 정리 완료: `PAGTST*`, `OID1069`, `3단계 검증용 상담원 답변` 삭제 반영 확인
- 자동 preflight 게이트: `npm run check:preflight` (다중 계정 로그인 + 기본 헬스체크) 통과 확인
- CI 연동: `.github/workflows/playwright-e2e.yml`에서 E2E 전 preflight 수행 및 결과 아티팩트(`preflight-report`) 업로드
- 최신 로컬 preflight 통과: 2026-07-27T14:52:57.845Z (`pass=true`, retries 적용 후 3계정 모두 302)
- GitHub Actions workflow_dispatch 실행 확인: `30322277805` 성공, 다만 `DATABASE_URL` secret 미설정으로 e2e job은 skip 처리됨

## CI 재실행 체크리스트
- `DATABASE_URL` repository secret 등록
- `SESSION_SECRET` repository secret 등록
- `LOGIN_PASSWORD_ADMIN` repository secret 등록
- `LOGIN_PASSWORD_BRANCH_MANAGER` repository secret 등록
- `LOGIN_PASSWORD_CLIENT` repository secret 등록
- 위 값 등록 후 `gh workflow run .github/workflows/playwright-e2e.yml -R kdrivekai9-code/b2b-car` 다시 실행
- 실행 후 `gh run view <run-id>`와 artifact(`preflight-report`, `preflight-summary`) 확인
