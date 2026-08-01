# B2B-CAR — 탁송 B2B 통합·운영 플랫폼 (Phase 1)

개발 기획서(`탁송B2B_개발기획서.docx`) 11절 "Phase 1 구현 현황"에 대응하는 실제 소스코드입니다.

## 구현 범위 (Phase 1)
- 사용자 관리: 로그인(세션 기반), 역할(admin/branch_manager/client) 및 지사·그룹·권한등급(그룹장/그룹원) 지정, CRUD
- 지사 관리: 지사 등록/수정, 활성 상태 관리
- 그룹 관리: 지사 하위 그룹(고객사/대리점) 등록/수정
- 오더 관리: 출발지·경유지·도착지·연락처·예약일시·차량번호·결제방식·수동 요금 입력으로 오더 등록, 목록 조회(지사·상태·기간·검색 필터), 상세 조회, 상태 변경(변경 이력 자동 기록), 요금/관리자 메모 수정
- 대시보드: 총 오더수, 상태별 카운트, 요금 합계, 지사별 비교, 최근 오더 목록
- 권한 분리: client는 소속 그룹 오더만 조회/등록, branch_manager는 소속 지사 오더 조회 전용, admin은 전체 접근

## 기술 스택
- Node.js + Express, EJS(서버 사이드 템플릿), express-session(PostgreSQL 세션 스토어), bcryptjs
- 데이터베이스: **Supabase(PostgreSQL)**, `pg`(node-postgres)로 직접 커넥션

## 실행 방법 (Supabase 연동)
1. Supabase 프로젝트를 준비합니다 (신규 생성 또는 기존 프로젝트 재사용).
2. 스키마를 적용합니다: `supabase/migrations/20260721000000_init_schema.sql`을 프로젝트의 SQL Editor에서 실행하거나, `supabase db push`(CLI로 프로젝트를 link한 경우)로 적용합니다.
3. `.env.example`을 `.env`로 복사하고 값을 채웁니다.
   - `DATABASE_URL`: Supabase 대시보드 > Project Settings > Database > Connection string(URI)
   - `SESSION_SECRET`: `openssl rand -base64 32` 등으로 생성한 임의의 긴 문자열
4. 의존성 설치 및 (필요 시) 데모 데이터 시드:
   ```bash
   npm install
   npm run seed   # 데모 계정/샘플 오더 2건 생성 (선택 사항, 최초 1회만)
   npm start
   ```
브라우저에서 http://localhost:3000 접속.

기본 개발 실행은 `npm run dev` (watch 미사용)입니다.

자동 재시작이 필요하면 `npm run dev:watch`를 사용하세요. macOS 환경에서 파일 감시 한도에 따라 `EMFILE` 오류가 날 수 있어 기본값은 watch 미사용으로 두었습니다.

로그인 경로 스모크 체크는 아래처럼 실행할 수 있습니다.

```bash
LOGIN_PASSWORD='Admin!2345' npm run check:login
```

- 기본값: `LOGIN_ID=admin`, `LOGIN_BASE_URL=http://127.0.0.1:3000`
- 다른 계정/URL 예시:

```bash
LOGIN_ID=seoul_manager LOGIN_PASSWORD='Manager!2345' LOGIN_BASE_URL='http://127.0.0.1:3000' npm run check:login
```

관리자/지사장/고객사 3계정을 한 번에 점검하려면 아래 명령을 사용합니다.

```bash
npm run check:login:all
```

배포 전 사전 점검 게이트(Preflight)는 아래 명령으로 실행합니다.

```bash
npm run check:preflight
```

- `check:preflight` 기본 실행에는 rate limit 대응 재시도 정책이 포함되어 있습니다.
  - `PREFLIGHT_RETRY_ON_429=true`
  - `PREFLIGHT_MAX_RETRIES=1`
  - `PREFLIGHT_RETRY_BASE_MS=1000`
  - `PREFLIGHT_RETRY_MAX_MS=900000`

