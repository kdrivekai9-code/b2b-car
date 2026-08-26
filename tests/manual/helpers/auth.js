const fs = require('fs');
const path = require('path');
const { expect } = require('@playwright/test');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 로그인 성공 쿠키를 재사용한다 — 같은 실행 안에서도, 실행과 실행 사이에서도.
//
// 서버는 로그인 POST를 IP당 15분에 10회로 막는다(server.js의 loginLimiter). 테스트마다 새로
// 로그인하면 한 파일에 테스트 서너 개만 있어도 한도에 닿고, 실패 재시도까지 겹치면 그 뒤로는
// 코드가 멀쩡해도 전부 "로그인 실패"로 떨어진다 — 확인 단계 테스트를 고치는 동안 실제로 두 번
// 그렇게 막혔고, 그때마다 원인이 코드인지 한도인지부터 가려내야 했다. 테스트를 고치며 여러 번
// 돌리는 게 정상인데 그 반복 자체가 한도를 채우니, 파일에 남겨 실행 사이에도 이어 쓴다.
// 로그인 자체를 검증하는 테스트는 이 헬퍼를 쓰지 않으면 된다.
//
// 세션 쿠키가 담기므로 저장소에 올리지 않는다(.gitignore).
const STATE_FILE = path.join(__dirname, '..', '.auth-cookies.json');

let cachedCookies = null;

function loadCachedCookies() {
  if (cachedCookies) return cachedCookies;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Array.isArray(raw) && raw.length) cachedCookies = raw;
  } catch (_error) {
    cachedCookies = null;
  }
  return cachedCookies;
}

function saveCachedCookies(cookies) {
  cachedCookies = cookies;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(cookies), 'utf8');
  } catch (_error) {
    // 저장에 실패해도 테스트는 진행한다 — 다음 실행이 다시 로그인할 뿐이다.
  }
}

async function tryCachedLogin(page, protectedUrl) {
  const cookies = loadCachedCookies();
  if (!cookies || !cookies.length) return false;
  try {
    await page.context().clearCookies();
    await page.context().addCookies(cookies);
    await page.goto(protectedUrl, { waitUntil: 'domcontentloaded' });
    return !/\/login(?:\?|$)/.test(page.url());
  } catch (_error) {
    return false;
  }
}

// 호출부가 계정을 안 넘기면 공용 설정을 쓴다 — 하드코딩된 admin/비밀번호가 기본값이었는데,
// 그러면 값을 안 넘긴 테스트가 실사용 admin으로 로그인해 단일세션 때문에 그 계정을 쓰던 사람을
// 로그아웃시켰다(2026-08-25 접속기록: admin LOGIN_BLOCKED 5건).
const { LOGIN_ID: DEFAULT_LOGIN_ID, PASSWORD: DEFAULT_PASSWORD } = require('../../e2e-credentials');

async function loginWithRetry(page, options = {}) {
  const baseUrl = options.baseUrl || 'http://127.0.0.1:3000';
  const loginId = options.loginId || DEFAULT_LOGIN_ID;
  const password = options.password || DEFAULT_PASSWORD;
  const attempts = Number(options.attempts || 6);
  const loginUrl = baseUrl + '/login';
  const protectedUrl = baseUrl + '/chat/sessions?view=list';

  if (await tryCachedLogin(page, protectedUrl)) return;
  cachedCookies = null;

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
      if (!/\/login(?:\?|$)/.test(page.url())) {
        saveCachedCookies(await page.context().cookies());
        return;
      }
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
  const loginId = options.loginId || DEFAULT_LOGIN_ID;
  const password = options.password || DEFAULT_PASSWORD;
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
