const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const LOGIN_ID = process.env.E2E_LOGIN_ID || 'admin';
const PASSWORD = process.env.E2E_PASSWORD || 'Admin!2345';

async function loginAsAdmin(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(BASE_URL + '/login');
    await page.fill('input[name="login_id"]', LOGIN_ID);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('domcontentloaded');

    const currentUrl = page.url();
    if (!/\/login(?:\?|$)/.test(currentUrl)) {
      return;
    }

    // 병렬 실행 중 세션 교체(reason=replaced)로 즉시 로그인 화면에 남을 수 있어 재시도한다.
    await page.context().clearCookies();
  }

  throw new Error('로그인 후 보호 페이지로 이동하지 못했습니다: ' + page.url());
}

test.describe('AI intake submit precheck', () => {
  test('지사 미선택이면 400과 오류 메시지를 반환한다', async ({ page }) => {
    await loginAsAdmin(page);

    const res = await page.request.post(BASE_URL + '/orders/ai-intake/submit-precheck', {
      form: {
        branch_id: '',
      },
      headers: {
        'X-Requested-With': 'fetch',
        Accept: 'application/json',
      },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: '지사를 선택해주세요.' });
  });
});
