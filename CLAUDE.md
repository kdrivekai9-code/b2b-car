@AGENTS.md

# 이 저장소에서 일하기

처음이면 [ONBOARDING.md](ONBOARDING.md)를 먼저 읽으세요 — 30분 안에 알아야 할 것만 있습니다.
전체 구조·DB 스키마·도메인 용어는 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)에 있습니다.

특히 자주 밟는 것들:

- **오더 상태값은 한글입니다** — `'완료'`·`'취소'`. 영문으로 쓰면 조건이 조용히 아무것도 걸러내지 않습니다.
- **공용 UI가 두 벌입니다** — `views/partials/*.ejs`를 고쳤으면 `src/app/**/_components/`에
  포팅된 쌍둥이가 있는지 확인하세요.
- **접수 경로가 넷입니다** — 공통 로직은 `lib/orderCreate.js`에 둡니다.
- **마이그레이션은 수동입니다** — 새 컬럼을 읽는 코드는 `42703` 폴백을 두세요.
- **로컬 DB가 운영 DB입니다** — 자동화는 `qa_test_*` 계정만, 시험 데이터는 `검사로` 표식,
  범위 없는 `DELETE` 금지.
