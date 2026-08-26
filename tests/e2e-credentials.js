// e2e 테스트가 쓸 로그인 계정. 모든 스펙이 여기 하나만 본다.
//
// 왜 모았나(2026-08-25 실사고):
//
// 스펙마다 `process.env.E2E_PASSWORD || '<고정 문자열>'`로 **하드코딩 폴백**을 두고 있었다.
// Playwright는 dotenv를 자동으로 부르지 않고 playwright.config도 없어서, 셸에 값을 직접 넣지
// 않으면 E2E_PASSWORD가 늘 undefined였다 — 그래서 테스트가 조용히 틀린 비밀번호로 로그인을
// 시도했다. 접속기록에 qa_test_bot LOGIN_FAILURE가 18건 쌓였고(계정은 찾았고 비밀번호만 틀린
// 상태), 그 직전에는 반복 로그인으로 LOGIN_RATE_LIMITED가 78건 찍혔다. 값이 없으면 조용히
// 틀린 값을 쓰는 대신 **즉시 멈추는 것**이 맞다 — 계속 시도하면 정상 계정까지 잠긴다.
//
// 하드코딩된 값 자체도 문제였다. 실제 비밀번호 형태의 문자열이 스펙 13곳에 그대로 들어 있었다.
//
// 기본 계정을 qa_test_bot으로 둔 이유: 예전 기본값이 'admin'이라, 값을 안 넣고 돌리면 실사용
// admin으로 로그인해 단일세션 기능 때문에 **그 계정을 쓰던 사람이 로그아웃됐다**(같은 날
// 접속기록에 admin LOGIN_BLOCKED 5건). 자동화는 QA 전용 계정만 쓴다.
//
// .env 로드는 playwright.config.js가 하지만, 스펙 파일 하나를 직접 node로 돌리는 경우에도
// 동작하도록 여기서 한 번 더 부른다(dotenv는 이미 로드된 값을 덮어쓰지 않는다).
require('dotenv').config();

const LOGIN_ID = String(process.env.E2E_LOGIN_ID || 'qa_test_bot').trim();
const PASSWORD = String(process.env.E2E_PASSWORD || '').trim();

if (!PASSWORD) {
  throw new Error(
    'E2E_PASSWORD가 설정되지 않았습니다. 테스트를 그대로 진행하면 틀린 비밀번호로 로그인을 반복해\n'
    + '해당 계정이 로그인 제한(IP당 15분 10회)에 걸립니다.\n'
    + '  · .env에 E2E_PASSWORD를 넣어두었다면 그대로 실행하면 됩니다(이 파일이 .env를 읽습니다).\n'
    + '  · 다른 계정으로 돌리려면 E2E_LOGIN_ID도 함께 지정하세요.\n'
    + `  · 지금 사용할 계정: ${LOGIN_ID}`
  );
}

module.exports = { LOGIN_ID, PASSWORD };
