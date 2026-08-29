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
    // 금액 통계는 두 칸짜리 표다 — 총 청구액 줄(tfoot)을 집는다.
    await expect(page.locator('.stat-table .stat-total')).toContainText('145,000원');
  });

  // 금액 통계는 자릿수를 맞춰 읽는 표다 — 가로로 늘어놓으면 숫자가 자리마다 다른 위치에
  // 찍혀 크기 비교가 안 된다(사용자 지적).
  // 운행요금은 대분류이고 그 아래 구간요금·할증·대기·취소가 붙는다(사용자 지시). 기타 정산은
  // 항목별로 나뉜다 — "기타 120,000원"만으로는 무엇을 청구받는지 알 수 없다.
  test('운행요금 대분류 + 서브 항목, 기타정산 항목별로 나온다', async ({ page }) => {
    test.skip(!groupId, '법인이 없습니다');
    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    await page.goto(`${BASE_URL}/groups/${groupId}/settlement?month=${MONTH}`, { waitUntil: 'domcontentloaded' });

    const stat = page.locator('.stat-table');
    await expect(stat.locator('.stat-group', { hasText: '운행요금' })).toHaveCount(1);
    for (const sub of ['구간요금', '할증요금', '대기요금', '취소요금']) {
      await expect(stat.getByText(`└ ${sub}`, { exact: false })).toHaveCount(1);
    }
    await expect(stat.locator('.stat-group', { hasText: '기타 정산' })).toHaveCount(1);
    // 항목별로 나뉘어야 한다.
    await expect(stat.getByText('기타정산(주유비)', { exact: false })).toHaveCount(1);
    await expect(stat.getByText('기타정산(도선료)', { exact: false })).toHaveCount(1);
    // 예전 이름("탁송료")은 무엇을 뜻하는지 알 수 없어 바꿨다.
    await expect(stat.getByText('탁송료', { exact: true })).toHaveCount(0);
  });

  test('금액 통계가 표로 나오고 금액이 우측 정렬된다', async ({ page }) => {
    test.skip(!groupId, '법인이 없습니다');
    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    await page.goto(`${BASE_URL}/groups/${groupId}/settlement?month=${MONTH}`, { waitUntil: 'domcontentloaded' });

    const table = page.locator('.stat-table');
    await expect(table).toHaveCount(1);
    // 항목명 + 금액 두 칸.
    await expect(table.locator('tbody tr').first().locator('th, td')).toHaveCount(2);

    const style = await table.locator('tbody tr').first().locator('td').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { align: cs.textAlign, border: cs.borderTopWidth, pad: cs.paddingTop };
    });
    expect(style.align, '금액은 우측 정렬').toBe('right');
    // 테두리가 없으면 어디까지가 한 줄인지 안 보인다.
    expect(parseFloat(style.border), '테두리선').toBeGreaterThan(0);
    // 붙어 있으면 읽기 어렵다 — 여백이 있어야 한다.
    expect(parseFloat(style.pad), '위아래 여백').toBeGreaterThan(4);

    // 총 청구액은 합계 줄에 있고 눈에 띄어야 한다.
    await expect(table.locator('.stat-total')).toContainText('총 청구액');
    await expect(table.locator('.stat-total')).toContainText('145,000원');
  });

  // 입금관리는 목록에서 여러 건을 한꺼번에 처리한다(사용자 지시). 체크 → 일괄 정산완료 →
  // 처리 시각·담당자 기록까지 이어지는지 본다.
  test('체크한 줄만 한 번에 정산완료로 바뀌고 시각·담당자가 남는다', async ({ page }) => {
    test.skip(!groupId, '법인이 없습니다');
    await db.run('UPDATE orders SET settled_at = NULL, settled_by = NULL WHERE oid LIKE ?', [`${MARK}%`]);
    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    await page.goto(`${BASE_URL}/groups/${groupId}/settlement?month=${MONTH}`, { waitUntil: 'domcontentloaded' });

    const row = page.locator(`.settlement-table tbody tr:has-text("${MARK}출발지")`);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('미정산');

    await row.locator('input[name="order_id"]').check();
    await page.locator('button[form="settleForm"][value="settle"]').click();
    await page.waitForURL(/saved=/, { timeout: 30000 });

    // 조회하던 달이 유지돼야 한다.
    expect(page.url()).toContain(`month=${MONTH}`);

    const saved = await db.get('SELECT settled_at, settled_by FROM orders WHERE oid = ?', [`${MARK}-1`]);
    expect(saved.settled_at, '처리 시각이 남아야 한다').toBeTruthy();
    // 시각만 남기면 "누가 확정했나"를 못 찾는다.
    expect(saved.settled_by, '담당자 계정이 남아야 한다').toBeTruthy();

    await expect(page.locator(`.settlement-table tbody tr:has-text("${MARK}출발지")`)).toContainText('정산완료');

    // 되돌릴 수 있어야 한다 — 잘못 누른 것을 못 되돌리면 아무도 안 쓴다.
    await page.locator(`.settlement-table tbody tr:has-text("${MARK}출발지")`)
      .locator('input[name="order_id"]').check();
    await page.locator('button[form="settleForm"][value="unsettle"]').click();
    await page.waitForURL(/saved=/, { timeout: 30000 });
    expect((await db.get('SELECT settled_at FROM orders WHERE oid = ?', [`${MARK}-1`])).settled_at).toBeFalsy();
  });

  // 개별정산은 건별로 따로 청구하기로 한 항목이다 — 월 정산서 한 장에 모으면 그 설정이
  // 무의미해진다. 건마다 한 장씩 나오는지, 그리고 월정산 항목이 섞여 들어가지 않는지 본다.
  test('개별정산 항목만 건별 청구서로 나온다', async ({ page }) => {
    test.skip(!groupId, '법인이 없습니다');
    await page.addInitScript(() => { window.print = () => {}; });

    // 주유비·세차비를 개별정산으로, 주차비를 월정산으로 둔다.
    // 개별정산을 **둘** 두는 이유: 한 건뿐이면 그 장이 마지막 장이라 페이지 나눔이 걸리지
    // 않는다(:last-of-type). 그 상태로 검사하면 나눔이 없는 것을 정상으로 착각한다.
    await db.run(
      `UPDATE group_fare_extra_settings
          SET fuel_mode = 'individual', wash_mode = 'individual', parking_mode = 'monthly'
        WHERE group_id = ?`, [groupId]
    ).catch(() => {});
    const order = await db.get('SELECT id FROM orders WHERE oid = ?', [`${MARK}-1`]);
    await db.run(
      `INSERT INTO order_extra_charges (order_id, charge_type, amount, charged_on, billable)
       VALUES (?, '주차요금', 7000, ?, true), (?, '세차비', 15000, ?, true)`,
      [order.id, `${MONTH}-05`, order.id, `${MONTH}-05`]
    );

    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    const res = await page.goto(
      `${BASE_URL}/groups/${groupId}/settlement/individual-print?month=${MONTH}&autoprint=0`,
      { waitUntil: 'domcontentloaded' }
    );
    expect(res.status()).toBe(200);

    await expect(page.locator('h1').first()).toContainText('청 구 서');
    // 개별정산으로 둔 주유비만 나와야 한다.
    await expect(page.getByText('기타정산(주유비)', { exact: false }).first()).toBeVisible();
    // 월정산 항목이 섞이면 같은 금액을 월 정산서와 건별 청구서로 두 번 청구하게 된다.
    await expect(page.getByText('기타정산(주차요금)', { exact: false })).toHaveCount(0);
    // 도선료는 오더에서 파생된 줄이라 별도 청구 대상이 아니다.
    await expect(page.getByText('기타정산(도선료)', { exact: false })).toHaveCount(0);

    // 어느 운행 건에 대한 청구인지 밝혀야 한다.
    await expect(page.getByText(`${MARK}-1`, { exact: false }).first()).toBeVisible();
    await expect(page.getByText('40,000원', { exact: false }).first()).toBeVisible();

    // 인쇄할 때 건마다 페이지가 나뉘어야 한다 — 붙어 나오면 월 정산서와 다를 게 없다.
    // CSS 문자열이 아니라 **인쇄 모드에서 실제로 계산된 값**을 본다(브라우저가 속성 이름을
    // break-after로 정규화해서, 문자열로 찾으면 있어도 못 찾는다).
    await page.emulateMedia({ media: 'print' });
    const breakAfter = await page.locator('.sheet').first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return cs.breakAfter || cs.pageBreakAfter;
    });
    expect(breakAfter, '건마다 페이지 나눔').toMatch(/page|always/);
    await page.emulateMedia({ media: 'screen' });

    // 여러 장이면 마지막에 요약 장이 붙는다 — 몇 장을 뽑았고 합이 얼마인지 확인하지 못하면
    // 한 장이 빠져도 모른다.
    await expect(page.getByText('청 구 요 약', { exact: false })).toBeVisible();
    await expect(page.getByText('55,000원', { exact: false }).first()).toBeVisible();

    await db.run("DELETE FROM order_extra_charges WHERE order_id = ? AND charge_type IN ('주차요금', '세차비')", [order.id]);
  });

  test('개별정산 항목이 없으면 빈 종이 대신 이유를 알린다', async ({ page }) => {
    test.skip(!groupId, '법인이 없습니다');
    await page.addInitScript(() => { window.print = () => {}; });
    // 모두 월정산으로 되돌린다.
    await db.run(
      `UPDATE group_fare_extra_settings
          SET fuel_mode = 'monthly', wash_mode = 'monthly', parking_mode = 'monthly'
        WHERE group_id = ?`, [groupId]
    ).catch(() => {});
    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    await page.goto(`${BASE_URL}/groups/${groupId}/settlement/individual-print?month=${MONTH}&autoprint=0`,
      { waitUntil: 'domcontentloaded' });
    // 빈 종이가 나오면 설정을 의심하지 못한다.
    await expect(page.getByText('개별정산', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('청구할 항목이 없습니다', { exact: false })).toBeVisible();
  });

  // 입금계좌는 청구서의 목적 그 자체다 — 없으면 받는 쪽이 어디로 보낼지 몰라 따로 물어야 한다.
  test('입금계좌가 두 문서에 모두 찍히고, 없으면 어디서 채우는지 알린다', async ({ page }) => {
    test.skip(!groupId, '법인이 없습니다');
    await page.addInitScript(() => { window.print = () => {}; });
    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });

    const g = await db.get('SELECT branch_id FROM groups_tbl WHERE id = ?', [groupId]);
    const before = await db.get('SELECT bank_name, bank_account, bank_holder FROM branches WHERE id = ?', [g.branch_id]);
    try {
      // 계좌가 비어 있을 때: 빈 칸을 두지 말고 어디서 채우는지 알려야 한다.
      await db.run('UPDATE branches SET bank_name = NULL, bank_account = NULL, bank_holder = NULL WHERE id = ?',
        [g.branch_id]);
      await page.goto(`${BASE_URL}/groups/${groupId}/settlement/print?month=${MONTH}&autoprint=0`,
        { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('입금계좌', { exact: false }).first()).toBeVisible();
      await expect(page.getByText('등록되어 있지 않습니다', { exact: false })).toBeVisible();

      // 채우면 두 문서에 모두 나와야 한다 — 한쪽만 나오면 그 문서를 받은 쪽만 물어본다.
      await db.run(
        'UPDATE branches SET bank_name = ?, bank_account = ?, bank_holder = ? WHERE id = ?',
        ['국민은행', '123456-01-234567', '(주)검사', g.branch_id]
      );
      for (const path of ['settlement/print', 'settlement/individual-print']) {
        await page.goto(`${BASE_URL}/groups/${groupId}/${path}?month=${MONTH}&autoprint=0`,
          { waitUntil: 'domcontentloaded' });
        // 개별정산 항목이 없는 달이면 청구서 장이 없다 — 그때는 계좌도 나올 자리가 없다.
        if (await page.locator('.meta').count() === 0) continue;
        await expect(page.getByText('123456-01-234567', { exact: false }).first(),
          `${path}에 계좌번호`).toBeVisible();
        await expect(page.getByText('(주)검사', { exact: false }).first(),
          `${path}에 예금주`).toBeVisible();
      }
    } finally {
      await db.run('UPDATE branches SET bank_name = ?, bank_account = ?, bank_holder = ? WHERE id = ?',
        [before.bank_name, before.bank_account, before.bank_holder, g.branch_id]).catch(() => {});
    }
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
