const { expect } = require('@playwright/test');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loginWithRetry(page, options = {}) {
  const baseUrl = options.baseUrl || 'http://127.0.0.1:3000';
  const loginId = options.loginId || 'admin';
  const password = options.password || 'Admin!2345';
  const attempts = Number(options.attempts || 6);
  const protectedUrl = baseUrl + '/chat/sessions?view=list';

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await page.context().clearCookies();
    const loginRes = await page.request.post(baseUrl + '/login', {
      form: {
        login_id: loginId,
        password,
      },
      maxRedirects: 0,
    });

    const status = loginRes.status();
    const location = String(loginRes.headers()['location'] || '');

    if (status === 429) {
      const retryAfter = Number(loginRes.headers()['retry-after'] || '');
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(Math.floor(retryAfter * 1000), 1500)
        : Math.min(250 * (attempt + 1), 1200);
      await sleep(delayMs);
      continue;
    }

    if (status === 302 && (location === '/' || location === '')) {
      const probe = await page.request.get(protectedUrl, {
        maxRedirects: 0,
      });
      if (probe.status() === 200) {
        await page.goto(protectedUrl, { waitUntil: 'domcontentloaded' });
        if (!/\/login(?:\?|$)/.test(page.url())) {
          return;
        }
      }
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
