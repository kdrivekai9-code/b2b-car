# AI 챗봇 — EJS와 Next 이식본의 격차

**작성 2026-09-08.** `NEXT_STAGE3_AI_INTAKE_ENABLED`를 켤 수 있는지 판단하기 위한 목록이다.

## 왜 이 문서가 있나

두 가지가 겹쳐서 아무도 이 격차를 몰랐다.

1. **그 플래그는 만들어진 뒤로 한 번도 효과가 없었다.** `src/proxy.js`의 `/orders/:id` 블록이
   `/orders/ai-intake`를 먼저 잡고, "ai-intake"는 숫자가 아니므로 무조건 Express로 보냈다.
   맨 아래 `PATH_FLAGS` 검사까지 도달하지 못했다. (커밋 `c3829bd`에서 고쳤고
   `scripts/check-proxy-named-paths.js`가 재발을 막는다.)
2. **프로덕션에서 이 화면만 EJS로 남아 있다.** 경로 20개 중 11개는 이미 Next다
   (`node scripts/check-prod-flags.js`). 처음에 "전부 EJS"라고 적었는데 그건 오측이었다 —
   그 도구가 HEAD로 찍고 있었고, `src/proxy.js` 첫 줄이 비-GET을 플래그와 무관하게 전부
   Express로 보낸다. GET으로 다시 재서 고쳤다.

그래서 "Next로 켠다"는 결정에 필요한 것이 이 격차 목록이다.

## 어떻게 재었나

재현 가능하게 두 가지를 대조했다.

- **API 표면** — 양쪽이 부르는 엔드포인트 목록
- **기능군** — EJS 쪽 함수 이름(약 170개)에서 기능 단위를 뽑아 Next에서 대표 키워드로 찾기

```bash
# 양쪽이 부르는 엔드포인트
grep -ohE "'/(chat|orders)/[a-z0-9/._?=-]*'" public/js/ai-intake*.js | tr -d "'" | sort -u
grep -ohE "'/(chat|orders)/[a-z0-9/._?=-]*'" src/app/orders/ai-intake/*.js | tr -d "'" | sort -u

# 규모
wc -l public/js/ai-intake*.js src/app/orders/ai-intake/*.js
```

규모: EJS **5,422줄**(`ai-intake*.js` 5개) vs Next **1,871줄**(`ai-intake/*.js` 5개).
줄 수는 참고만 하면 된다 — 우측 오더 폼을 Next는 `/orders/new`의 `OrderForm`으로 재사용하므로
그만큼 짧다.

## 이미 된 것

대화의 **뼈대**는 옮겨져 있다. `/chat/` 하위 엔드포인트가 양쪽 동일하다.

| 항목 | 비고 |
|---|---|
| 대화 주고받기 | `user-message`, `bot-message`, `intake-turn` |
| SSE 실시간 수신 | `/chat/:id/stream` |
| 주소 후보 명확화 | 여러 곳으로 검색될 때 번호로 고르기 |
| 상담원 연결 | 요청 처리 |
| 배차 도우미(MCP) | `dispatch-agent`, `dispatch-delay-check` |
| 최근 항목 / 검색 / 삭제 | 2026-09-08 이식(`ChatHistoryMenu.js`) |
| 안읽음 배지 | 2026-09-08 |

**우측 오더 폼은 격차가 아니다.** Next는 `OrderForm`을 그대로 재사용하고, 확인해보니 요금
미리보기·등록 전 확인·예약기준(즉시/픽업/도착)·픽업 예상시각·즐겨찾기 주소·주소 후보 검색·
경유지·부대비용·지도/경로·차종 추천이 모두 그 컴포넌트에 있다. 단 그쪽은 별도 플래그
(`NEXT_STAGE2_ORDER_FORM_ENABLED`)로 게이팅되므로, 챗봇을 켜려면 그 폼도 함께 켜야 한다.

## 먼저 알아야 할 변수 — 서버 턴 플래그

`AI_INTAKE_SERVER_TURN_ENABLED`가 이 격차의 크기를 바꾼다. **지금은 `0`(꺼짐)이다.**

