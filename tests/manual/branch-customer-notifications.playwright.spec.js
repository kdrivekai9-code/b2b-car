// 지사관리 "고객 통보" 설정 화면 — 상태별 사용 여부·보내는 시점·문구를 저장한다.
//
// 이 화면의 값이 그대로 고객에게 나가는 문구가 된다. 저장이 조용히 안 되면 관리자는 바꿨다고
// 믿는데 실제로는 옛 문구가 계속 나간다 — 화면만 보고는 알 수 없는 종류의 고장이라 여기서 본다.
const { test, expect } = require('@playwright/test');
const db = require('../../db');
const { loginWithRetry } = require('./helpers/auth');

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const LOGIN_ID = process.env.E2E_LOGIN_ID || 'admin';
const PASSWORD = process.env.E2E_PASSWORD || 'Admin!2345';

let branchId = null;
let savedRows = [];

// 이 DB는 프로덕션과 같다. 지사가 실제로 저장해둔 설정이 있을 수 있으므로, 손대기 전에 그대로
// 떠놓고 끝나면 되돌린다 — "테스트가 만든 행을 지운다"만으로는 원래 있던 행까지 날아간다.
test.beforeAll(async () => {
  const branch = await db.get('SELECT id FROM branches ORDER BY id LIMIT 1');
  branchId = branch ? Number(branch.id) : null;
  if (!branchId) return;
  savedRows = await db.all(
    'SELECT event_type, enabled, delay_minutes, message_template FROM branch_customer_notifications WHERE branch_id = ?',
    [branchId]
  ).catch(() => []);
});

test.afterAll(async () => {
  if (branchId) {
    await db.run('DELETE FROM branch_customer_notifications WHERE branch_id = ?', [branchId]).catch(() => {});
    for (const row of savedRows) {
      await db.run(`
        INSERT INTO branch_customer_notifications (branch_id, event_type, enabled, delay_minutes, message_template)
        VALUES (?, ?, ?, ?, ?)
      `, [branchId, row.event_type, row.enabled, row.delay_minutes, row.message_template]).catch(() => {});
    }
  }
  await db.pool.end().catch(() => {});
});

async function openPage(page) {
  await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
  // 첫 지사를 대상으로 본다 — 어느 지사든 화면 구조는 같다.
  await page.goto(`${BASE_URL}/branches`, { waitUntil: 'domcontentloaded' });
  const firstTab = page.locator('.branch-tabs a', { hasText: '고객 통보' }).first();
  await expect(firstTab).toBeVisible();
  await firstTab.click();
  await page.waitForLoadState('domcontentloaded');
  // 화면이 고른 지사가 스냅샷을 뜬 지사와 같은지 확인한다 — 다르면 엉뚱한 지사를 되돌리게 된다.
  const match = page.url().match(/\/branches\/(\d+)\/customer-notifications/);
  expect(match && Number(match[1])).toBe(branchId);
}

test.describe('지사관리 · 고객 통보', () => {
  test.describe.configure({ timeout: 90000 });

  test('다섯 가지 사건이 모두 설정 대상으로 나온다', async ({ page }) => {
    await openPage(page);

    // 사건이 하나 늘었는데 화면에서 빠지면, 그 통보만 아무도 못 끄는 상태가 된다.
    for (const key of ['dispatched', 'completed', 'dispatch_cancelled', 'cancelled', 'not_dispatched']) {
      await expect(page.locator(`textarea[name="message_${key}"]`)).toBeVisible();
      await expect(page.locator(`input[name="delay_${key}"]`)).toBeVisible();
      await expect(page.locator(`input[name="enabled_${key}"]`)).toBeVisible();
    }

    // 배차완료만 기본이 1분 뒤다(배차 직후 취소 때문에).
    await expect(page.locator('input[name="delay_dispatched"]')).toHaveValue('1');
    await expect(page.locator('input[name="delay_completed"]')).toHaveValue('0');
    await expect(page.locator('input[name="delay_not_dispatched"]')).toHaveValue('30');

    // 미배정만 시점의 뜻이 다르다("접수 후 30분이 지나도 미배차면"). 같은 라벨을 쓰면 30을
    // 넣어놓고 "상태 변경 30분 뒤"로 읽게 된다.
    await expect(page.locator('.notify-event-block').last()).toContainText('접수 후');
    await expect(page.locator('.notify-event-block').last()).toContainText('미배차면');
  });

  test('바꾼 문구와 시점이 저장되고 다시 열어도 남아 있다', async ({ page }) => {
    await openPage(page);
    const url = page.url();

    const marker = `자동확인-${Date.now()}`;
    const original = await page.locator('textarea[name="message_completed"]').inputValue();
    const originalDelay = await page.locator('input[name="delay_completed"]').inputValue();

    try {
      await page.locator('textarea[name="message_completed"]').fill(`{oid} ${marker}`);
      await page.locator('input[name="delay_completed"]').fill('3');
      await page.locator('button[type="submit"][form="customerNotificationsForm"]').click();
      await page.waitForLoadState('domcontentloaded');

      await expect(page.locator('.success-msg')).toContainText('저장되었습니다');
      // 저장 후 화면이 아니라 다시 불러온 화면에서 확인한다 — 폼에 남은 값은 저장 여부를 증명하지 못한다.
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('textarea[name="message_completed"]')).toHaveValue(`{oid} ${marker}`);
      await expect(page.locator('input[name="delay_completed"]')).toHaveValue('3');
    } finally {
      // 실제 운영 지사의 설정이라 원래 값으로 되돌린다.
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.locator('textarea[name="message_completed"]').fill(original);
      await page.locator('input[name="delay_completed"]').fill(originalDelay);
      await page.locator('button[type="submit"][form="customerNotificationsForm"]').click();
      await page.waitForLoadState('domcontentloaded');
    }
  });

  test('잘못된 값은 저장하지 않고 이유를 알려준다', async ({ page }) => {
    await openPage(page);

    await page.locator('textarea[name="message_cancelled"]').fill('   ');
    await page.locator('button[type="submit"][form="customerNotificationsForm"]').click();
    await page.waitForLoadState('domcontentloaded');

    // 빈 문구가 저장되면 그 상태에서는 고객에게 아무 말도 못 하게 된다.
    await expect(page.locator('.error-msg')).toContainText('문구를 입력해주세요');
  });
});
