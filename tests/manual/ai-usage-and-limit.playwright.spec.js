// AI 사용량 카드(대시보드)와 사용량 제한 설정(접속기록)이 실제로 뜨고 저장되는지.
//
// 왜 필요한가: 두 화면 모두 EJS와 Next에 각각 있다. EJS는 문법이 틀려도 빌드에서 안 잡히고 열 때
// 500이 나며, Next는 빌드는 통과하고 렌더에서 터진다 — 어느 쪽도 "파일을 고쳤다"로는 보증되지
// 않는다. 저장은 값이 실제로 되돌아오는지까지 본다(저장했다는 메시지만 뜨고 값이 안 바뀌면
// 관리자는 바꿨다고 믿는데 실제로는 옛 한도로 돈다).
const { test, expect } = require('@playwright/test');
const db = require('../../db');
const { loginWithRetry } = require('./helpers/auth');

// 대시보드는 프로덕션에서 Next가, 접속기록은 Express가 그린다(플래그 상태 기준).
// 두 스택 모두 확인하려고 기본값을 나눠 둔다.
const EXPRESS_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const NEXT_URL = process.env.E2E_NEXT_BASE_URL || 'http://localhost:3001';
const LOGIN_ID = process.env.E2E_LOGIN_ID || 'admin';
const PASSWORD = process.env.E2E_PASSWORD || 'Admin!2345';

const KEY_MIN = 'ai_rate_limit_per_minute';
const KEY_HOUR = 'ai_rate_limit_per_hour';
let saved = null;

test.beforeAll(async () => {
  // 운영 설정을 덮어쓰므로 원래 값을 기억해뒀다가 반드시 되돌린다.
  const rows = await db.all('SELECT key, value FROM app_settings WHERE key IN (?, ?)', [KEY_MIN, KEY_HOUR])
    .catch(() => []);
  saved = new Map(rows.map((r) => [r.key, r.value]));
});

test.afterAll(async () => {
  for (const key of [KEY_MIN, KEY_HOUR]) {
    if (saved && saved.has(key)) {
      await db.run('UPDATE app_settings SET value = ? WHERE key = ?', [saved.get(key), key]).catch(() => {});
    } else {
      await db.run('DELETE FROM app_settings WHERE key = ?', [key]).catch(() => {});
    }
  }
  await db.pool.end().catch(() => {});
});

test.describe('AI 사용량 · 사용량 제한', () => {
  test.describe.configure({ timeout: 180000 });

  test('접속기록에서 제한을 바꾸면 값이 그대로 남는다 (EJS)', async ({ page }) => {
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));

    await loginWithRetry(page, { baseUrl: EXPRESS_URL, loginId: LOGIN_ID, password: PASSWORD });
    const res = await page.goto(`${EXPRESS_URL}/access-logs`, { waitUntil: 'domcontentloaded' });
    expect(res.status()).toBe(200);
    await expect(page.getByText('AI 사용량 제한')).toBeVisible();

    await page.locator('#aiPerMinute').fill('77');
    await page.locator('#aiPerHour').fill('777');
    await page.getByRole('button', { name: '저장' }).click();

    await expect(page.getByText('AI 사용량 제한을 저장했습니다')).toBeVisible();
    // 저장 후 다시 그린 화면에 그 값이 들어 있어야 한다.
    await expect(page.locator('#aiPerMinute')).toHaveValue('77');
    await expect(page.locator('#aiPerHour')).toHaveValue('777');

    // DB까지 실제로 반영됐는지 — 화면만 맞고 저장이 안 되는 경우를 막는다.
    const row = await db.get('SELECT value FROM app_settings WHERE key = ?', [KEY_MIN]);
    expect(row && row.value).toBe('77');

    // 현재 사용량·차단 여부가 같은 화면에서 보여야 한다(사용자 요청) — 설정만 있고 지금 상태를
    // 못 보면 관리자는 한도를 얼마로 둘지 판단할 근거가 없다.
    await expect(page.getByText('현재 사용량')).toBeVisible();
    // 차단이 있었는지 없었는지 둘 중 하나는 반드시 문장으로 나와야 한다.
    const blockLine = page.getByText(/한도로 막힌 요청이 없습니다|차단 발생/);
    await expect(blockLine).toBeVisible();

    expect(problems, `페이지 오류: ${problems.join(' | ')}`).toEqual([]);
  });

  test('잘못된 값은 저장하지 않고 이유를 알려준다', async ({ page }) => {
    await loginWithRetry(page, { baseUrl: EXPRESS_URL, loginId: LOGIN_ID, password: PASSWORD });
    await page.goto(`${EXPRESS_URL}/access-logs`, { waitUntil: 'domcontentloaded' });

    // 시간당이 분당보다 작으면 분당 한도가 무의미해진다 — 알아채기 어려운 실수라 막아야 한다.
    await page.locator('#aiPerMinute').fill('100');
    await page.locator('#aiPerHour').fill('10');
    await page.getByRole('button', { name: '저장' }).click();
    await expect(page.getByText('시간당 한도는 분당 한도보다 작을 수 없습니다')).toBeVisible();

    const row = await db.get('SELECT value FROM app_settings WHERE key = ?', [KEY_MIN]);
    expect(row && row.value, '거부됐는데 저장되면 안 된다').toBe('77');
  });

  test('대시보드에 AI 사용량이 보인다 (Next)', async ({ page }) => {
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));

    const used = await db.get('SELECT COUNT(*) AS n FROM ai_call_logs').catch(() => ({ n: 0 }));
    test.skip(!used || Number(used.n) === 0, 'AI 호출 기록이 없어 카드가 뜨지 않습니다');

    await loginWithRetry(page, { baseUrl: NEXT_URL, loginId: LOGIN_ID, password: PASSWORD });
    const res = await page.goto(`${NEXT_URL}/?period=all`, { waitUntil: 'domcontentloaded' });
    expect(res.status()).toBe(200);

    await expect(page.getByText('AI 사용량').first()).toBeVisible();
    await expect(page.getByText('총 호출')).toBeVisible();
    await expect(page.getByText('평균 응답')).toBeVisible();
    // 용도 이름이 코드값(intake_extract)이 아니라 한글 라벨로 나와야 한다.
    // 같은 라벨이 표와 "가장 느렸던 용도" 두 곳에 나올 수 있어 첫 번째만 본다.
    await expect(page.getByText('접수 내용 추출').first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText('intake_extract');

    expect(problems, `페이지 오류: ${problems.join(' | ')}`).toEqual([]);
  });

  test('대시보드에 AI 사용량이 보인다 (EJS 롤백 화면)', async ({ page }) => {
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));

    const used = await db.get('SELECT COUNT(*) AS n FROM ai_call_logs').catch(() => ({ n: 0 }));
    test.skip(!used || Number(used.n) === 0, 'AI 호출 기록이 없어 카드가 뜨지 않습니다');

    await loginWithRetry(page, { baseUrl: EXPRESS_URL, loginId: LOGIN_ID, password: PASSWORD });
    const res = await page.goto(`${EXPRESS_URL}/?period=all`, { waitUntil: 'domcontentloaded' });
    expect(res.status()).toBe(200);
    await expect(page.getByText('AI 사용량').first()).toBeVisible();
    await expect(page.getByText('접수 내용 추출').first()).toBeVisible();

    expect(problems, `페이지 오류: ${problems.join(' | ')}`).toEqual([]);
  });
});
