# 콜마너 외부연동 API 메모

정의서 원본: **[callmaner-external-api-spec.xlsx](./callmaner-external-api-spec.xlsx)**
(「콜마너 외부연동 인터페이스 정의서」, 시트 4개: 변경이력 / 인터페이스정의 및 목록 /
인터페이스상세 / 오류코드). `lib/callmaner.js` 주석이 인용하는 "사. 인터페이스상세" 등의 절 번호는
이 파일 기준이다.

아래는 그 정의서를 읽고 정리한 것과, 실제 호출로 확인한 차이점이다.

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

### 목록 시트에 없고 상세 시트에만 있는 인터페이스

"인터페이스정의 및 목록" 시트의 표에는 영문명이 비어 있거나 아예 빠져 있는데, "인터페이스상세"
시트에는 `cmd`까지 정의된 것들이 있다. 목록만 보고 판단하면 놓친다.

| 전문명 | cmd | 비고 |
|---|---|---|
| 오더요금수정 | `OrderCharge` | order.do |
| 기사연락처조회 | `WkContactSearch` | order.do |
| 완료오더조회 | `FinishOrderList` | order.do. userHp + page/page_size. **전일 기준**으로 내려주며 오전 9~10시는 피해달라는 주석 있음 |
| 타사 배차/해제 | `OtherStatusChange` | order.do |
| 탁송사진 이미지 | `ConsPicture` | **picture.do** |
| 배차기사 현위치 조회 | `TrackingDriver` | order.do. **구현됨**(lib/callmaner.js trackingDriver) — `userHp` + `providerId` + `conf_slip`, 응답 `rs:{lat,lng,wk_name}`. 사번만 보내면 "배차된 정보가 없습니다"(rc=NG). 배차 전에도 같은 NG다. **기사 위치의 진실은 이 전문이다** — MCP의 `driver.xy`는 `source='route_interpolated'`인 보간값일 수 있고, 실측에서 실제 좌표와 7.04km 떨어져 있었다(2026-09-08, OID2075) |
| **기준시점 콜목록조회** | **`CallListSince`** | order.do. **userHp 없이 `providerId` + `sinceDt`만** — 지사 단위 조회 |

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

## 지사(providerId) 단위 조회 — CallListSince

정의서에 지사 단위로 목록을 받는 인터페이스가 있다. `userHp`가 요청 파라미터에 아예 없다.

```
request : cmd="CallListSince", ver, ts, tn, providerId(●), sinceDt(● yyyymmddhh24miss)
response: rc, rm  (목록은 rs.data)
```

그런데 **실제로는 `rc="00"`으로 정상 응답하면서 `rs.data`가 항상 빈 배열**이다. 아래를 다 시도했다.

| 시도 | 결과 |
|---|---|
| `sinceDt=20260806000000` (오늘 0시) | 0건 |
| `sinceDt=20260805000000` (어제 0시) | 0건 |
| `sinceDt=0` | 0건 |
| `providerId`에서 앱코드 제거(`B100-12345`) | 0건 |
| `userHp`를 함께 전달 | 0건 |

같은 시각에 `OrderHistory`(연락처 단위)로는 같은 오더들이 정상 조회된다. 즉 **지사 단위 목록
API 두 개(`OrderAllStatus`, `CallListSince`)가 모두 우리 접수건을 빼놓는다** — 공통 원인이 있다고
봐야 한다(콜마너 서버 설정에서 외부연동 접수건이 목록 대상에서 빠져 있을 가능성).

첫 호출이 10초 타임아웃으로 실패하는 경우가 있어 이 API를 쓰게 되면 타임아웃을 넉넉히 잡아야 한다.

## 현재 동기화 방식 (routes/callmanerSync.js)

연락처 단위 **목록조회(`OrderHistory`)** → 목록에서 못 찾은 건만 **단건조회(`OrderInfo`)** 로 보완.

`OrderHistory` 사용 시 실제 응답이 정의서와 다른 점:

| 항목 | 정의서 | 실제 |
|---|---|---|
| 페이지 파라미터 | `page` / `page_size` | 같음. **`pageSize`로 보내면 무시되고 1건만 온다** |
| 목록 필드명 | (정의서 표기는 `orderList` 계열) | **`rs.data`** |
| 상태 | `{접수,배차,완료,취소,대기 등}` | 같음 — 한글 문자열. `status_code`는 없음 |

그래서 상태 매핑은 코드가 아니라 한글 기준이다 → `lib/callmaner.js`의 `STATUS_TEXT_TO_LOCAL_STATUS`.

## 정의서 다시 읽는 방법

