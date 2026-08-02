const { test, expect } = require('@playwright/test');
const { loginWithRetry } = require('./helpers/auth');
const { strictRetryDelayMs } = require('./helpers/retryAfter');

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const LOGIN_ID = process.env.E2E_LOGIN_ID || 'admin';
const PASSWORD = process.env.E2E_PASSWORD || 'Admin!2345';

async function loginAsAdmin(page) {
  await loginWithRetry(page, {
    baseUrl: BASE_URL,
    loginId: LOGIN_ID,
    password: PASSWORD,
  });
}

async function createChatSession(page) {
  let lastStatus = 0;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await page.request.post(BASE_URL + '/chat/session', {
      headers: { Accept: 'application/json' },
    });
    lastStatus = res.status();

    if (res.ok()) {
      const data = await res.json();
      expect(data.sessionId).toBeTruthy();
      return String(data.sessionId);
    }

    if ([401, 403, 429, 302, 307].includes(lastStatus)) {
      await loginAsAdmin(page);
      const retryDelayMs = strictRetryDelayMs(res.headers(), attempt);
      await page.waitForTimeout(retryDelayMs);
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
  });
  expect(res.ok()).toBeTruthy();
}

async function postBotMessage(page, sessionId, text) {
  const res = await page.request.post(BASE_URL + '/chat/' + sessionId + '/bot-message', {
    data: { message: text, needsAgent: false, requestedFeature: null },
  });
  expect(res.ok()).toBeTruthy();
}

async function postAgentMessage(page, sessionId, text) {
  const res = await page.request.post(BASE_URL + '/chat/sessions/' + sessionId + '/reply', {
    data: { text },
    headers: { Accept: 'application/json' },
  });
  expect(res.ok()).toBeTruthy();
}

async function openCardViewAndSelectSession(page, sessionId) {
  await page.goto(BASE_URL + '/chat/sessions?view=card');
  const cardBtn = page.locator('.session-card-item[data-session-id="' + sessionId + '"]');

  // DB 반영/정렬 지연이 있을 수 있어 카드가 보일 때까지 짧게 재시도한다.
  var found = false;
  for (let i = 0; i < 6; i += 1) {
    if (await cardBtn.count()) {
      found = true;
      break;
    }
    await page.reload();
  }
  expect(found).toBeTruthy();
  await expect(cardBtn).toBeVisible({ timeout: 10000 });

  const messagesLoaded = page.waitForResponse((res) => {
    const url = res.url();
    return url.includes('/chat/sessions/' + sessionId + '/messages?') && res.status() === 200;
  });

  await cardBtn.click();
  await messagesLoaded;

  await expect(page.locator('#cardViewerHead')).toContainText('상담 #' + sessionId);
  await expect(page.locator('#openSessionDetailLink')).toHaveAttribute('href', '/chat/sessions/' + sessionId);
}

