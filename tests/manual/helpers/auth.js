const { expect } = require('@playwright/test');

async function loginWithRetry(page, options = {}) {
  const baseUrl = options.baseUrl || 'http://127.0.0.1:3000';
  const loginId = options.loginId || 'admin';
  const password = options.password || 'Admin!2345';
  const attempts = Number(options.attempts || 5);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await page.context().clearCookies();
    await page.goto(baseUrl + '/login', { waitUntil: 'domcontentloaded' });

    const currentUrl = page.url();
    if (!/\/login(?:\?|$)/.test(currentUrl)) {
      return;
    }

    const loginIdInput = page.locator('input[name="login_id"]');
    const passwordInput = page.locator('input[name="password"]');
    const submitBtn = page.locator('button[type="submit"]');

    const hasLoginForm = (await loginIdInput.count()) > 0 && (await passwordInput.count()) > 0 && (await submitBtn.count()) > 0;
    if (!hasLoginForm) {
      await page.waitForTimeout(400 * (attempt + 1));
      continue;
    }

    await loginIdInput.fill(loginId);
    await passwordInput.fill(password);
    await submitBtn.click();
    await page.waitForLoadState('domcontentloaded');

    const nextUrl = page.url();
    if (!/\/login(?:\?|$)/.test(nextUrl)) {
      return;
    }

    await page.waitForTimeout(400 * (attempt + 1));
  }

  throw new Error('로그인 후 보호 페이지로 이동하지 못했습니다: ' + page.url());
}

async function openAiIntakeWithRetry(page, options = {}) {
  const baseUrl = options.baseUrl || 'http://127.0.0.1:3000';
  const attempts = Number(options.attempts || 3);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const isolatedSessionId = String(9000000 + Math.floor(Math.random() * 100000));
    await page.goto(baseUrl + '/orders/ai-intake?session=' + encodeURIComponent(isolatedSessionId), {
      waitUntil: 'domcontentloaded',
    });

    const currentUrl = page.url();
    if (/\/login(?:\?|$)/.test(currentUrl)) {
      await page.waitForTimeout(300 * (attempt + 1));
      continue;
    }

    const chatInput = page.locator('#aiIntakeText');
    try {
      await expect(chatInput).toBeVisible({ timeout: 12000 });
      return;
    } catch (_error) {
      await page.waitForTimeout(300 * (attempt + 1));
    }
  }

  throw new Error('AI intake 화면 진입 실패: ' + page.url());
}

module.exports = {
  loginWithRetry,
  openAiIntakeWithRetry,
};
