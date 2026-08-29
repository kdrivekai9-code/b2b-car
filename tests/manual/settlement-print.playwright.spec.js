// 정산내역서 출력(내부 결재용)이 화면과 같은 금액을 보여주는지.
//
// 서류와 화면이 다른 숫자를 보이면 어느 쪽을 믿을지 알 수 없다. 결재까지 올라간 뒤에 발견되면
// 이미 늦다. 그래서 "열린다"가 아니라 **같은 금액인지**를 본다.
//
// 표시 방식(포함/별도 줄)도 함께 본다 — 총 청구액은 어느 쪽이든 같아야 한다.
const { test, expect } = require('@playwright/test');
const db = require('../../db');
const { loginWithRetry } = require('./helpers/auth');

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
// 로그인 계정: 실사용 admin으로 로그인하면 단일 세션 강제 때문에 그 계정을 쓰던 사람이
// 로그아웃된다 — QA 전용 계정을 쓴다. 비밀번호는 .env(E2E_PASSWORD)에서 온다.
const LOGIN_ID = process.env.E2E_LOGIN_ID || 'qa_test_bot';
const PASSWORD = process.env.E2E_PASSWORD || '';

const MARK = 'e2e-print';
const MONTH = '2019-11';
let groupId = null;
let originalMode = null;

async function wipe() {
  const rows = await db.all('SELECT id FROM orders WHERE oid LIKE ?', [`${MARK}%`]).catch(() => []);
  for (const r of rows) {
    await db.run('DELETE FROM order_extra_charges WHERE order_id = ?', [r.id]).catch(() => {});
    await db.run('DELETE FROM order_status_history WHERE order_id = ?', [r.id]).catch(() => {});
    await db.run('DELETE FROM orders WHERE id = ?', [r.id]).catch(() => {});
  }
}

test.beforeAll(async () => {
  await wipe();
  const g = await db.get('SELECT id, branch_id, settlement_surcharge_mode FROM groups_tbl ORDER BY id LIMIT 1');
  if (!g) return;
  groupId = Number(g.id);
  originalMode = g.settlement_surcharge_mode;

  // 청구액 105,000원 = 기본 97,000 + 수입차 5,000 + 야간 3,000 (할증은 이미 fare_amount에 있다)
  const row = await db.get(
    `INSERT INTO orders (oid, branch_id, requester_group_id, status, reserved_date, reserved_time,
                         vehicle_number, origin_address, destination_address, fare_amount, ferry_fare_amount,
                         fare_surcharges_json)
     VALUES (?, ?, ?, '완료', '2019-11-05', '23:30', '11가2233', ?, '검사도착', 105000, 0, ?) RETURNING id`,
    [`${MARK}-1`, g.branch_id, groupId, `${MARK}출발지`,
      JSON.stringify([
        { code: 'imported', label: '수입차 할증', amount: 5000 },
        { code: 'night', label: '야간/조조 할증', amount: 3000 },
      ])]
  );
  await db.run(
    `INSERT INTO order_status_history (order_id, old_status, new_status, created_at)
     VALUES (?, '기사배정', '완료', ?)`, [row.id, `${MONTH}-05 23:59:00`]
  );
  // 기타 정산(별도 청구) 한 줄 — 서류에 함께 나와야 한다.
  await db.run(
    `INSERT INTO order_extra_charges (order_id, charge_type, amount, charged_on, billable, note)
     VALUES (?, '주유비', 40000, ?, true, 'e2e')`, [row.id, `${MONTH}-05`]
  );
});

test.afterAll(async () => {
  if (groupId) {
    await db.run('UPDATE groups_tbl SET settlement_surcharge_mode = ? WHERE id = ?',
      [originalMode || 'included', groupId]).catch(() => {});
  }
  await wipe();
  await db.pool.end().catch(() => {});
});

