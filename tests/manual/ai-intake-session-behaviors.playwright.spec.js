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

async function createSession(page) {
  let lastStatus = 0;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await page.request.post(BASE_URL + '/chat/session', {
      headers: { Accept: 'application/json' },
    });
    lastStatus = res.status();

    if (res.ok()) {
      const body = await res.json();
      expect(body.sessionId).toBeTruthy();
      return String(body.sessionId);
    }

    if ([401, 403, 429, 302, 307].includes(lastStatus)) {
      await loginAsAdmin(page);
      await page.waitForTimeout(300 * (attempt + 1));
      continue;
    }

    const bodyText = await res.text();
    throw new Error('세션 생성 실패: status=' + lastStatus + ', body=' + bodyText);
  }

  throw new Error('세션 생성 재시도 실패: lastStatus=' + lastStatus);
}

async function postUserMessage(page, sessionId, text) {
  const res = await page.request.post(BASE_URL + '/chat/' + sessionId + '/user-message', {
    data: { text },
    headers: { Accept: 'application/json' },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function postBotMessage(page, sessionId, payload) {
  const res = await page.request.post(BASE_URL + '/chat/' + sessionId + '/bot-message', {
    data: payload,
    headers: { Accept: 'application/json' },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function getMessagesSince(page, sessionId, since) {
  const res = await page.request.get(BASE_URL + '/chat/' + sessionId + '/messages?since=' + String(since), {
    headers: { Accept: 'application/json' },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

test.describe('AI intake session behaviors', () => {
  test('needs_agent 이후 새 접수를 위한 세션 전환 경로(기존 종료 + 신규 생성)가 동작한다', async ({ page }) => {
    await loginAsAdmin(page);

    const oldSessionId = await createSession(page);
    await postUserMessage(page, oldSessionId, '상담원 연결이 필요합니다.');

    const escalate = await postBotMessage(page, oldSessionId, {
      message: null,
      needsAgent: true,
      requestedFeature: '상담원 연결',
    });
    expect(escalate.status).toBe('needs_agent');

    const closeOld = await postBotMessage(page, oldSessionId, {
      closeSession: true,
    });
    expect(closeOld.status).toBe('closed');

    const oldMessages = await getMessagesSince(page, oldSessionId, 0);
    expect(oldMessages.status).toBe('closed');

    const newSessionId = await createSession(page);
    expect(newSessionId).not.toBe(oldSessionId);

    const newSessionMessages = await getMessagesSince(page, newSessionId, 0);
    expect(Array.isArray(newSessionMessages.messages)).toBeTruthy();
    expect(newSessionMessages.status).toBe('bot');
  });

  test('catch-up 조회는 since 이후 메시지만 반환한다', async ({ page }) => {
    await loginAsAdmin(page);

    const sessionId = await createSession(page);
    await postUserMessage(page, sessionId, '초기 메시지');

    const firstBatch = await getMessagesSince(page, sessionId, 0);
    expect(Array.isArray(firstBatch.messages)).toBeTruthy();
    expect(firstBatch.messages.length).toBeGreaterThan(0);

    const baseLastId = firstBatch.messages[firstBatch.messages.length - 1].id;

    await postUserMessage(page, sessionId, 'catchup-user-message');
    await postBotMessage(page, sessionId, {
      message: 'catchup-bot-message',
      needsAgent: false,
      requestedFeature: null,
    });

    const catchup = await getMessagesSince(page, sessionId, baseLastId);
    expect(Array.isArray(catchup.messages)).toBeTruthy();
    expect(catchup.messages.length).toBeGreaterThan(0);

    for (const m of catchup.messages) {
      expect(m.id).toBeGreaterThan(baseLastId);
    }

    const joined = catchup.messages.map((m) => String(m.message || '')).join('\n');
    expect(joined).toContain('catchup-user-message');
    expect(joined).toContain('catchup-bot-message');
  });
});