- **꺼져 있으면**: 대화 판단을 클라이언트가 orchestration한다. EJS는 그 코드를 다 갖고 있고
  Next는 일부만 갖고 있다 — 격차가 여기서 나온다.
- **켜면**: 판단이 서버(`lib/webIntakeTurn.js`)로 넘어가고 클라이언트는 얇아진다. 아래 격차 중
  상당수가 저절로 메워진다.

**다만 프리미엄/일일기사는 안 메워진다.** EJS가 서버 턴에서 그 카테고리를 일부러 제외하기
때문이다(`orderCategory !== 'premium' && orderCategory !== 'daily_driver'`). 그 흐름은 양쪽 다
클라이언트가 들고 있고, Next에는 그 코드가 없다.

그래서 순서를 정할 때 이 플래그를 먼저 검토해야 한다 — 켜면 남는 격차가 훨씬 작아진다.

## 남은 격차

`○` 켜기 전 필수 · `△` 켠 뒤 곧 · `–` 나중에 (또는 안 해도 됨)

| | 항목 | 무엇이 없나 | 없으면 |
|---|---|---|---|
| ✔ | ~~요금 문의 흐름~~ | **2026-09-08 이식 완료 — 다만 방식이 다르다.** EJS는 이 흐름을 클라이언트에서 함수 32개·약 933줄로 한다. 그걸 옮기지 않고, 카카오가 이미 쓰는 서버 계산(`lib/agentAssist.js buildFareSuggestion`)을 엔드포인트(`POST /orders/ai-intake/fare-inquiry`)로 열어 Next가 부른다 — 옮기면 같은 계산이 세 벌이 된다.<br>**남은 차이: 여러 턴에 걸친 수집이 없다.** 출발·도착이 한 문장에 다 있으면 답하고, 없으면 기존 경로(FAQ → 상담원)로 넘어간다. EJS는 차종·경유지까지 되물어 모은다 — 그 부분은 아래 `△`로 내렸다 |
| ✔ | ~~프리미엄 / 일일기사 수집~~ | **2026-09-09 완료.** 카테고리 개념이 없어 대리·일일기사 요청도 **탁송 수집 흐름**을 탔다(도착지 연락처를 묻고, 이용형태·경유지·대기시간은 안 물었다). 수집 FSM은 서버에 이미 있었으므로(`lib/webIntakeTurn.js`) 옮기지 않고 그 대화를 서버가 이어받게 했다 — 전역 플래그와 무관하다. 오더구분·이용형태·경유지·대기시간은 `toIntakeFields`가 폼까지 나른다 |
| ✔ | ~~활동 핑~~ | **2026-09-08 이식 완료.** 입력할 때 15초 간격으로, 보낼 때는 간격 무시. EJS와 같은 값 |
| ✔ | ~~AI 연결 상태~~ | **2026-09-08 이식 완료.** 모델 상태를 앞세우고 SSE 끊김은 뒤에 덧붙인다(`AI 연결 정상 · 재연결중`). 실패하면 60초를 기다리지 않고 즉시 다시 확인 |
| ✔ | ~~요금 답변의 상품 구분~~ | **2026-09-08 완료.** 금액만 답했더니 고객이 "탁송요금이나요?"라고 되물었다 — 화면이 답해야 할 것을 고객이 물었다. 이제 질문에서 상품을 읽어(`askedProduct`) 탁송·프리미엄대리(편도 거리)·일일기사(이용 시간)를 갈라 답한다. 구분이 없으면 탁송으로 답하고 다른 상품을 함께 안내한다. 등록된 요금표가 없는 상품은 금액을 지어내지 않고 상담원 연결을 제안한다. `scripts/check-premium-oneway-fare.js`가 지킨다 |
| △ | **요금 문의의 여러 턴 수집** | 출발·도착이 한 문장에 없을 때 되물어 모으는 흐름(`askFareInquiryMissingField`, `handleFareInquiryPendingReply`, 차종·경유지 되묻기) | 구간을 나눠 말하는 고객은 요금을 못 받고 상담원으로 간다 |
| ✔ | ~~일일기사 시간 되묻기~~ | **2026-09-09 완료.** 시간을 되묻고 그 답으로 금액을 낸다(`awaitingHours`). 세 화면(서버·EJS·Next)이 같은 시간 정규식을 쓴다 |
| △ | **빠른 응답** | `aiQuickReplies` — 상황에 맞는 버튼(연락처 재사용 등) | 매번 직접 타이핑 |
| △ | **FAQ 응답** | `handleFaqIntent` — 접수가 아닌 질문을 지식베이스로 답하기 | 일반 질문이 상담원으로 넘어간다 |
| △ | **좌절 감지 → 상담원 제안** | `looksFrustrated`, `maybeOfferForFrustration` | 막힌 고객이 스스로 "상담원"이라고 쳐야 한다 |
| △ | **한 줄 요약** | `POST /orders/ai-intake/summary.json` — 접수 확인 요약(카카오와 같은 모듈) | 확인 문구가 채널마다 갈린다 |
| △ | **챗봇 안의 즐겨찾기 버튼** | 입력창 옆 `⭐`(`aiFavoriteBtn`) — 대화 중에 즐겨찾기 주소를 넣는다. `OrderForm`의 즐겨찾기와는 다른 자리다 | 대화로 접수할 때 주소를 매번 입력 |
| – | **타이핑 스트리밍 / 생각중 표시** | `streamPlainText`, `showThinkingBubble` | 답이 한 번에 나타난다(기능 손실은 없다) |
| – | ~~필드 정의 로드~~ | 격차 아님. Next는 `ORDER_FIELD_IDS`·`FIELD_KEYWORDS`·`PENDING_FIELD_PROMPTS`를 자기 파일에 갖고 있어 `fields.json`을 부를 필요가 없다 | — |
| – | **문의 기록 생성** | `createInquiryRecord`, `updateInquiryEstimate` — 요금 문의를 `inquiries`로 남긴다 | 요금 문의 통계가 안 쌓인다 |
| – | **제목의 `(Next)` 표식** | `🤖 AI 챗봇 + 👤 상담원 채팅 **(Next)**` | 개발 표식이 고객에게 보인다 — 켜기 전에 지울 것 |