xlsx라 그대로 열기 어려우면 아래처럼 시트별로 덤프할 수 있다.

```bash
python3 - <<'EOF'
import zipfile, re, html
z = zipfile.ZipFile('docs/callmaner-external-api-spec.xlsx')
ss = z.read('xl/sharedStrings.xml').decode('utf-8')
shared = [html.unescape(re.sub(r'<[^>]+>', '', m)) for m in re.findall(r'<si>(.*?)</si>', ss, re.S)]
xml = z.read('xl/worksheets/sheet3.xml').decode('utf-8')   # sheet3 = 인터페이스상세
for rnum, row in re.findall(r'<row r="(\d+)"[^>]*>(.*?)</row>', xml, re.S):
    cells = {}
    for attrs, body in re.findall(r'<c ([^>]*?)/?>(?:(.*?)</c>)?', row, re.S):
        col = re.search(r'r="([A-Z]+)\d+"', attrs).group(1)
        t = re.search(r't="(\w+)"', attrs); v = re.search(r'<v>(.*?)</v>', body or '', re.S)
        if v: cells[col] = shared[int(v.group(1))] if (t and t.group(1) == 's') else v.group(1)
    if cells: print(rnum, ' | '.join(f"{k}={v}" for k, v in sorted(cells.items())))
EOF
```

주의: 파라미터 이름이 들어 있는 셀이 공유문자열 인덱스(숫자)로만 남아 있는 행이 있다
(예: 페이지 파라미터 행의 `433`/`436` = `page`/`page_size`). 이름이 안 보이면 그 숫자를
공유문자열 인덱스로 되짚어야 한다.

## 콜마너에 확인이 필요한 것

지사 단위 목록 API 두 개가 모두 우리 접수건을 돌려주지 않는 것이 핵심이다. 이게 풀리면 폴링이
연락처 개수와 무관하게 1분에 1회로 줄어든다.

1. **`CallListSince`가 `rc="00"`인데 `rs.data`가 항상 비어 있습니다.** `providerId=B100-12345-AP12345`,
   `sinceDt`를 오늘 0시/어제 0시/`0`으로 바꿔도, 앱코드를 떼도, `userHp`를 함께 넣어도 0건입니다.
   같은 시각에 `OrderHistory`로는 같은 오더들이 조회됩니다. 지사 단위 조회를 쓰려면 어떤 설정이
   필요한지요?
2. **`OrderAllStatus`에 `OrderReceipt` 접수건이 포함되지 않습니다.** 같은 `userHp`(01081161240)로
   조회할 때 콜마너 쪽에서 접수된 건은 나오는데 `OrderReceipt`로 접수한 179098847은 빠집니다.
3. **`OrderAllStatus` 응답의 `status_code`가 빈 문자열로 옵니다.** 정의서상 필수(●) 항목이고
   코드표까지 정의돼 있는데 실제로는 `status="취소", status_code=""`입니다.
4. **운행 진행 상태를 우리가 콜마너에 올릴 수 있는 전문이 있습니까?** (2026-09-08 추가)
   기사 화면에 운행 단계 버튼을 넣었습니다 — 출발지 도착 → 운행 시작 → 경유지N 대기 →
   운행 시작 → 운행 완료. 지금은 우리 쪽에만 기록합니다(order_trip_steps). 향후 이 변경을
   콜마너와 동기화할 예정인데, 목록에서 상태를 **올리는** 전문을 찾지 못했습니다.
   - 쓰기 계열로 있는 것: `OrderReceipt`(접수) / `OrderModify`(수정) / `OrderCancel`(취소) /
     `OrderStanby`·`OrderStanbyRelease`(대기·해제) / `OrderCharge`(요금수정) /
     `OtherStatusChange`(타사 배차·해제).
   - 그중 `OtherStatusChange`가 이름만으로는 가장 가까워 보이는데, 정의서 목록에는
     "타사 배차/해제"로만 적혀 있어 운행 단계(도착·출발·대기)를 받을 수 있는지 알 수 없습니다.
     받을 수 있다면 어떤 상태코드를 쓰는지, 경유지 대기·재출발을 구분할 수 있는지요?
   - 없다면 반대 방향(콜마너 기사 앱에서 바뀐 상태를 우리 단계 기록에 자동 반영)으로 붙여야
     하는데, 그쪽은 `OrderInfo`의 `baecha_status`가 운행시작 하나뿐이라 경유지 단계를
     구분할 수 없습니다.
