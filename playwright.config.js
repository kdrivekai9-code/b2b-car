// Playwright 설정 — 이 파일이 없어서 테스트가 .env를 전혀 읽지 못했다(2026-08-25 실사고).
//
// Playwright는 dotenv를 자동으로 부르지 않는다. 스펙들이 `process.env.E2E_PASSWORD`를 보는데
// 그 값이 늘 undefined라, 하드코딩 폴백으로 조용히 틀린 비밀번호를 써서 로그인이 계속 실패했다.
// 여기서 한 번 읽어두면 모든 스펙이 같은 값을 본다.
//
// 기존 npm 스크립트(package.json의 e2e/e2e:ai-intake)는 실행할 파일과 리포터를 인자로 직접
// 넘긴다 — 그 방식이 그대로 동작하도록 여기서는 공통 기본값만 둔다.
require('dotenv').config();

module.exports = {
  testDir: './tests/manual',
  // 이 스펙들은 운영과 같은 DB를 쓰고 실제 오더·세션을 만든다. 병렬로 돌리면 서로의 데이터를
  // 건드리고, 단일세션 때문에 같은 계정으로 동시에 로그인하면 서로를 로그아웃시킨다.
  workers: 1,
  fullyParallel: false,
  // 실패를 자동으로 되돌려 감추지 않는다 — 재시도하면 로그인 실패 같은 문제가 "가끔 되는 것"으로
  // 보여 원인을 놓친다.
  retries: 0,
  timeout: 120000,
  expect: { timeout: 15000 },
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:3000',
    // 실패했을 때 무엇을 보고 있었는지 남긴다.
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
};
