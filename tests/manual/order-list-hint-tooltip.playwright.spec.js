// 오더 리스트 경고 표시의 설명 풍선 — 마우스를 올리자마자 사유가 뜨는지.
//
// 왜 필요한가: 사유는 원래 title 속성에만 있었다. 브라우저 기본 툴팁은 1초쯤 기다려야 떠서
// "사유를 안 알려준다"로 읽혔다(실사용 지적 2026-09-07 — 예약일 '!' 표시). 표시가 붙은 이유를
// 바로 알 수 있어야 그 표시가 값어치를 한다.
//
// 잘림도 함께 본다. 표는 .table-wrap(overflow-x:auto) 안이라 셀 안에서 만든 풍선은 그 경계에서
// 잘린다 — 그래서 body에 하나 두고 좌표만 옮긴다(public/js/hint-tooltip.js).
const { test, expect } = require('@playwright/test');
const { loginWithRetry } = require('./helpers/auth');
const { LOGIN_ID, PASSWORD } = require('../e2e-credentials');
const db = require('../../db');

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const MARK = 'zzq툴팁검사';

test.describe.configure({ mode: 'serial', timeout: 120000 });

test.describe('오더 리스트 경고 표시 설명', () => {
  let page;
  let orderId = null;

  test.beforeAll(async ({ browser }) => {
    // 예약일이 먼 미래인 오더를 하나 만든다. 실데이터에 그런 건이 있기를 기다리면(대개 없다)
    // 검사가 조용히 아무것도 안 보게 된다.
    const donor = await db.get(
      `SELECT branch_id, requester_group_id, created_by FROM orders
        WHERE branch_id IS NOT NULL ORDER BY id DESC LIMIT 1`);
    const far = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
    const made = await db.get(
      `INSERT INTO orders (oid, branch_id, requester_group_id, status, reserved_date, reserved_time,
         origin_address, destination_address, fare_amount, created_by)
       VALUES (?, ?, ?, '접수', ?, '10:00', 'a', 'b', 0, ?) RETURNING id`,
      [MARK, donor.branch_id, donor.requester_group_id, far, donor.created_by]);
    orderId = made.id;

    page = await browser.newPage();
    await loginWithRetry(page, { baseUrl: BASE, loginId: LOGIN_ID, password: PASSWORD });
  });

  test.afterAll(async () => {
    if (page) await page.close();
    if (orderId) {
      await db.run('DELETE FROM order_status_history WHERE order_id = ?', [orderId]).catch(() => {});
      await db.run('DELETE FROM orders WHERE id = ?', [orderId]).catch(() => {});
    }
    // 풀은 여기서 닫지 않는다 — tests/global-teardown.js가 전부 끝난 뒤 한 번 닫는다.
  });

  test('예약일 표시에 마우스를 올리면 곧바로 사유가 뜬다', async () => {
    await page.goto(`${BASE}/orders?q=${encodeURIComponent(MARK)}`, { waitUntil: 'domcontentloaded' });
    const mark = page.locator('.date-odd-mark').first();
    await expect(mark).toBeVisible();

    // 사유는 data-hint에 있다. title로 두면 기본 툴팁이라 늦게 뜬다.
    await expect(mark).toHaveAttribute('data-hint', /예약일이 \d+일 뒤입니다/);
    await expect(mark).not.toHaveAttribute('title', /.*/);

    const bubble = page.locator('.hint-bubble');
    await expect(bubble).toBeHidden();
    await mark.hover();
    // 지체 없이 떠야 한다 — 기본 툴팁(약 1초)보다 빨라야 바꾼 의미가 있다.
    await expect(bubble).toBeVisible({ timeout: 400 });
    await expect(bubble).toContainText('예약일이');
    await expect(bubble).toContainText('연도를 확인해주세요');

    // 표 경계에 잘리지 않는지 — 풍선이 표 바깥(body)에 있어야 한다.
    const inWrap = await bubble.evaluate((el) => !!el.closest('.table-wrap'));
    expect(inWrap).toBe(false);
    // 화면 안에 들어와 있어야 한다(아래로 넘치면 위로 뒤집는다).
    const box = await bubble.boundingBox();
    const vh = page.viewportSize().height;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(vh);
  });

  test('마우스를 떼면 사라지고, 키보드로도 볼 수 있다', async () => {
    await page.goto(`${BASE}/orders?q=${encodeURIComponent(MARK)}`, { waitUntil: 'domcontentloaded' });
    const mark = page.locator('.date-odd-mark').first();
    const bubble = page.locator('.hint-bubble');

    await mark.hover();
    await expect(bubble).toBeVisible({ timeout: 400 });
    // 표 밖으로 마우스를 옮기면 닫힌다.
    await page.locator('h1').first().hover();
    await expect(bubble).toBeHidden();

    // 마우스를 못 쓰는 사람도 사유를 봐야 한다 — tabindex로 초점을 받게 해뒀다.
    await mark.focus();
    await expect(bubble).toBeVisible({ timeout: 400 });
    await page.keyboard.press('Escape');
    await expect(bubble).toBeHidden();
  });
});