- 현재 preflight는 다중 계정 로그인 검증 + 기본 헬스체크(`/login`=200, `/`=302, `/orders`=302)를 수행합니다.
- `PREFLIGHT_REPORT_PATH`를 지정하면 JSON 결과 리포트를 파일로 저장합니다.
- `PREFLIGHT_SUMMARY_PATH`를 지정하면 Markdown 요약 파일을 저장합니다(실패 항목 섹션 포함).
- 각 체크 결과에 응답 시간(`durationMs`)이 기록됩니다.
- 429(rate limit) 발생 시 기본 재시도/backoff가 동작합니다.
  - `PREFLIGHT_RETRY_ON_429` (기본 `true`)
  - `PREFLIGHT_MAX_RETRIES` (기본 `2`)
  - `PREFLIGHT_RETRY_BASE_MS` (기본 `250`)
  - `PREFLIGHT_RETRY_MAX_MS` (기본 `3000`)
- summary에는 rate limit 이벤트 섹션이 별도로 기록됩니다.
- GitHub Actions의 Playwright E2E 워크플로에서도 E2E 실행 전에 동일 preflight를 먼저 통과해야 다음 단계로 진행되며, 아티팩트로 `preflight-report`(JSON), `preflight-summary`(Markdown)가 업로드됩니다.

workflow_dispatch로 수동 실행 시에는 대상 URL/계정 ID를 입력값으로 바꿔 실행할 수 있습니다.

workflow_dispatch에서 비밀번호를 직접 입력할 수도 있으나, 기본 권장 경로는 repository secret(`LOGIN_PASSWORD_ADMIN`, `LOGIN_PASSWORD_BRANCH_MANAGER`, `LOGIN_PASSWORD_CLIENT`)입니다.

GitHub Actions에서 E2E를 실제로 돌리려면 아래 secrets가 필요합니다.

- `DATABASE_URL`: Supabase 연결 문자열
- `SESSION_SECRET`: 세션 암호화용 운영 값
- `LOGIN_PASSWORD_ADMIN`: 관리자 비밀번호
- `LOGIN_PASSWORD_BRANCH_MANAGER`: 지사장 비밀번호
- `LOGIN_PASSWORD_CLIENT`: 고객사 비밀번호

재실행 순서:

1. GitHub repository secrets에 위 값을 등록
2. `gh workflow run .github/workflows/playwright-e2e.yml -R kdrivekai9-code/b2b-car`
3. `gh run view <run-id>`로 상태 확인
4. `preflight-report` / `preflight-summary` artifact 확인

- 계정/비밀번호를 바꿔 테스트할 때:

```bash
LOGIN_ID_ADMIN='admin' LOGIN_PASSWORD_ADMIN='Admin!2345' \
LOGIN_ID_BRANCH_MANAGER='seoul_manager' LOGIN_PASSWORD_BRANCH_MANAGER='Manager!2345' \
LOGIN_ID_CLIENT='seoulmotors' LOGIN_PASSWORD_CLIENT='Client!2345' \
npm run check:login:all
```

AI 챗봇 주소 병합 E2E 테스트는 아래 명령으로 실행할 수 있습니다.

```bash
npm run e2e
```

> `npm run seed`는 users 테이블이 비어 있을 때만 동작합니다. 실제 운영 환경에서는 데모 계정을 그대로 두지 말고, 시드 이후 반드시 비밀번호를 변경하거나 계정을 삭제하세요.

## Vercel 배포
이 앱은 Vercel 서버리스 환경에서 실행되도록 구성되어 있습니다 (`api/index.js`가 진입점, `vercel.json`이 라우팅/정적 파일 포함 설정).

- 현재 운영 배포: https://b2bcarkr.vercel.app (Vercel 프로젝트: `kais-projects-cde97e56/b2b-car`)
- Production 환경변수(Vercel 대시보드 > Project Settings > Environment Variables에 설정됨):
  - `DATABASE_URL`: Supabase **Transaction pooler**(포트 6543, `?pgbouncer=true`) 연결 문자열. 서버리스는 요청마다 여러 함수 인스턴스가 동시에 뜰 수 있어 세션 모드(5432)보다 트랜잭션 모드가 적합합니다.
  - `SESSION_SECRET`: 로컬 `.env`와 별개로 생성한 운영 전용 값
  - `NODE_ENV=production`
- 재배포: `npx vercel --prod` (프로젝트 루트에서 실행, `vercel link`로 이미 연결되어 있음)
- 환경변수 변경: `npx vercel env add <NAME> production` (추가) / `npx vercel env rm <NAME> production` (삭제) 후 재배포 필요
- `db.js`는 `process.env.VERCEL` 존재 여부로 커넥션 풀 크기를 자동 조절합니다(서버리스: 인스턴스당 max 3, 로컬: max 10).

