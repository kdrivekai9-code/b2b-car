const { expect } = require('@playwright/test');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loginWithRetry(page, options = {}) {
  const baseUrl = options.baseUrl || 'http://127.0.0.1:3000';
  const loginId = options.loginId || 'admin';
  const password = options.password || 'Admin!2345';
  const attempts = Number(options.attempts || 6);
  const loginUrl = baseUrl + '/login';
  const protectedUrl = baseUrl + '/chat/sessions?view=list';

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await page.context().clearCookies();
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('#loginId').fill(loginId);
    await page.locator('#loginPassword').fill(password);

    await Promise.all([
      page.locator('form').waitFor({ state: 'attached' }),
      page.locator('button[type="submit"]').click(),
    ]);

    await page.waitForLoadState('domcontentloaded');

    if (!/\/login(?:\?|$)/.test(page.url())) {
      await page.goto(protectedUrl, { waitUntil: 'domcontentloaded' });
      if (!/\/login(?:\?|$)/.test(page.url())) return;
    }

    const errorText = await page.locator('.error-msg').textContent().catch(() => '');
    if (/너무 많은 로그인 시도/.test(String(errorText || ''))) {
      await sleep(Math.min(500 * (attempt + 1), 2000));
      continue;
    }

    await sleep(Math.min(250 * (attempt + 1), 1200));
  }

  throw new Error('로그인 후 보호 페이지로 이동하지 못했습니다: ' + page.url());
}

async function openAiIntakeWithRetry(page, options = {}) {
  const baseUrl = options.baseUrl || 'http://127.0.0.1:3000';
  const loginId = options.loginId || 'admin';
  const password = options.password || 'Admin!2345';
  const attempts = Number(options.attempts || 3);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const isolatedSessionId = String(9000000 + Math.floor(Math.random() * 100000));
    await page.goto(baseUrl + '/orders/ai-intake?session=' + encodeURIComponent(isolatedSessionId), {
      waitUntil: 'domcontentloaded',
    });

    const currentUrl = page.url();
    if (/\/login(?:\?|$)/.test(currentUrl)) {
      await loginWithRetry(page, {
        baseUrl,
        loginId,
        password,
      });
      await sleep(200 * (attempt + 1));
      continue;
    }

    const chatInput = page.locator('#aiIntakeText');
    try {
      await expect(chatInput).toBeVisible({ timeout: 12000 });
      return;
    } catch (_error) {
      await sleep(200 * (attempt + 1));
    }
  }

  throw new Error('AI intake 화면 진입 실패: ' + page.url());
}

module.exports = {
  loginWithRetry,
  openAiIntakeWithRetry,
};