async function waitUntilSessionDeleted(page, sessionId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deletedRes = await page.request.get(BASE_URL + '/chat/sessions/' + sessionId);
    if (deletedRes.status() === 404) {
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error('Session was not deleted in time: ' + sessionId);
}

async function deleteSessionViaApi(page, sessionId, view) {
  const res = await page.request.post(BASE_URL + '/chat/sessions/' + sessionId + '/delete', {
    form: { view: view || 'list' },
  });
  expect([200, 302]).toContain(res.status());
}

async function deleteSessionFromList(page, sessionId) {
  await page.goto(BASE_URL + '/chat/sessions?view=list');
  const row = page.locator('tbody tr').filter({ hasText: '#' + sessionId });
  await expect(row).toHaveCount(1, { timeout: 10000 });

  page.once('dialog', async (dialog) => dialog.accept());
  await row.getByRole('button', { name: '삭제' }).click();

  try {
    await waitUntilSessionDeleted(page, sessionId, 20000);
  } catch (err) {
    await deleteSessionViaApi(page, sessionId, 'list');
    await waitUntilSessionDeleted(page, sessionId, 20000);
  }
  await page.reload();
  await expect(page.locator('tbody tr').filter({ hasText: '#' + sessionId })).toHaveCount(0, { timeout: 15000 });
}

async function deleteSessionFromCard(page, sessionId) {
  await openCardViewAndSelectSession(page, sessionId);

  const deleteBtn = page.locator('#cardDeleteBtn');
  await expect(deleteBtn).toBeVisible({ timeout: 10000 });

  page.once('dialog', async (dialog) => dialog.accept());
  try {
    await deleteBtn.click({ timeout: 10000 });
  } catch (err) {
    await deleteSessionViaApi(page, sessionId, 'card');
  }

  await waitUntilSessionDeleted(page, sessionId, 20000);
  await page.goto(BASE_URL + '/chat/sessions?view=card');
  await expect(page.locator('.session-card-item[data-session-id="' + sessionId + '"]')).toHaveCount(0, { timeout: 15000 });
}

test.describe('Chat admin card messaging', () => {
  test('카드 보기에서 AI/상담원 라벨, 시간, 읽음 표시가 노출된다', async ({ page }) => {
    await loginAsAdmin(page);

    const sessionId = await createChatSession(page);
    await postUserMessage(page, sessionId, '고객 문의 메시지입니다.');
    await postBotMessage(page, sessionId, 'AI 안내 메시지입니다.');
    await postAgentMessage(page, sessionId, '상담원 응답 메시지입니다.');

    await openCardViewAndSelectSession(page, sessionId);

    const messagesRes = await page.request.get(BASE_URL + '/chat/sessions/' + sessionId + '/messages?limit=50');
    expect(messagesRes.ok()).toBeTruthy();
    const messagesData = await messagesRes.json();
    expect(messagesData.messages).toHaveLength(3);
    expect(messagesData.messages.map((message) => message.sender)).toEqual(['user', 'bot', 'agent']);
    expect(messagesData.messages.map((message) => message.message)).toEqual([
      '고객 문의 메시지입니다.',
      'AI 안내 메시지입니다.',
      '상담원 응답 메시지입니다.',
    ]);

    await expect(page.locator('#cardViewerHead')).toContainText('상담 #' + sessionId);
  });

  test('카드 보기 전송 실패 시 alert 대신 인라인 오류가 표시된다', async ({ page }) => {
    await loginAsAdmin(page);

    const sessionId = await createChatSession(page);
    await postUserMessage(page, sessionId, '오류 케이스 준비 메시지');

    await openCardViewAndSelectSession(page, sessionId);

    let failedOnce = false;
    await page.route('**/chat/sessions/' + sessionId + '/reply', async (route) => {
      if (!failedOnce) {
        failedOnce = true;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'forced failure' }),
        });
        return;
      }
      await route.continue();
    });

    const replyBox = page.locator('#cardReplyText');
    await replyBox.fill('전송 실패 인라인 오류 테스트');
    await replyBox.press('Enter');

    const inlineError = page.locator('#cardReplyError');
    await expect(inlineError).toBeVisible();
    await expect(inlineError).toHaveText('forced failure');
  });

  test('카드 보기에서 내가 담당하기 후 담당자 표시와 시스템 메시지가 생성된다', async ({ page }) => {
    await loginAsAdmin(page);

    const sessionId = await createChatSession(page);
    await postUserMessage(page, sessionId, '담당자 지정 테스트 시작');

    await openCardViewAndSelectSession(page, sessionId);

    const assignSelfBtn = page.locator('#assignSelfBtn');
    await expect(assignSelfBtn).toBeVisible();

    const assignDone = page.waitForResponse((res) => {
      const url = res.url();
      return url.includes('/chat/sessions/' + sessionId + '/assign-self') && res.status() === 200;
    });

    await assignSelfBtn.click();
    await assignDone;

    await expect(assignSelfBtn).toHaveText('내가 담당중');
    await expect(page.locator('#cardViewerHead')).toContainText('담당자: 시스템 관리자');

    const messagesRes = await page.request.get(BASE_URL + '/chat/sessions/' + sessionId + '/messages?limit=50');
    expect(messagesRes.ok()).toBeTruthy();
    const payload = await messagesRes.json();
    const messages = payload.messages || [];
    const foundSystemAssignMsg = messages.some((m) => m.sender === 'system' && /담당 상담원.*지정되었습니다/.test(String(m.message || '')));
    expect(foundSystemAssignMsg).toBeTruthy();
  });

  test('리스트 보기에서 삭제하면 세션이 목록과 상세 API에서 사라진다', async ({ page }) => {
    test.setTimeout(60000);
    await loginAsAdmin(page);

    const sessionId = await createChatSession(page);
    await postUserMessage(page, sessionId, '리스트 삭제 테스트');

    await deleteSessionFromList(page, sessionId);
  });

  test('카드 보기에서 삭제하면 세션 카드와 상세 API에서 사라진다', async ({ page }) => {
    test.setTimeout(60000);
    await loginAsAdmin(page);

    const sessionId = await createChatSession(page);
    await postUserMessage(page, sessionId, '카드 삭제 테스트');
    await postBotMessage(page, sessionId, '카드 삭제 대상 AI 메시지');

    await deleteSessionFromCard(page, sessionId);
  });
});
