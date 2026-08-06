# 콜마너 외부연동 API 메모

「콜마너 외부연동 인터페이스 정의서」(구글시트, 시트 4개: 변경이력 / 인터페이스정의 및 목록 /
인터페이스상세 / 오류코드)를 읽고 정리한 것과, 실제 호출로 확인한 차이점을 남긴다.
정의서 파일 자체는 저장소에 없어서 `lib/callmaner.js`가 인용하는 절 번호를 대조하려면 원본이 필요하다.

- 서비스 URL: `https://{host}/external_v1/{servlet}.do?t={JSON}` (수도권 `api.cd1.kr:8443`,
  지방권 `api.cd2.kr:8443`, 테스트 `alpha-api.cd1.kr:8443`)
- 업체ID(`providerId`) = `{지사코드}-{대표번호}-{관련어플코드}` (예: `B100-16886618-CC123456`)
- 정의서 "바. 공통 주의사항": 본사코드/지사코드/대표번호/접수상태는 **콜마너 서버 설정으로 관리**하며
  오더 최초 등록 상태는 "접수"다.

## 인터페이스 목록 (정의서 "사")

| # | 전문명 | cmd | servlet |
|---|---|---|---|
| 1 | 오더접수 | `OrderReceipt` | order.do |
| 2 | 오더수정 | `OrderModify` | order.do |
| 3 | 오더상세조회 | `OrderInfo` | order.do |
| 4 | **오더리스트조회** | **`OrderHistory`** | order.do |
| 5 | 오더취소 | `OrderCancel` | order.do |
| 6 | 오더상태조회 | `OrderStatus` | order.do |
| 7 | 요금조회 | `ChargeSearch` | charge.do |
| 8 | 좌표POI조회 | `LocationXySearch` | location.do |
| 9 | 텍스트POI조회 | `LocationTextSearch` | location.do |
| 10 | 경로탐색 | `RouteSearch` | rsearch.do |
| 11 | 전체오더상태조회 | `OrderAllStatus` | order.do |
| 12~15 | 마일리지 조회/결제/적립/내역 | `Mileage*` | mileage.do |
| 16~20 | 기사연락처조회 / 완료오더조회 / 타사 배차·해제 / 탁송사진 이미지 / 배차기사 현위치 | (목록에 영문명 비어 있음) | — |

16번 기사연락처조회는 목록에 영문명이 없지만 실제로는 `WkContactSearch`로 동작한다(`lib/callmaner.js`).

## 상태 폴링 — 왜 OrderAllStatus를 쓰지 않는가

`OrderAllStatus` 요청 파라미터는 **`userHp`(요청단말번호, 필수) / `providerId` / `lastUpDate`** 뿐이다
(정의서 확인 — 조회 범위를 넓히는 추가 파라미터는 없다). 우리는 이 셋을 스펙대로 보내고 있는데도
쓸 수가 없다. 실측으로 확인한 문제 두 가지:

1. **OrderReceipt로 접수한 건이 목록에 나오지 않는다.** 같은 `userHp`(01081161240)로 조회했을 때
   MCP(`call.create`)로 접수한 건 5개는 나오는데 `OrderReceipt`로 접수한 179098847은 빠진다.
2. **`status_code`가 빈 문자열로 온다.** 정의서상 필수(●) 항목이고 코드표(00 문의 / 01 접수 /
   02 배차 / 03 타사배차 / 04 강제 / 05 대기 / 06 예약 / 07 완료 / 08 예약배차)까지 정의돼 있는데도
   실제 응답은 `status="취소", status_code=""`다.

여기에 더해, 우리가 `userHp`로 지사 대표번호(`branches.main_phone`)를 보내고 있었던 문제도 있었다 —
서울지사는 그 값이 `"12345"`라 어떤 고객의 번호도 아니어서 조회 결과가 **항상 0건**이었다.
접수(`OrderReceipt`)는 출발지 연락처를 `userHp`로 보내는데 상태조회만 대표번호를 보내던 불일치였다.

## 현재 동기화 방식 (routes/callmanerSync.js)

연락처 단위 **목록조회(`OrderHistory`)** → 목록에서 못 찾은 건만 **단건조회(`OrderInfo`)** 로 보완.

`OrderHistory` 사용 시 실제 응답이 정의서와 다른 점:

| 항목 | 정의서 | 실제 |
|---|---|---|
| 페이지 파라미터 | `page` / `page_size` | 같음. **`pageSize`로 보내면 무시되고 1건만 온다** |
| 목록 필드명 | (정의서 표기는 `orderList` 계열) | **`rs.data`** |
| 상태 | `{접수,배차,완료,취소,대기 등}` | 같음 — 한글 문자열. `status_code`는 없음 |

그래서 상태 매핑은 코드가 아니라 한글 기준이다 → `lib/callmaner.js`의 `STATUS_TEXT_TO_LOCAL_STATUS`.

## 콜마너에 확인이 필요한 것

1. `OrderAllStatus`에 `OrderReceipt` 접수건이 포함되지 않는 이유 (설정 문제인지 사양인지)
2. `OrderAllStatus` 응답의 `status_code`가 비어 오는 이유 (정의서상 필수 항목)
3. `providerId` 단위로 지사 전체 오더를 조회하는 방법이 있는지 (현재는 연락처 단위가 최선)