### Next.js 전환(Stage 1) 공존 구조
`docs/ai-stage-migration-workorder.md`의 Stage 1 착수 슬라이스(대시보드)가 같은 Vercel 프로젝트에 통합되어 있습니다.

- `vercel.json`에는 더 이상 전체 경로를 `/api/index`로 보내는 고정 rewrite가 없습니다 — 대신 `next.config.js`의 `rewrites().fallback`이 Next.js 자체 라우트(`app/`)나 정적파일로 못 찾는 모든 경로를 기존 Express 앱(`/api/index`)으로 흘려보냅니다. `/orders`, `/inquiries`, `/chat/sessions` 등 아직 안 옮긴 화면은 지금까지와 동일하게 Express가 처리합니다.
- `middleware.js`가 정확히 `/` 경로만 가로채, 환경변수 `NEXT_STAGE1_DASHBOARD_ENABLED`가 `'true'`가 아니면 기존 Express 대시보드로 그대로 리라이트합니다(기본값 OFF = 동작 무변화). `'true'`일 때만 `app/page.js`(React)가 응답합니다.
- `app/page.js`는 새 JSON 엔드포인트 `GET /dashboard/data.json`(`routes/dashboard.js`, 기존과 동일한 `requireAuth`/`scopeFilter` 적용)을 요청 쿠키를 그대로 실어 서버사이드에서 fetch합니다 — 세션/RBAC 검증 로직은 전부 기존 Express 코드 그대로이며 새로 구현하지 않았습니다.
- 롤백: Vercel 환경변수에서 `NEXT_STAGE1_DASHBOARD_ENABLED`를 `false`(또는 미설정)로 되돌리고 재배포하면 즉시 기존 EJS 대시보드로 복귀합니다. 코드 되돌림이 필요 없습니다.

## 데모 계정
| 역할 | 아이디 | 비밀번호 | 비고 |
|---|---|---|---|
| 관리자 | admin | Admin!2345 | 전체 지사/사용자/오더 관리 |
| 지사장 | seoul_manager | Manager!2345 | 서울지사 오더 조회 전용 |
| 고객사 | seoulmotors | Client!2345 | 서울모터스 그룹 오더 등록/조회 |

> 데모용 비밀번호입니다. 실제 배포 전 반드시 변경하세요.

## 폴더 구조
```
b2b-car/
  server.js                # 앱 진입점 (Express 설정, 세션 스토어, 라우트 마운트)
  db.js                    # PostgreSQL(Supabase) 커넥션 풀 + 쿼리 헬퍼
  seed.js                  # 데모 계정/샘플 데이터 시드 스크립트 (npm run seed)
  config.js                # 오더 상태값, 상태별 배지 색상 정의
  middleware/auth.js       # 인증/권한(RBAC) 미들웨어
  middleware/asyncHandler.js # async 라우트 핸들러 에러를 next(err)로 전달
  supabase/migrations/     # DB 스키마 마이그레이션 (SQL)
  routes/                  # auth, dashboard, branches, groups, users, orders
  views/                   # EJS 템플릿 (partials/header,footer 공통 레이아웃)
  public/css/              # 스타일시트
```

## 다음 단계 (Phase 2 이후 — 기획서 8절 로드맵 참조)
- 거리 기반 자동 요금 계산 엔진(지도 API 연동) — 현재는 수동 요금 입력만 지원
- 지사별 결제방식·운영시간·오더상태 커스터마이징 — 현재는 결제방식 마스터만 공통 적용
- 기사 사진 업로드(비로그인 링크), 사진 열람 권한 계층
- 브라우저 푸시 알림, AI 오더접수, 외부 플랫폼 연동 자동화

## 참고
- 데이터베이스는 Supabase(PostgreSQL)를 사용하며, 앱 서버는 PostgREST가 아닌 `pg` 드라이버로 DB에 직접 접속합니다. 이 때문에 모든 테이블에 RLS(Row Level Security)를 켜서 anon/authenticated 키로의 우회 접근을 차단해두었습니다(권한 검사는 Express 세션/RBAC 미들웨어가 담당).
- 배포 시 `SESSION_SECRET`을 반드시 운영용 값으로 설정하세요(미설정 시 `NODE_ENV=production`에서 서버가 기동을 거부합니다).