## 판단

**필수 격차는 없다.** 2026-09-08에 셋을 채웠고(활동 핑, AI 연결 상태, 요금 문의),
2026-09-09에 마지막 하나(**프리미엄/일일기사 수집**)를 채웠다.

그 마지막 하나를 다시 재보니 앞서 적은 진단이 틀렸다. "서버 턴을 켜도 안 메워진다"고 썼는데,
수집 FSM은 서버에 **이미 있었다**(`lib/webIntakeTurn.js`의 `startPremiumIntake` /
`continuePremiumIntake`, 필드 정의는 `lib/intakeFields.js getDailyDriverFields`). Next가 그걸
안 부르고 있었을 뿐이다. 실제로 빠져 있던 것은 둘이었다:

- Next가 `proxy_order`/`daily_driver_order`를 **탁송 수집 흐름으로** 태웠다 — 도착지 연락처를
  묻고, 이용형태·경유지·대기시간은 아예 안 물은 채 탁송으로 등록됐다.
- `toIntakeFields`가 오더구분을 안 실어서, 서버가 일일기사로 처리해도 우측 폼과 상담관리
  카드는 **탁송으로** 보였다.

지금은 카테고리가 확정되면 그 대화를 서버 엔진이 이어받고(전역 플래그와 무관하다),
오더구분·이용형태·경유지·대기시간이 폼까지 간다. `scripts/check-daily-driver.js`가 지킨다.

**순서 제안**

1. **`AI_INTAKE_SERVER_TURN_ENABLED`를 먼저 켤지 정한다.** 켜면 **탁송** 대화 판단도 서버로
   가면서 두 클라이언트가 같은 판단을 쓰게 된다(지금은 각자 판단한다).
   프리미엄/일일기사는 이 플래그와 무관하게 이미 서버가 맡는다.