5. **`TrackingDriver`가 운행시작 뒤에는 좌표를 빈 값으로 줍니다.** (2026-09-09 추가)
   OID2211(conf_slip=182527475)은 배차 단계에서 기사 위치가 화면에 표시됐는데, 운행시작
   이후에는 `rc="00" rm="정상처리 되었습니다."`로 응답하면서 `rs`가
   `{"lat":"","lng":"","wk_name":""}`입니다. 같은 순간 `OrderInfo`는 정상이고
   (`baecha_status="2"`, `wk_info="T11111*채정식"`, `status_time=20260909111128`),
   `userHp`를 지사 대표번호·출발지 연락처·기사 안심번호로 바꿔 세 번 호출해도 모두 같았습니다.
   - **두 가지 가능성은 확인으로 지워졌습니다**(2026-09-10): 테스트 시점에 기사 앱은 켜져
     있었고, 콜마너는 **운행완료까지 기사 위치를 수집한다**고 확인해주셨습니다. 그렇다면
     콜마너에 좌표가 있는데 이 전문만 빈 값을 주는 것으로 보입니다.
   - 응답이 좌표만 빈 것이 아니라 **`wk_name`까지 빕니다.** 같은 순간 `OrderInfo`는
     `wk_info="T11111*채정식"`을 정상으로 줍니다. 이 전문이 보는 테이블에 이 배차의 행이
     아예 없는 것처럼 보입니다.
   - 요청 형태 문제는 아닙니다. `conf_slip`을 넣은 조합은 전부 `rc=00`에 빈 `rs`였고
     (userHp 3종 · 숫자형 conf_slip · 하이픈 번호), `conf_slip`을 빼고 `wk_sabun`만 보내거나
     키를 `confSlip`으로 쓰면 `rc=NG "배차된 정보가 없습니다"`로 갈립니다 — 즉 배차는
     정상적으로 찾아지는데 위치·기사명이 비어 옵니다.
   - 완료된 건은 `rc=NG "배차된 정보가 없습니다"`입니다(OID2075·OID1455 실측). 운행 중인데
     내용만 비는 위 경우와 응답이 달라, 빈 값이 "지금 위치 없음"인지 "이 단계에서는 제공
     안 함"인지 저희 쪽에서 가릴 수 없습니다.
   - 저희 쪽 조치: 이제 콜마너 동기화 크론이 매분 이 전문을 불러 좌표를 `orders.driver_last_*`에
     남기고, 오던 좌표가 끊기면 연동오류(`tracking_driver_empty`)로 시각을 기록합니다.
     화면에는 "마지막으로 확인된 위치입니다 (N분 전 기준)"으로 표시합니다. 다음 건이 생기면
     **몇 시까지 좌표가 왔고 몇 시부터 비었는지** 정확한 시각을 함께 드리겠습니다.
6. **고객에게 제공하시는 기사위치 조회 URL이 있습니까?** (2026-09-10 추가)
   위 5번과 함께 확인 부탁드립니다. 배차 이후의 위치를 전문(`TrackingDriver`)으로는 안 주시고
   **콜마너가 발급하는 위치 조회 링크**로만 제공하시는 것이라면, 저희는 그 링크를 받을 방법이
   필요합니다.
   - 그런 링크가 있다면 `conf_slip`으로 만들 수 있는 규칙이 있습니까, 아니면 접수·배차 응답에
     함께 담아주실 수 있습니까?
   - 링크가 웹페이지라면 그 안의 좌표를 저희가 읽어 쓰는 것이 허용됩니까, 아니면 좌표를 주는
     별도 엔드포인트를 안내해주실 수 있습니까?
   - 저희가 확인한 범위에서는 위치를 주는 통로가 `TrackingDriver` 하나뿐입니다. 정의서 목록·상세
     시트에 다른 위치 인터페이스가 없고, 콜마너 MCP 도구 12개(`call.*`, `cust.get`, `eta.get`,
     `fare.get`, `place.find.*`, `branch.repno.get`)에도 위치 URL을 주는 것이 없습니다.
     MCP `call.list.active`의 `driver.xy`는 `source="route_interpolated"` 보간값입니다.
7. **`OrderInfo` 응답의 `conf_option`("nnn") 세 자리가 각각 무엇입니까?** (2026-09-10 추가)
   저희는 접수(`OrderReceipt`) 때 이 값을 보내지 않는데 응답에는 늘 `"nnn"`으로 옵니다.
   세 자리가 각각 어떤 옵션이고 `y`로 켜면 무엇이 달라지는지요 — 특히 그중 **고객 안내
   (문자·알림톡 발송, 위치 조회 링크 제공)**에 해당하는 자리가 있는지 알고 싶습니다.
   같은 응답의 `driver_option`("Any")도 선택 가능한 값 목록을 알려주시면 좋겠습니다.