test.describe('정산내역서 출력', () => {
  test.describe.configure({ timeout: 240000 });

  test('결재 서류 형식으로 열리고, 금액이 화면과 같다', async ({ page }) => {
    test.skip(!groupId, '법인이 없습니다');
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));
    // 자동 인쇄 대화상자는 검사에서 창을 막는다 — 미리보기 모드로 연다.
    await page.addInitScript(() => { window.print = () => {}; });

    await db.run('UPDATE groups_tbl SET settlement_surcharge_mode = ? WHERE id = ?', ['included', groupId]);
    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });

    const res = await page.goto(`${BASE_URL}/groups/${groupId}/settlement/print?month=${MONTH}&autoprint=0`,
      { waitUntil: 'domcontentloaded' });
    expect(res.status()).toBe(200);

    // 서류로 쓰려면 있어야 하는 것들.
    await expect(page.locator('h1')).toContainText('정 산 내 역 서');
    await expect(page.getByText(MONTH, { exact: false }).first()).toBeVisible();
    // 결재란은 걷어냈다(사용자 지시) — 다시 생기면 여기서 걸린다.
    await expect(page.locator('.approval')).toHaveCount(0);
    // 정보표가 전체 폭을 쓴다. 2단으로 감싸던 표가 남아 있으면 왼쪽 2/3에만 찍혀 여백이 뜬다.
    await expect(page.locator('.meta')).toHaveCount(1);
    await expect(page.getByText('발행일', { exact: false })).toBeVisible();
    await expect(page.getByText('공급받는자', { exact: false })).toBeVisible();

    // 명세가 실려야 한다.
    // 운행요금과 기타 정산 양쪽에 같은 출발지가 나온다(정상) — 첫 줄만 확인한다.
    await expect(page.getByText(`${MARK}출발지`).first()).toBeVisible();
    await expect(page.getByText('주유비', { exact: false }).first()).toBeVisible();

    // 총 청구액 = 운행요금 105,000 + 기타 40,000 = 145,000원
    await expect(page.locator('.grand')).toContainText('145,000원');

    // 사이드바·네비게이션이 같이 찍히면 서류로 못 쓴다.
    expect(await page.locator('.sidebar, nav, header').count(), '공용 레이아웃이 없어야 한다').toBe(0);
    // 인쇄 버튼은 화면에만 있고 종이에는 안 나와야 한다(@media print에서 숨긴다).
    await expect(page.locator('.toolbar')).toBeVisible();
    const hiddenOnPrint = await page.evaluate(() => {
      const sheets = Array.from(document.styleSheets);
      return sheets.some((s) => Array.from(s.cssRules || []).some((r) =>
        r.conditionText === 'print' && String(r.cssText).includes('.toolbar')));
    });
    expect(hiddenOnPrint, '인쇄 시 버튼을 숨기는 규칙').toBe(true);

    expect(problems, `페이지 오류: ${problems.join(' | ')}`).toEqual([]);
  });

  // 표시 방식은 정산내역 화면 상단에서 바꾼다(사용자 지시) — 바꾸고 바로 아래에서 결과를
  // 확인할 수 있어야 한다. 요금 설정 화면에 있으면 바꾼 뒤 정산으로 옮겨가 확인해야 한다.
  test('정산내역 상단에서 표시 방식을 바꾸면 그 자리에서 반영된다', async ({ page }) => {
    test.skip(!groupId, '법인이 없습니다');
    await db.run('UPDATE groups_tbl SET settlement_surcharge_mode = ? WHERE id = ?', ['included', groupId]);
    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    await page.goto(`${BASE_URL}/groups/${groupId}/settlement?month=${MONTH}`, { waitUntil: 'domcontentloaded' });

    const card = page.locator('.card', { hasText: '정산서 할증 표시' });
    await expect(card).toHaveCount(1);
    // 정산 목록보다 **위에** 있어야 한다 — 바꾸고 바로 아래에서 결과를 봐야 한다.
    const cardY = await card.boundingBox();
    const listY = await page.locator('.settlement-table').boundingBox();
    expect(cardY.y, '할증 표시 설정이 명세보다 위에 있어야 한다').toBeLessThan(listY.y);

    // 포함 방식: 운행요금 합계에 할증이 들어 있다.
    await expect(page.locator('.settlement-table tfoot')).toContainText('105,000원');

    await card.locator('input[value="itemized"]').check();
    await card.getByRole('button', { name: '적용' }).click();
    await page.waitForURL(/saved=/, { timeout: 30000 });

    // 조회하던 달이 유지돼야 한다 — 이번 달로 튕기면 방금 보던 정산서를 잃는다.
    expect(page.url()).toContain(`month=${MONTH}`);
    expect((await db.get('SELECT settlement_surcharge_mode FROM groups_tbl WHERE id = ?', [groupId]))
      .settlement_surcharge_mode).toBe('itemized');

    // 별도 줄 방식: 운행요금은 할증을 뺀 금액, 할증은 따로.
    await expect(page.locator('.settlement-table tfoot')).toContainText('97,000원');
    await expect(page.locator('.surcharge-table')).toContainText('수입차 할증');
    // 총 청구액은 그대로.
    await expect(page.locator('.stat-row').getByText('총 청구액').locator('..')).toContainText('145,000원');
  });

  test('표시 방식을 바꿔도 총 청구액은 같다', async ({ page }) => {
    test.skip(!groupId, '법인이 없습니다');
    await page.addInitScript(() => { window.print = () => {}; });
    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });

    const url = `${BASE_URL}/groups/${groupId}/settlement/print?month=${MONTH}&autoprint=0`;

    await db.run('UPDATE groups_tbl SET settlement_surcharge_mode = ? WHERE id = ?', ['included', groupId]);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // 포함 방식: 운행요금 소계가 할증까지 든 금액이다.
    await expect(page.locator('.rows tfoot').first()).toContainText('105,000원');
    await expect(page.locator('.grand')).toContainText('145,000원');

    await db.run('UPDATE groups_tbl SET settlement_surcharge_mode = ? WHERE id = ?', ['itemized', groupId]);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // 별도 줄 방식: 운행요금은 할증을 뺀 97,000원, 할증은 따로 8,000원.
    await expect(page.locator('.rows tfoot').first()).toContainText('97,000원');
    await expect(page.getByText('수입차 할증', { exact: false })).toBeVisible();
    // **총 청구액은 그대로여야 한다** — 표시 방식이 청구액을 바꾸면 안 된다.
    await expect(page.locator('.grand')).toContainText('145,000원');
  });
});