2. 필수 항목은 모두 채웠다 — `scripts/check-ai-intake-liveness.js`,
   `scripts/check-fare-inquiry-shared.js`, `scripts/check-daily-driver.js`가 지킨다.
3. `(Next)` 표식을 지운다.
4. `NEXT_STAGE2_ORDER_FORM_ENABLED`와 함께 켠다(폼이 없으면 접수를 끝낼 수 없다).
5. `node scripts/check-prod-flags.js`로 확인한다.
6. `△`는 켠 뒤에 채운다 — 없어도 대화가 막히지는 않는다.

## 다시 재는 방법

이 문서는 2026-09-08 기준이다. 코드가 움직이면 위 `grep` 두 줄과 아래로 다시 재면 된다.

```bash
# 프로덕션이 지금 무엇을 서비스하나
node scripts/check-prod-flags.js

# 프록시 플래그가 도달하는지 (:id 블록에 먹히는 경로가 없는지)
node scripts/check-proxy-named-paths.js
```

---

# 2026-09-11 전수 재점검

플래그를 켠 뒤 실사용에서 넷이 연달아 나왔다(좌우 배치, 진단 줄, 즉시 라디오, 새 채팅).
전부 **EJS에 있던 한 줄이 이식에서 빠진 것**이고 화면은 멀쩡히 떠서 오류로 안 잡혔다.
제보 단위로 고치는 속도로는 계속 나오므로 한 번에 훑었다.

## 어떻게 재었나

엔드포인트 호출 목록을 양쪽에서 뽑아 차집합을 냈다. 이름이 아니라 **서버와 주고받는 것**을
기준으로 보면 UI 구현 차이(React vs DOM id)에 속지 않는다.

```bash
grep -oE "'/[a-z0-9/_.:-]+'" public/js/ai-intake*.js | sed "s/.*'\(\/[^']*\)'/\1/" | sort -u > /tmp/ejs-ep.txt
grep -ohE "'/[a-z0-9/_.:-]+'" src/app/orders/ai-intake/*.js | sed "s/'\(\/[^']*\)'/\1/" | sort -u > /tmp/next-ep.txt
comm -23 /tmp/ejs-ep.txt /tmp/next-ep.txt   # EJS만 부르는 것 = 이식 누락 후보
```

## 찾은 것과 처리

| 항목 | 판정 | 처리 |
|---|---|---|
| **확인 요약이 네 번째 사본이었다** (`summary.json` 미호출) | 진짜 누락 | 고침 |
| **필수 항목 되묻기가 통째로 없었다** (`fields.json` 미호출) | 진짜 누락 | 고침 |
| **빠른 응답 칩** (`.ai-quick-replies`) | 진짜 누락 | 고침 |
| 챗봇 안 즐겨찾기 ⭐ (`aiFavoriteBtn`) | 진짜 누락 | **안 함** — 아래 참고 |
| 등록 직후 추가요청 (`/orders/:id/additional-request`) | 해당 없음 | Next 챗봇은 오더를 직접 등록하지 않는다 |
| 문의·견적 기록 (`/inquiries`, `/inquiries/:id/estimate`) | 의도된 이동 | 서버가 한 번에 넣는다(`lib/inquiryRecord.js`) |
| 오더 등록 (`POST /orders`) | 의도된 이동 | `OrderForm`이 제출한다 |

### 1. 확인 요약 — 네 번째 사본이었다

`lib/intakeSummary.js`는 **바로 이 문제 때문에** 만든 모듈이다(옵션(주유·서류)이 카카오 요약에만
들어가는 식으로 세 곳이 갈렸다). EJS 챗봇·카카오 등록 후 통보·상담원 초안이 그걸 같이 쓴다.
Next는 자기 파일 안에서 따로 만들고 있었다.

실측한 차이:

