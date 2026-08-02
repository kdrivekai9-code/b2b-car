const { test, expect } = require('@playwright/test');
const { loginWithRetry } = require('./helpers/auth');

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

test.describe('AI intake submit precheck', () => {
  test('지사 미선택이면 400과 오류 메시지를 반환한다', async ({ page }) => {
    await loginAsAdmin(page);

    const roleRes = await page.request.get(BASE_URL + '/orders/new/data.json', {
      headers: { Accept: 'application/json' },
    });
    expect(roleRes.ok()).toBeTruthy();
    const roleData = await roleRes.json();
    const currentRole = String(roleData.currentUserRole || '');

    const res = await page.request.post(BASE_URL + '/orders/ai-intake/submit-precheck', {
      form: {
        branch_id: '',
      },
      headers: {
        'X-Requested-With': 'fetch',
        Accept: 'application/json',
      },
    });

    const body = await res.json();
    if (currentRole === 'admin') {
      expect(res.status()).toBe(400);
      expect(body).toMatchObject({ error: '지사를 선택해주세요.' });
      return;
    }

    expect(res.status()).toBe(200);
    expect(body).toMatchObject({ ok: true });
  });
});
