// 접수 단계 부대비용 — EJS 화면(Express :3000) 쪽. Next 화면은 intake-extra-costs 스펙이 본다.
//
// 왜 따로 필요한가: 부대비용 블록은 Next(ExtraCostSection.js)와 EJS(form.ejs + order-form.js)에
// 두 벌 있고, 프로덕션이 지금 띄우는 오더등록·챗봇 접수장은 EJS다. 기존 스펙은 :3001만 봐서
// 아래 두 가지를 놓쳤다.
//
//  1) 챗봇 접수장(ai_intake.ejs)에는 블록이 아예 없었다 — 서버는 진작 intakeExtra를 내려주고
//     있었는데(buildAiIntakeInitData) 화면만 없어서, 챗봇으로 접수하면 주유·세차 지시를 넣을
//     칸이 없었다. Next 화면은 OrderForm을 통째로 재사용해 이미 있었다(그래서 더 안 보였다).
//  2) 검증 실패로 폼을 다시 그릴 때 intakeExtra를 안 넘겨서 블록이 통째로 사라지고, 넣어둔
//     줄도 함께 날아갔다.
const { test, expect } = require('@playwright/test');
const { loginWithRetry } = require('./helpers/auth');
// 계정·비밀번호는 한 곳에서 가져온다 — 값이 없으면 즉시 멈춘다(tests/e2e-credentials.js).
const { LOGIN_ID, PASSWORD } = require('../e2e-credentials');

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';

// 주소칸에 값을 넣고 나가면 order-form.js가 카카오 검색을 부른다 — 실제 API로 나가지 않게
// 고정한다. 이 스펙이 보는 것은 주소 확정이 아니라 부대비용 줄이다.
async function stubAddressSearch(page) {
  await page.route('**/kakao/search**', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') || '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        documents: [{ type: 'address', place_name: null, road_address: q, jibun_address: null, lat: '37.5', lon: '127.0' }],
      }),
    });
  });
  await page.route('**/kakao/region**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sido: '서울', sigugun: '강서구', dong: '화곡동' }) });
  });
}

test.describe('접수 단계 부대비용 (EJS)', () => {
  test.describe.configure({ timeout: 90000 });

  test.beforeEach(async ({ page }) => {
    await loginWithRetry(page, { baseUrl: BASE, loginId: LOGIN_ID, password: PASSWORD });
  });

  test('챗봇 접수장에도 부대비용 블록이 있고 줄을 추가할 수 있다', async ({ page }) => {
    await page.goto(`${BASE}/orders/ai-intake`, { waitUntil: 'domcontentloaded' });

    const block = page.locator('.extra-cost-block');
    await expect(block).toBeVisible();
    // 기본은 빈 상태 — 안 쓰는 사람이 매번 지우게 하지 않는다(오더등록 폼과 같은 규칙).
    await expect(block.locator('.extra-cost-row')).toHaveCount(0);

    await block.getByRole('button', { name: '+ 부대비용 추가' }).click();
    const row = block.locator('.extra-cost-row').first();
    await expect(row).toBeVisible();
    await expect(row.locator('select').nth(0)).toHaveValue('주유비');

    // 폼 필드 이름이 서버(extraCharges.parseIntakeRows)가 읽는 것과 같아야 저장된다. 챗봇은
    // 폼 전체를 FormData로 떠서 POST /orders로 보내므로(ai-intake.js submitOrderForm),
    // 이름만 맞으면 오더등록 폼과 완전히 같은 경로로 저장된다.
    await expect(row.locator('select[name="intake_extra_type[]"]')).toHaveCount(1);
    await expect(row.locator('select[name="intake_extra_option[]"]')).toHaveCount(1);
    await expect(row.locator('select[name="intake_extra_mode[]"]')).toHaveCount(1);
    await expect(row.locator('input[name="intake_extra_amount[]"]')).toHaveCount(1);

    // 법인을 바꾸면 정산구분 기본값을 다시 받아온다 — 그 조회가 잡는 셀렉트에 id가 있어야 한다.
    await expect(page.locator('#requester_group_id')).toHaveCount(1);
  });

  test('검증 실패로 다시 그려도 부대비용 블록과 넣어둔 줄이 남는다', async ({ page }) => {
    await stubAddressSearch(page);
    await page.goto(`${BASE}/orders/new`, { waitUntil: 'domcontentloaded' });

    const block = page.locator('.extra-cost-block');
    await expect(block).toBeVisible();

    // 첫 줄: 주유비 · 금액입력 · 50,000 · 개별정산
    await block.getByRole('button', { name: '+ 부대비용 추가' }).click();
    const row1 = block.locator('.extra-cost-row').nth(0);
    await row1.locator('select').nth(1).selectOption('amount');
    await row1.locator('input[type="number"]').fill('50000');
    await row1.locator('select').nth(2).selectOption('individual');

    // 둘째 줄: 세차비 · 손세차
    await block.getByRole('button', { name: '+ 부대비용 추가' }).click();
    const row2 = block.locator('.extra-cost-row').nth(1);
    await row2.locator('select').nth(0).selectOption('세차비');
    await row2.locator('select').nth(1).selectOption('hand_wash');

    await page.fill('#origin_address', '서울 강서구 양천로53길 30');
    await page.fill('#origin_contact', '010-1111-2222');
    await page.fill('#destination_address', '경기 성남시 분당구 판교역로 160');
    await page.fill('#destination_contact', '010-3333-4444');

    // 지사를 고르지 않은 채 보낸다. 브라우저 필수검사(required)를 끄는 이유: 실사용에서 이
    // 재렌더 경로를 타는 것은 대개 운영시간 밖 접수인데, 그건 테스트를 돌린 시각에 따라
    // 결과가 갈린다. 서버가 폼을 다시 그리는 경로 자체는 어느 사유든 같으므로, 시각과
    // 무관하게 확정적으로 재현되는 "지사 미선택"으로 그 경로를 태운다.
    await page.evaluate(() => { document.getElementById('orderForm').noValidate = true; });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.locator('#orderForm button[type="submit"]').first().click(),
    ]);

    await expect(page.getByText('지사를 선택해주세요')).toBeVisible();

    // 블록이 살아 있고(항목 정의를 안 넘기면 통째로 사라졌다), 넣어둔 두 줄이 그대로 있다.
    const back = page.locator('.extra-cost-block');
    await expect(back).toBeVisible();
    await expect(back.locator('.extra-cost-row')).toHaveCount(2);

    const r1 = back.locator('.extra-cost-row').nth(0);
    await expect(r1.locator('select').nth(0)).toHaveValue('주유비');
    await expect(r1.locator('select').nth(1)).toHaveValue('amount');
    await expect(r1.locator('input[type="number"]')).toHaveValue('50000');
    await expect(r1.locator('select').nth(2)).toHaveValue('individual');

    const r2 = back.locator('.extra-cost-row').nth(1);
    await expect(r2.locator('select').nth(0)).toHaveValue('세차비');
    await expect(r2.locator('select').nth(1)).toHaveValue('hand_wash');
  });
});