- **즉시 요청이 `2026-09-11 14:24`로 찍혔다.** 공용 모듈은 `즉시`로 보여준다 — 고객이 밝힌 건
  "즉시"인데 구체 시각이 보이면 그 시각을 콕 집어 요청한 것처럼 읽힌다(사용자 확정 2026-08-13).
- **경유지·기사전달사항·업체전달사항이 통째로 빠졌다.**
- 연락처가 주소 옆 괄호로 붙지 않았다.

이제 `POST /orders/ai-intake/summary.json`을 부른다. 느리거나 실패하면 기존 로컬 계산으로
넘어간다(EJS와 같은 2초 제한) — 이 시점엔 이미 confirming이라 요약이 늦으면 "네"가 먼저 온다.

### 2. 필수 항목 되묻기 — 없었다

이 문서는 2026-09-08에 "필드 정의 로드는 **격차 아님**"이라고 적었다. **틀렸다.** Next가
`ORDER_FIELD_IDS`를 갖고 있는 건 맞지만 그건 *파싱 결과에서 복사할 키 목록*이고, *무엇이
필수인지*와는 다른 것이었다. 실제로 Next는 **필수 항목이 비어도 묻지 않고** 바로 확인
단계로 갔다.

실측: 주소·연락처 넷이 빈 채로 파싱됐는데 그대로 "위 내용으로 등록할까요?"까지 갔다.
고객이 "네"라고 답해도 폼은 필수값이 비어 저장이 막힌다.

이제 `GET /orders/ai-intake/fields.json`으로 항목과 순서를 받고(실패하면 폴백 목록),
빠진 것을 서버가 정한 문구 그대로 하나씩 묻는다.

### 3. 빠른 응답 칩

연락처를 되물을 때 한 번 눌러 답하는 칩이다. 원래는 편의 기능이었는데 아래 4번 때문에
**우회로**가 됐다 — 칩은 모델을 안 거치고 값을 그대로 넣는다.

`qa_test_bot`은 전화번호가 비어 있어 "요청자(본인) 연락처와 동일" 칩은 안 뜬다(정상).

### 4. 이식 누락이 아닌 것 — 되묻기 답변을 못 알아듣는다

`/orders/ai-intake/parse`에 `pendingField`를 같이 보내도, 맨 주소·연락처 한 줄로 온 답을
`proxy_order`로 분류하고 값을 비운 채 돌려준다.

```
pendingField=origin_address       "경기 성남시 분당구 판교역로 166"  → intent=proxy_order origin_address=""
pendingField=origin_contact       "010-1111-2222"                  → intent=proxy_order origin_contact=null
pendingField=destination_contact  "010-3333-4444"                  → intent=proxy_order destination_contact=null
```

**EJS도 똑같이 실패한다.** 같은 대화를 :3000(EJS)과 :3001(Next)에서 나란히 돌려 확인했다 —
양쪽 다 3턴이면 "상담원 연결을 해드릴까요?"로 밀린다. 즉 이건 Next 이식 문제가 아니라
**두 채널 공통 결함**이고, 지금 실고객에게도 일어나고 있을 것이다. 별도 건으로 다뤄야 한다.

### 5. 안 한 것 — 챗봇 안 즐겨찾기 ⭐

Next의 `AddressField`가 칸마다 즐겨찾기 목록을 이미 갖고 있어(오른쪽 폼에서 바로 고를 수
있다) **능력이 없는 게 아니라 편의가 없는** 쪽이다. 대화로 주소를 답할 때 쓸 수 없다는
차이만 남는다. 4번을 먼저 해결하면 이 버튼의 필요가 줄어들 수 있어 그 뒤에 판단한다.

## 지키는 것

- `scripts/check-ai-intake-layout.js` — 좌우 배치, 진단 줄, "새 채팅"이 세션을 닫는지
- `scripts/check-reservation-basis.js` — 예약 기준이 폼 라디오까지 가는지
- `scripts/check-ai-intake-parity.js` — 이번 점검 항목(요약·필수 항목·빠른 응답)과
  **엔드포인트 차집합**. 새 엔드포인트가 EJS에만 생기면 잡는다
