# 카카오 상담톡 접수 자동화(Phase 1) — 적용 순서

기획서 `docs/kakao-chatbot-upgrade-plan.html`의 Phase 1 구현분을 실제로 켜는 절차다.
**코드를 배포해도 자동 등록은 켜지지 않는다** — 아래 2단계(매핑 행 추가)를 하기 전까지는
파싱 결과를 상담원에게 넘기기만 한다. 의도된 안전장치다.

## 1. 마이그레이션 실행

Supabase SQL 편집기에서 `supabase/migrations/20260807040000_add_kakao_intake_automation.sql`을
실행한다. 추가되는 것:

- `kakao_consult_accounts` — 상담톡 채널 → b2b-car 계정·지사·그룹·결제수단 매핑
- `chat_sessions.intake_slots_json`, `intake_updated_at` — 되묻기 상태(30분 TTL)
- `orders.chat_session_id`, `orders.source_channel` — 어느 상담 세션에서 접수됐는지(Phase 2 통보의 역방향 경로)

마이그레이션 전에도 코드는 동작한다. `intake_slots_json`이 없으면 되묻기 상태 저장만 조용히
실패하고(로그만 남음), 오더 insert는 실패해서 상담원 인계로 떨어진다.

## 2. 채널 매핑 추가 — 여기서부터 자동 등록

```sql
insert into kakao_consult_accounts
  (service_key, external_user_key, label, user_id, branch_id, requester_group_id, payment_method_id, auto_register, enabled)
values
  ('<상담톡 serviceKey>', null, '핸들모빌리티 탁송', <users.id>, <branches.id>, <groups_tbl.id>, <payment_methods.id>, false, true);
```

- `service_key`만 넣으면 그 채널 전체, `external_user_key`까지 넣으면 그 고객만 적용된다
  (좁은 조건이 먼저 매칭된다).
- **`auto_register`는 false로 시작할 것.** 이 상태에서는 폼을 파싱해 상담원에게 구조화된
  내용을 넘기기만 한다. 상담원 화면에 뜨는 `[자동 파싱]` 메모가 실제 접수 내용과 일치하는지
  며칠 지켜본 뒤 true로 바꾸는 순서를 권장한다.
- `branch_id`는 콜마너 `providerId`가 되는 지사다. 그 지사의 `callmaner_enabled`가 꺼져 있으면
  오더는 만들어지되 콜마너로는 나가지 않는다.

`auto_register = true`로 바꾸면 그 시점부터 접수 폼이 오더 + 콜마너 접수까지 자동으로 간다.
콜마너 쪽 상태는 항상 **대기(5)** 로 등록되므로(lib/callmaner.js) 담당자 검토 전에 배차되지 않는다.

## 3. 켜기 전 확인 (DB·콜마너를 건드리지 않는 검사)

원본 상담톡 로그를 `docs/kakao-log-analysis/parse_log.py`로 구조화한 뒤:

```bash
node scripts/check-kakao-intake-parser.js  <msgs.json>      # 필수 4종 추출률 (기준 95%)
node scripts/check-kakao-intake-geocode.js <msgs.json> 40   # 주소 → 좌표·행정구역 성공률
node scripts/check-kakao-intake-preview.js <msgs.json> 6    # 고객에게 나갈 확인 메시지 미리보기
```

2026-08-07 기준 실측: 필수 4종 추출 **98.2%**(1,412건), 지오코딩 **92.5%**(서로 다른 주소 40개 표본).
지오코딩에 실패한 주소는 오더를 만들지 않고 상담원에게 넘어간다.

## 동작 요약

| 들어온 메시지 | 봇의 행동 |
|---|---|
| 접수 폼 (필수 4종 충족) + 매핑 있고 `auto_register` | 오더 생성 → 콜마너 접수 → 접수번호·내용 요약 회신 |
| 접수 폼 (필수 항목 누락) | 부족한 항목만 되묻고 30분간 대기 → 보충 메시지가 오면 합쳐 재파싱 |
| 접수 폼 + 매핑 없음 / `auto_register` 꺼짐 | 파싱 결과를 `[자동 파싱]` 메모로 남기고 상담원 인계 |
| 지오코딩 실패, 운영시간 밖 | 오더 만들지 않고 사유와 함께 상담원 인계 |
| 사고·파손·클레임 단어 포함 | 봇이 답하지 않고 즉시 상담원 인계 |
| "네", "감사합니다" 단독 | 응답하지 않음 |
| 그 외 | 기존 경로(LLM 의도 분류 → FAQ 또는 상담원 인계) |

## 코드 위치

| 파일 | 역할 |
|---|---|
| `lib/kakaoIntakeParser.js` | 접수 폼 파서(블록 폼 전용). 웹 화면용 `lib/aiIntakeParser.js`와 별개 |
| `lib/geocode.js` | 주소 → 좌표·행정구역. 콜마너 접수 필수값을 채운다 |
| `lib/kakaoIntakeService.js` | 매핑 조회, 오더 생성, 콜마너 접수, 확인 메시지 생성 |
| `lib/callmanerRegister.js` | 콜마너 오더접수. `routes/orders.js`에서 옮겨와 웹/카카오가 공유 |
| `routes/kakaoConsult.js` | 수신 웹훅. 폼 파서를 LLM 분류보다 먼저 태운다 |

## 아직 안 된 것

- **수신 웹훅 규격 미확인** — 중계서버가 우리 쪽으로 어떤 URL/헤더/바디로 넘겨주는지가 확정되지
  않아 실트래픽은 아직 들어오지 않는다(연동 계획서 8.1). 이 문서의 절차는 그 확인이 끝난 뒤에
  의미가 있다.
- Phase 2(배차·출발·도착 자동 통보), Phase 3(사진·주행거리 전달)은 미착수.
