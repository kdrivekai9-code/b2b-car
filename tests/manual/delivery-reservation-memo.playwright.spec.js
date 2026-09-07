// 도착지 인도시간 기준으로 고르면 기사메모에 도착 시각 한 줄이 붙는지.
//
// 왜 브라우저로 보나: 이 줄은 화면 스크립트가 만든다(public/js/order-form.js
// syncDeliveryReservationMemo). 기준 라디오·예약 드롭다운·경로 소요시간이 함께 맞물려야
// 나오는 값이라, 서버 쪽만 봐서는 문구가 실제로 붙는지 알 수 없다.
//
// 이 줄이 기사에게 닿는 유일한 도착시각 안내다. orders.reserved_date에는 픽업 시각이 들어가서
// (콜마너가 출발 기준으로 받는다) 기사 앱에는 도착 시각이 아예 없다.
const { test, expect } = require('@playwright/test');
const { loginWithRetry } = require('./helpers/auth');
const { LOGIN_ID, PASSWORD } = require('../e2e-credentials');

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';

test.describe.configure({ mode: 'serial', timeout: 120000 });

test.describe('도착지 인도시간 기준 — 기사메모', () => {
  let page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await loginWithRetry(page, { baseUrl: BASE, loginId: LOGIN_ID, password: PASSWORD });
  });
  test.afterAll(async () => { if (page) await page.close(); });

  async function openForm() {
    await page.goto(`${BASE}/orders/new`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#reservation_basis_delivery')).toBeVisible();
  }

  test('기준을 고르면 도착 시각 한 줄이 붙고, 되돌리면 사라진다', async () => {
    await openForm();
    const memo = page.locator('textarea[name="memo_customer"]');
    await memo.fill('회수서류 : 인수증 받아주세요');

    // 예약 시각을 정해둔다 — 이 값이 그대로 "도착 요청 시각"이 된다.
    await page.selectOption('#reserved_time_hour', '18');
    await page.selectOption('#reserved_time_minute', '30');
    await page.locator('#reservation_basis_delivery').check();

    // 문구는 "일시:"가 아니라 무슨 시각인지 드러나야 한다 — 기사가 픽업 시각으로 읽으면
    // 두 시간쯤 일찍 와서 기다리거나, 반대로 늦는다.
    await expect.poll(async () => memo.inputValue(), { timeout: 10000 })
      .toMatch(/도착지 인도시간 : .*18시 30분/);
    // 원래 쓰던 요청사항은 그대로 있어야 한다.
    expect(await memo.inputValue()).toContain('회수서류 : 인수증 받아주세요');
    expect(await memo.inputValue()).not.toMatch(/도착요망/);

    // 기준을 되돌리면 그 줄만 사라진다. 남으면 픽업 기준 오더에 없는 도착시각이 붙어 나간다.
    await page.locator('#reservation_basis_pickup').check();
    await expect.poll(async () => memo.inputValue(), { timeout: 10000 })
      .not.toMatch(/도착지 인도시간/);
    expect(await memo.inputValue()).toContain('회수서류 : 인수증 받아주세요');
  });

  test('기준을 여러 번 바꿔도 줄이 쌓이지 않는다', async () => {
    await openForm();
    const memo = page.locator('textarea[name="memo_customer"]');
    await memo.fill('원문');
    await page.selectOption('#reserved_time_hour', '18');
    await page.selectOption('#reserved_time_minute', '30');

    for (let i = 0; i < 3; i += 1) {
      await page.locator('#reservation_basis_delivery').check();
      await expect.poll(async () => memo.inputValue(), { timeout: 10000 }).toMatch(/도착지 인도시간/);
      await page.locator('#reservation_basis_pickup').check();
      await expect.poll(async () => memo.inputValue(), { timeout: 10000 }).not.toMatch(/도착지 인도시간/);
    }
    await page.locator('#reservation_basis_delivery').check();
    await expect.poll(async () => memo.inputValue(), { timeout: 10000 }).toMatch(/도착지 인도시간/);
    // 한 줄이어야 한다 — 지우는 규칙이 틀리면 바꿀 때마다 한 줄씩 쌓인다.
    const lines = (await memo.inputValue()).split('\n').filter((l) => l.includes('도착지 인도시간'));
    expect(lines).toHaveLength(1);
  });

  test('예전 문구로 저장돼 있던 줄도 걷어낸다', async () => {
    await openForm();
    const memo = page.locator('textarea[name="memo_customer"]');
    // 이 형식으로 저장된 오더가 이미 있다. 수정 화면에서 기준을 건드릴 때 안 걷어내면
    // 옛 줄과 새 줄이 함께 남아 기사에게 시각이 두 개로 보인다.
    await memo.fill('원문\n일시: 07/27 18시30분 도착요망');
    await page.selectOption('#reserved_time_hour', '18');
    await page.selectOption('#reserved_time_minute', '30');
    await page.locator('#reservation_basis_delivery').check();

    await expect.poll(async () => memo.inputValue(), { timeout: 10000 }).toMatch(/도착지 인도시간/);
    expect(await memo.inputValue()).not.toMatch(/일시:/);
    expect(await memo.inputValue()).not.toMatch(/도착요망/);
  });
});
