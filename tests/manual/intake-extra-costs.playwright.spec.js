// 접수 단계 부대비용 UI — 도착지 아래 "+ 부대비용 추가".
//
// 서버 쪽 규칙은 scripts/check-intake-extra-costs.js가 못 박는다. 여기서 보는 것은 화면에서만
// 드러나는 것들이다: 항목을 바꾸면 확장 선택지가 따라 바뀌는지, '가득'을 고르면 금액칸이
// 사라지는지, 도선료를 두 번 못 고르는지. 이 셋은 서버에서 확인할 수 없다.
const { test, expect } = require('@playwright/test');
const { loginWithRetry } = require('./helpers/auth');
// 계정·비밀번호는 한 곳에서 가져온다 — 값이 없으면 즉시 멈춘다(tests/e2e-credentials.js).
// 실사용 admin으로 로그인하면 단일 세션 강제 때문에 그 계정을 쓰던 사람이 로그아웃된다.
const { LOGIN_ID, PASSWORD } = require('../e2e-credentials');

const BASE = process.env.E2E_NEXT_BASE_URL || 'http://localhost:3001';

test.describe('접수 단계 부대비용', () => {
  test.beforeEach(async ({ page }) => {
    await loginWithRetry(page, { baseUrl: BASE, loginId: LOGIN_ID, password: PASSWORD });
  });

  test('항목별 확장 선택지와 정산구분이 따라 바뀐다', async ({ page }) => {
    await page.goto(`${BASE}/orders/new`, { waitUntil: 'domcontentloaded' });

    const block = page.locator('.extra-cost-block');
    await expect(block).toBeVisible();
    // 아직 아무것도 안 넣었으면 줄이 없어야 한다 — 빈 줄이 기본으로 있으면 안 쓰는 사람도
    // 매번 지워야 한다.
    await expect(block.locator('.extra-cost-row')).toHaveCount(0);

    const addBtn = block.getByRole('button', { name: '+ 부대비용 추가' });
    await addBtn.click();
    const row = block.locator('.extra-cost-row').first();
    await expect(row).toBeVisible();

    // 기본은 첫 항목(주유비) + 첫 선택지(가득).
    const typeSel = row.locator('select').nth(0);
    const optionSel = row.locator('select').nth(1);
    await expect(typeSel).toHaveValue('주유비');
    await expect(optionSel).toHaveValue('full');
    // '가득'은 접수 시점에 금액을 모른다 — 금액칸 대신 안내가 있어야 한다.
    await expect(row.locator('input[type="number"]')).toHaveCount(0);
    await expect(row.getByText('금액은 영수증 확인 후 입력')).toBeVisible();

    // '금액입력'을 고르면 금액칸이 나온다.
    await optionSel.selectOption('amount');
    await expect(row.locator('input[type="number"]')).toBeVisible();

    // 항목을 세차비로 바꾸면 선택지가 세차비의 것으로 갈아끼워진다. 남아 있으면 서버가
    // 버리고 사용자는 왜 빠졌는지 모른다.
    await typeSel.selectOption('세차비');
    await expect(optionSel).toHaveValue('auto_wash');
    const optionLabels = await optionSel.locator('option').allInnerTexts();
    expect(optionLabels).toEqual(['인근주유소 자동세차', '손세차']);

    // 정산구분은 세 가지가 전부 있어야 한다(사용자 지시).
    const modeLabels = await row.locator('select').nth(2).locator('option').allInnerTexts();
    expect(modeLabels).toEqual(['포함(청구 불가)', '제외 · 실비 월정산', '제외 · 실비 개별정산']);
  });

  test('같은 항목을 여러 줄 넣을 수 있고, 도선료는 한 줄만', async ({ page }) => {
    await page.goto(`${BASE}/orders/new`, { waitUntil: 'domcontentloaded' });
    const block = page.locator('.extra-cost-block');
    const addBtn = block.getByRole('button', { name: '+ 부대비용 추가' });

    // 중복 설정이 되어야 한다(사용자 지시) — 주유비를 두 줄.
    await addBtn.click();
    await addBtn.click();
    await expect(block.locator('.extra-cost-row')).toHaveCount(2);
    await expect(block.locator('.extra-cost-row').nth(1).locator('select').nth(0)).toHaveValue('주유비');

    // 도선료는 금액 출처가 orders.ferry_fare_amount 하나뿐이라 두 줄이면 두 번 청구된다.
    const first = block.locator('.extra-cost-row').nth(0);
    await first.locator('select').nth(0).selectOption('도선료');
    const secondType = block.locator('.extra-cost-row').nth(1).locator('select').nth(0);
    await expect(secondType.locator('option[value="도선료"]')).toBeDisabled();

    // 도선료 줄의 금액은 경로탐색이 채운다 — 칸은 있어야 고칠 수 있다.
    await expect(first.locator('input[type="number"]')).toBeVisible();

    // 삭제하면 다시 고를 수 있어야 한다.
    await first.getByRole('button', { name: '삭제' }).click();
    await expect(block.locator('.extra-cost-row')).toHaveCount(1);
    await expect(block.locator('.extra-cost-row').nth(0).locator('option[value="도선료"]')).toBeEnabled();
  });

  test('요금설정 부대비용에 충전비가 있다', async ({ page }) => {
    // 접수 화면에서 충전비를 고를 수 있어도 요금설정에 항목이 없으면 정산구분을 정할 수 없다.
    await page.goto(`${BASE}/orders/new`, { waitUntil: 'domcontentloaded' });
    const block = page.locator('.extra-cost-block');
    await block.getByRole('button', { name: '+ 부대비용 추가' }).click();
    const typeSel = block.locator('.extra-cost-row').first().locator('select').nth(0);
    const labels = await typeSel.locator('option').allInnerTexts();
    expect(labels).toEqual(['주유비', '충전비', '세차비', '주차비', '도선료']);

    await typeSel.selectOption('충전비');
    const optionLabels = await block.locator('.extra-cost-row').first().locator('select').nth(1)
      .locator('option').allInnerTexts();
    // 충전비는 주유비와 같은 규칙으로 돈다.
    expect(optionLabels).toEqual(['가득(full)', '금액입력']);
  });
});
