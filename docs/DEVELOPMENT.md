# 개발 안내서

법인 고객을 위한 **탁송(차량 대리운송) 접수·배차·정산 플랫폼**입니다. 고객이 웹이나 카카오 상담톡으로
오더를 넣으면, 외부 배차 시스템 **콜마너**로 넘기고, 기사가 붙어 차를 옮기고, 사진과 영수증을 받아
정산까지 갑니다.

이 문서는 코드를 건드리기 전에 알아야 할 것만 모은 것입니다. 웹 버전(도표 포함):
<https://claude.ai/code/artifact/b2efe5d0-4efa-4d3c-9d00-d61d6776e199>

- [1. 개발 스택](#1-개발-스택)
- [2. 시스템 구성](#2-시스템-구성)
- [3. 저장소 구조](#3-저장소-구조)
- [4. DB 구조](#4-db-구조)
- [5. 도메인 용어](#5-도메인-용어)
- [6. 주요 흐름](#6-주요-흐름)
- [7. 로컬 환경](#7-로컬-환경)
- [8. 검사와 배포](#8-검사와-배포)
- [9. 반드시 알아야 할 함정](#9-반드시-알아야-할-함정)

---

## 1. 개발 스택

라이브러리를 거의 안 씁니다. 프레임워크 두 개와 표준 도구만 있습니다.

| 층 | 무엇 | 비고 |
|---|---|---|
| 서버 (신규) | `next@16.3` App Router | Vercel의 `framework: nextjs`. 배포의 정문 |
| 서버 (기존) | `express@4.19` + `ejs@3.1` | 원래 앱 전체. Vercel에서는 서버리스 함수 *하나* |
| 클라이언트 | `react@19.2` / 순수 브라우저 JS | Next 화면은 React, EJS 화면은 `public/js` 스크립트 20개. 번들러 없음 |
| 스타일 | CSS 한 장 | `public/css/style.css`(983줄)를 **양쪽이 공유**. Tailwind·CSS Module·CSS-in-JS 없음 |
| DB | PostgreSQL (Supabase) + `pg@8.13` | ORM 없음. `db.js`가 얇은 래퍼 |
| AI | Vertex AI (Gemini) | `lib/vertexAi.js`가 직접 REST 호출. SDK 없음 |
| 테스트 | Playwright + 자체 검사 스크립트 | `scripts/check-*.js` 102개 |
| 런타임 | Node 22 | Vercel 리전 `icn1`(서울) |

의존성이 적은 것은 의도입니다. 클라이언트 관련 패키지는 `next`·`react`·`react-dom` 셋뿐이고,
외부 스크립트는 카카오 지도 SDK 하나입니다. 새 라이브러리를 들이려면 그만한 이유가 필요합니다.

---

## 2. 시스템 구성

Next가 앞에 서고, 플래그가 꺼진 경로는 Express로 넘깁니다.

```
요청 (브라우저 · 카카오 웹훅 · Vercel 크론 · 콜마너 기사앱)
  │
  ▼
src/proxy.js            Next 16에서 Middleware가 "Proxy"로 개명된 파일.
  │                     경로별 NEXT_*_ENABLED 플래그를 요청 시점에 읽는다. 기본 전부 OFF.
  ├─ 플래그 ON  ──────▶ src/app/**            (Next이 처리)
  └─ 플래그 OFF ──────▶ rewrite → api/index.js → server.js  (Express + EJS)
                              │
                              ▼
                        PostgreSQL (Supabase) · 테이블 72개
```

외부 연동: 콜마너 배차 API, 콜마너 MCP, 카카오 상담톡, 카카오 지오코딩·길찾기,
Vertex AI(Gemini), FCM(기사 푸시), Web Push(VAPID), Supabase Storage.

Vercel 배포에서는 `/api/index`로 rewrite되고, 그 특수 동작 덕에 원본 경로·쿼리가 유지된 채
Express 함수로 디스패치됩니다. 로컬에는 그 동작이 없어 `http://localhost:3000`으로 절대 URL
리라이트합니다 — 그래서 로컬은 서버가 **두 개**입니다.

**왜 `src/` 안에 있나.** 그 디렉터리만 자체 `package.json`(`"type": "module"`)을 가질 수 있어서,
저장소 루트의 `"type": "commonjs"`(Express 앱 전체가 의존)를 건드리지 않고 proxy가 ESM `export`를
쓸 수 있습니다. `config.matcher` 정적 분석에 ESM이 필요합니다.

배포는 Vercel 크론 7개도 함께 돌립니다 — 매분(콜마너 동기화·상담톡 통보·상담 제안),
5분(헬스·장애 점검), 30분(사진 가용성), 매일 18:20(접속기록 보관).

---

## 3. 저장소 구조

| 경로 | 무엇 |
|---|---|
| `server.js` | Express 앱 조립 — 미들웨어와 라우터 마운트가 전부 여기. `api/index.js`는 이 파일을 `require`하는 한 줄 |
| `src/proxy.js` | Next / Express 분기. 플래그 지도 |
| `src/app/**` | Next App Router 화면. 파일 75개 중 29개가 `'use client'`. 화면별 `_components/`가 4곳 |
| `routes/` | Express 라우터 32개. HTTP 처리와 권한 판정 |
| `lib/` | **도메인 로직 77개 모듈.** 요금 계산, 콜마너 연동, 메모 분할, AI 호출, 알림. 새 기능은 대개 여기 붙는다 |
| `views/` | EJS 템플릿. `views/partials/`가 공용 조각 |
| `public/js/`, `public/css/` | EJS 화면용 클라이언트 자산. 빌드 단계 없음 |
| `db.js` | pg 풀 래퍼. `run`/`get`/`all` |
| `supabase/migrations/` | SQL 마이그레이션 105개. **자동 적용되지 않는다** |
| `supabase/manual/` | 일회성 데이터 정리 SQL. 마이그레이션이 아니라 따로 둔다 |
| `scripts/` | 검사 102개 + 운영 도구(쓸기, 배포 확인, 비밀번호 대조) |
| `tests/manual/` | Playwright 스펙. 계정은 `tests/e2e-credentials.js` 하나만 본다 |
| `docs/` | 설계·체크리스트와 **외부 API 스펙**(콜마너·카카오 상담톡). 연동을 건드리기 전에 확인 |

> **프로덕션은 지금 모든 화면이 EJS다**(2026-09-08 확인 — 경로 20개 전수, Next 0개).
> `NEXT_*` 플래그가 로컬에는 26개 켜져 있지만 프로덕션에는 반영돼 있지 않다. 의도한 것이
> 아니어서 단계적으로 켜는 중이다. 지금 무엇이 서비스되는지는 `node scripts/check-prod-flags.js`로
> 확인한다. AI 챗봇 화면은 이식 격차가 남아 보류 중이다 — [ai-intake-next-gap.md](ai-intake-next-gap.md).

### db.js 규약

`?` 플레이스홀더를 쓰면 내부에서 `$1, $2 …`로 바꿔줍니다(SQLite에서 옮겨온 흔적).
`run()`은 `RETURNING id`와 함께 쓰면 `lastInsertRowid`를 돌려줍니다. 읽기 질의는 커넥션이
죽었을 때 한 번 재시도하고, 풀 고갈은 따로 경고를 찍습니다.

```js
const db = require('./db');
await db.all('SELECT * FROM orders WHERE branch_id = ?', [branchId]);
const r = await db.run('INSERT INTO orders (...) VALUES (?, ?) RETURNING id', [a, b]);
r.lastInsertRowid  // 새 오더 id
```

> **db.js는 모듈 로드 시점에 던집니다.** `DATABASE_URL`이 없으면 질의를 한 줄도 안 하는 코드까지
> 같이 죽습니다. CI에서 검사 24개가 한꺼번에 죽은 원인이 이것이었습니다.

---

## 4. DB 구조

테이블 72개. 축은 여섯 개입니다.

| 테이블 | 역할 | 참조하는 곳 |
|---|---|---|
| `branches` | 지사. 요금표·운영시간·결제수단이 모두 지사 단위로 갈린다 | 23 |
| `users` | 계정. `role`은 `admin` / `branch_manager` / `client` | 23 |
| `groups_tbl` | 법인 고객사. 자기참조(`parent_group_id`)로 계층 | 15 |
| `orders` | 오더. **93개 컬럼** | 12 |
| `drivers` | 기사. 콜마너 사번(`callmaner_sabun`)으로 이어진다 | 6 |
| `chat_sessions` | 상담 세션. `channel`은 `web` / `kakao` / `driver` | 5 |

### orders 93개 컬럼 — 무리별로

| 무리 | 수 | 대표 컬럼 |
|---|---|---|
| 주소·좌표 | 19 | `origin_address`, `destination_lat`, `origin_sido/sigugun/dong` — 콜마너 접수에 좌표와 행정구역이 필수 |
| 요금·정산 | 12 | `fare_amount`, `ferry_fare_amount`, `dispatch_fare_amount`, `settled_at` |
| 콜마너 | 9 | `callmaner_conf_slip`(접수번호), `callmaner_status`, `callmaner_synced_at`, `callmaner_last_error` |
| 차량 | 9 | `vehicle_number`, `odometer_start/end`, `plate_check_status` |
| 메모 | 7 | `memo_customer`(고객 원문), `memo_driver_brief`(적요1용 요약), `memo_billing`, `memo_driver_chat` |
| 예약·시간 | 6 | `reserved_date/time`(= **픽업** 시각), `delivery_reserved_*`(고객이 말한 도착 시각) |
| 상태·담당 | 6 | `status`, `assigned_driver_id`, `source_channel`, `chat_session_id` |
| 사진·토큰 | 4 | `photo_upload_token`, `receipt_upload_token`, `tracking_token` — 로그인 없이 여는 링크의 근거 |
| 기타 | 17 | `order_type`(`dispatch`/`premium`), `split_group_id`(분할 접수), `postal_requested`, VOC 메모 3개 |

> **오더 상태값은 한글입니다.** `오더등록` · `대기` · `예약` · `기사배정` · `완료` · `취소`.
> 영문으로 짐작해 `WHERE status NOT IN ('completed','cancelled')`처럼 쓰면 *아무것도 걸러지지 않습니다.*

### 오더에 딸린 것들

- `order_status_history` — 상태 변경 이력. 되돌릴 근거가 여기 남는다
- `order_extra_charges` — 부대비용(주유·세차·주차·통행료…). 영수증은 `chat_message_id`로 이어진다
- `order_legs` — 구간 릴레이. 한 오더를 기사 여럿이 이어 달릴 때의 구간
- `order_waypoints` · `order_photos` · `order_callmaner_photos` · `order_receipts`

### 요금 체계 — 여기가 가장 복잡합니다

요금 규칙 테이블이 지사 단위와 법인 단위로 **쌍을 이룹니다**: `fare_rules` / `group_fare_rules`,
`fare_extra_settings`(44컬럼) / `group_fare_extra_settings`(42컬럼). 법인 설정이 있으면 그것이
지사 설정을 덮습니다 — 판정은 `lib/branchPolicy.js`에 모여 있습니다. 거리·지역 할증은
`group_office_zone_fares`(1,176행), 도선료는 `ferry_fare_rules`가 담당합니다.

### 마이그레이션 정책

> **마이그레이션은 자동 적용되지 않습니다.** 배포는 코드만 나갑니다. SQL은 사람이 Supabase에서
> *먼저* 돌립니다. 그래서 관례가 하나 있습니다 — 새 컬럼을 읽는 코드는 `42703`(undefined column)을
> 잡아 폴백해야 합니다. 그러지 않으면 마이그레이션 전에 화면이 통째로 죽습니다.
> `node scripts/check-migrations.js`로 대기 목록을 봅니다.

---

## 5. 도메인 용어

코드와 화면에 그대로 나오는 말들입니다. 이걸 모르면 변수명이 안 읽힙니다.

| 용어 | 뜻 |
|---|---|
| 탁송 | 차를 사람이 운전해 옮기는 일. 이 서비스의 본체 |
| 오더 / OID | 접수 한 건. 표시용 번호는 `OID + (1000 + id)`로 **서버가 붙인다** — 직접 넘긴 값은 무시된다 |
| 콜마너 | 실제 배차를 담당하는 **외부** 시스템. 오더를 보내고 상태를 받아온다. 기사 앱도 콜마너 것 |
| 접수번호 | 콜마너가 발급하는 번호(`callmaner_conf_slip`). 이 값이 있으면 배차 시스템에 올라간 것 |
| 적요1 | 콜마너로 보내는 기사 전달 메모. **100바이트** 상한이고 맨 앞에 차량번호가 붙는다. 기사가 읽는 유일한 칸 |
| 대기 / 접수 | 고객이 넣은 오더는 콜마너에 `대기`로 들어간다. 관리자가 확정해야 기사에게 가는 상태로 바뀐다 |
| 부대비용 | 주유·세차·주차·통행료처럼 운송료 외에 드는 돈. 확정 금액인 것과 **실비 정산**인 것이 갈린다 |
| 실비 정산 | 금액이 미리 안 정해져 영수증으로 청구하는 방식. 그래서 기사에게 영수증 업로드를 요청한다 |
| 도선료 | 배(페리) 요금. 별도 테이블과 `orders.ferry_fare_amount` 칸을 쓴다 |
| 지사 (branch) | 우리 쪽 조직 단위. 요금표와 운영시간의 기준 |
| 법인 (group) | 고객사. `groups_tbl`. 계정(`users.group_id`)이 여기 소속된다 |
| 본사 직원 / 개인 딜러 | `users.client_type`이 `hq`면 법인 전체를, `dealer`면 **자기 것만** 본다. 판정은 `lib/clientScope.js` |
| 상담톡 | 카카오 채널 상담. 고객이 채팅으로 접수하는 경로이고 웹훅으로 들어온다 |
| 구간 릴레이 | 한 오더를 기사 여럿이 이어 운행하는 것. `order_legs` |
| 프리미엄 | `order_type = 'premium'`. 일반 `dispatch`와 접수 흐름·요금 규칙이 다르다 |

---

## 6. 주요 흐름

### 접수 — 경로가 넷입니다

같은 오더 생성이 네 군데서 시작됩니다. 하나만 고치면 나머지 셋이 빠집니다.

| 경로 | 진입 |
|---|---|
| 웹 접수 폼 | `routes/orders.js` |
| 웹 챗봇 (AI 접수) | `lib/webPremiumIntakeService.js` |
| 카카오 상담톡 | `lib/kakaoIntakeService.js` |
| 문의 → 오더 전환 | `routes/inquiries.js` |

**공통 로직은 `lib/orderCreate.js`에 둡니다.** 네 경로가 모두 그 함수를 부르므로, "접수할 때 항상
일어나야 하는 일"은 여기 붙이면 한 번에 적용됩니다. 실제로 요청사항 분석·우편발송 감지가
그렇게 들어가 있습니다.

### 콜마너 동기화

매분 크론(`/callmaner/sync`)이 오더를 콜마너로 보내고 상태를 받아옵니다. 접수에 **좌표와 행정구역이
없으면 전송 자체가 불가능**합니다. 전송이 실패하면 `callmaner_last_error`가 남고, 관리자 오더
목록에 빨간 `?`로 표시됩니다. API 스펙은 `docs/callmaner-external-api-*`를 보세요.

### 기사 채널

기사는 콜마너 앱을 씁니다. 우리 쪽은 서명 토큰(`lib/driverToken.js`, HMAC-SHA256)으로 여는
모바일 채팅 화면(`/driver/chat`)을 제공해 **부대비용 옵션 전달과 영수증 수집**을 합니다.
푸시는 FCM(`lib/driverPush.js`)이고, 배차·알림톡은 콜마너 것을 그대로 씁니다.

### AI가 쓰이는 곳

모두 `lib/vertexAi.js` 하나를 지납니다 — `generateJson`, `generateJsonWithImages`,
`generateWithTools`, `embedText`. 쓰이는 자리: 챗봇 접수, 요청사항 → 기사메모/업체전달사항 분할,
부대비용 감지, 영수증·계기판·번호판 OCR, FAQ 검색, 상담 도우미, 배차 주문 도우미(MCP 도구 호출).

> **`lib/vertexAi.js`는 Edge Runtime에서 못 돕니다.** Node `crypto`로 JWT를 서명하기 때문입니다.
> 이 모듈을 타는 라우트는 Node 서버리스로 유지해야 합니다.

---

## 7. 로컬 환경

```bash
git clone git@github.com:kdrivekai9-code/b2b-car.git
npm ci
cp .env.example .env      # 키 38개. 값은 팀에서 받으세요
npm run dev:all           # Express :3000 + next dev :3001 동시 기동
```

| 명령 | 무엇 |
|---|---|
| `npm run dev` | Express만 (`:3000`) |
| `npm run dev:next` | Next만 (`:3001`) |
| `npm run dev:all` | 둘 다 — 보통 이걸 쓴다 |
| `npm run verify` | CI와 같은 검사 묶음 + Next 빌드 |
| `npm run e2e` | Playwright |
| `node scripts/check-migrations.js` | 미실행 마이그레이션 확인 |

> **로컬 `DATABASE_URL`이 운영 DB를 가리킵니다.** 별도 개발 DB가 없습니다. 그래서 로컬에서 돌린
> 코드가 *실제 고객에게 카카오톡을 보낼 수* 있고, 오래된 개발서버를 켜둔 채 두면 실고객이 옛 코드의
> 응답을 받습니다. 코드를 고쳤으면 `:3000`·`:3001`을 **둘 다** 재기동하세요. 재현 안 되는 사고는
> 프로세스 시작 시각부터 대조하는 것이 빠릅니다.

환경변수 이름은 `.env.example`에 다 있습니다(38개). 값은 저장소에 없습니다 — `DATABASE_URL`,
`SESSION_SECRET`, 콜마너 키 2개, 카카오 키, Vertex 서비스 계정, FCM 3개, `DRIVER_TOKEN_SECRET`,
`CRON_SECRET` 등입니다.

---

## 8. 검사와 배포

`main`에 푸시하면 Vercel이 곧바로 배포하고(30~60초), 그와 **독립적으로** GitHub Actions의 Verify가
돕니다(약 40초). 검사는 배포를 *막지 못합니다* — 대신 마지막 단계가 그 커밋의 배포가 실제로
`success`가 됐는지 확인해, "저장소는 끝났는데 프로덕션은 안 바뀐" 상태를 드러냅니다.

- PR을 안 씁니다. 작업은 `main`에 직푸시됩니다.
- 검사 102개 중 40개만 CI에 있습니다. 나머지는 운영 DB·모델·외부 키가 필요합니다.
- 롤백은 Vercel에서 이전 배포를 promote하거나 `NEXT_*` 플래그를 끕니다.
- 자동화는 **QA 전용 계정**만 씁니다(`qa_test_*`). 실사용 계정으로 로그인하면 단일 세션 때문에
  그 사람이 로그아웃됩니다.

자세한 구조: <https://claude.ai/code/artifact/1c16147e-31d2-41b5-9877-e2d8f9770293>

---

## 9. 반드시 알아야 할 함정

전부 실제로 사고가 났던 것들입니다.

### 공용 UI 조각이 두 벌 있습니다

같은 화면이 EJS와 Next 두 구현으로 존재할 수 있습니다. `views/partials/*.ejs`만 고치면 부족합니다 —
`src/app/**/_components/`에 포팅된 쌍둥이가 있는지 같이 봐야 합니다. 고객용·관리자용이 또 갈립니다.
고객 화면에 관리자용 칸이 새어 나온 일이 실제로 있었습니다.

### 오더 상태값은 한글입니다

`'completed'`·`'cancelled'`로 쓰면 조건이 아무것도 걸러내지 않고 조용히 통과합니다.
`'완료'`·`'취소'`입니다.

### oid는 서버가 덮어씁니다

`createOrder()`에 `oid`를 넘겨도 `'OID' + (1000 + id)`로 바뀝니다(`lib/orderCreate.js`). 그걸 모르고
`oid LIKE 'MARK%'`로 자기 시험 데이터를 정리하던 검사가 한 건도 못 지우고 22건을 쌓았습니다.

### 테스트가 운영 DB에 씁니다

시험 데이터는 존재하지 않는 도로명 `검사로`를 표식으로 씁니다. 각 검사가 끝에 자기 것을 지우지만,
중간에 죽으면 정리에 못 닿습니다. 그래서 워크플로가 **테스트 시작 전에**도 쓸어냅니다
(`scripts/clean-test-orders.js`, `scripts/clean-test-chat-sessions.js` — 기본은 미리보기, `--apply`로 실행).

범위 없는 `DELETE`를 절대 쓰지 마세요. 조건 없는 `DELETE FROM chat_sessions` 한 줄이 실고객
상담톡까지 지우고 있었습니다.

### 적요1은 100바이트에서 말없이 잘립니다

기사에게 가는 유일한 칸인데, 넘치면 뒤가 사라지고 쓴 사람은 다 갔다고 믿습니다. 실측으로 기사 메모의
24%가 예산을 넘겼습니다. 예산 계산은 `lib/memoBudget.js`와 `lib/intakeMemoSplit.js`가 **같은 값**을
내야 합니다.

### Next 16은 알던 Next가 아닙니다

Middleware가 `proxy.js`로 개명된 것이 한 예입니다. 코드를 쓰기 전에 `node_modules/next/dist/docs/`의
해당 문서를 읽으라고 `AGENTS.md`가 못 박아 뒀습니다.

### DATABASE_URL은 Transaction Pooler여야 합니다

포트 `6543`입니다. Session Pooler(`5432`)를 쓰면 서버리스에서 커넥션이 말라
*Connection terminated due to connection timeout*이 납니다.

### 응답 뒤에 할 일은 waitUntil로

서버리스는 응답을 보내면 함수가 얼어붙습니다. 분석·통보처럼 응답 뒤에 돌 일은
`lib/afterResponse.js`의 `runAfterResponse()`로 넘겨야 실제로 끝까지 돕니다.
