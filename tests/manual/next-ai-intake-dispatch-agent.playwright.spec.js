// Next 챗봇(/orders/ai-intake, AiIntakeClient.js)에 배차 주문 도우미가 실제로 연결돼 있는지.
//
// 왜 필요한가: 도우미는 레거시 위젯(public/js/ai-intake.js)에만 붙어 있었고 Next 쪽에는 호출이
// 한 줄도 없었다 — unsupported면 곧바로 상담원 연결이었다. 프로덕션이 레거시를 띄우고 있어
// 드러나지 않았을 뿐, NEXT_STAGE3_AI_INTAKE_ENABLED를 켜는 순간 도우미가 통째로 죽는 상태였다.
// "코드에 함수가 있다"가 아니라 "화면에서 실제로 그 요청이 나간다"를 본다.
//
// 검사 계정에 콜마너 고객 컨텍스트가 없어 도우미는 대개 handled:false로 돌아온다 — 그건 이
// 검사의 관심사가 아니다. 확인하는 건 (1) 도우미에게 물어보기는 하는가, (2) 처리 못 했을 때
// 기존 상담원 연결 경로가 그대로 살아 있는가다.
const { test, expect } = require('@playwright/test');
const { loginWithRetry } = require('./helpers/auth');

// 이 화면은 Next(3001)에서만 이번 코드가 돈다. Express(3000)로 열면 레거시 위젯이라 무의미하다.
const BASE_URL = process.env.E2E_NEXT_BASE_URL || 'http://localhost:3001';
// 계정·비밀번호는 한 곳에서 가져온다 — 값이 없으면 즉시 멈춘다(tests/e2e-credentials.js).
const { LOGIN_ID, PASSWORD } = require('../e2e-credentials');

test.describe('Next 챗봇 · 배차 주문 도우미 연결', () => {
  test.describe.configure({ timeout: 180000 });

  test('처리 못하는 요청은 상담원 연결 전에 도우미를 거친다', async ({ page }) => {
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));

    // 도우미에게 물어봤는지 — parse 응답에 실려 오거나(서버가 미리 돌린 경우) 별도 요청으로 나간다.
    let askedAgent = false;
    let parseCarriedAgent = false;
    page.on('request', (r) => {
      if (/\/chat\/\d+\/dispatch-agent$/.test(r.url())) askedAgent = true;
    });
    page.on('response', async (r) => {
      if (!/\/orders\/ai-intake\/parse$/.test(r.url())) return;
      const body = await r.json().catch(() => null);
      if (body && body.dispatchAgent) { parseCarriedAgent = true; askedAgent = true; }
    });

    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    await page.goto(`${BASE_URL}/orders/ai-intake`, { waitUntil: 'networkidle' });

    const input = page.locator('.ai-chat-input-row textarea');
    await expect(input).toBeVisible();
    // 오더접수도 FAQ도 아닌, 도우미가 다루는 종류의 요청.
    await input.fill('내 주문 어떻게 됐어?');
    await input.press('Enter');

    // 도우미에게 물어보기까지 기다린다(서버가 미리 돌려 parse에 실어 보냈으면 그것도 인정).
    await expect
      .poll(() => askedAgent, { timeout: 90000, message: '도우미에게 물어보지 않았다' })
      .toBe(true);

    // 도우미가 처리했든 못 했든 대화는 이어져야 한다 — 봇 말풍선이 하나는 더 늘어난다.
    await expect(page.locator('.ai-chat-bubble').filter({ hasNotText: '내 주문 어떻게 됐어?' }).last())
      .toBeVisible({ timeout: 30000 });

    expect(problems, `페이지 오류: ${problems.join(' | ')}`).toEqual([]);
    console.log(`도우미 호출 확인 — parse 응답에 동봉: ${parseCarriedAgent}`);
  });
});
