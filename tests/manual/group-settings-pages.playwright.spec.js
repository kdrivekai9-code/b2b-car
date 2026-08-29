// 법인관리 서브메뉴 7개가 실제로 열리는지.
//
// 왜 필요한가: EJS 화면은 문법이 틀려도 빌드에서 안 잡히고 열 때 500이 난다. 이번에 한 번에
// 6개를 만들었고 공용 파티셜(group_tabs, customer_notification_events)까지 새로 넣어서,
// "파일이 있다"로는 동작을 보증할 수 없다. 각 화면을 실제로 열어 200과 핵심 문구를 확인한다.
//
// 폴백 안내("지사 설정이 적용됩니다")가 보이는지도 함께 본다 — 그 문구가 없으면 관리자는 빈
// 화면을 보고 요금이 0원이거나 통보가 꺼진 줄 안다.
const { test, expect } = require('@playwright/test');
const db = require('../../db');
const { loginWithRetry } = require('./helpers/auth');

// 법인 서브메뉴는 Next 라우터 matcher에 없어 Express(EJS)가 그린다.
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
// 계정·비밀번호는 한 곳에서 가져온다 — 값이 없으면 즉시 멈춘다(tests/e2e-credentials.js).
const { LOGIN_ID, PASSWORD } = require('../e2e-credentials');

let groupId = null;

test.beforeAll(async () => {
  const row = await db.get('SELECT id FROM groups_tbl ORDER BY id LIMIT 1');
  groupId = row ? Number(row.id) : null;
});

test.afterAll(async () => {
  await db.pool.end().catch(() => {});
});

const PAGES = [
  { path: 'accounts', title: '계정정보', mustHave: '등록된 계정' },
  { path: 'fare-rules', title: '탁송 요금', mustHave: '거리 구간별 요금 규칙' },
  { path: 'daily-driver-fare-rules', title: '일일기사 요금', mustHave: '시간 구간별 요금' },
  { path: 'premium-fare-rules', title: '프리미엄(대리) 요금', mustHave: '준비 중' },
  { path: 'settlement', title: '정산내역', mustHave: '금액 통계' },
  { path: 'customer-notifications', title: '고객 통보', mustHave: '상태별 고객 통보' },
  { path: 'dispatch-delay', title: '배차지연 알림', mustHave: '지연 판단과 상향 금액' },
];

test.describe('법인관리 · 법인별 설정 화면', () => {
  test.describe.configure({ timeout: 180000 });

  test('일곱 화면이 모두 열리고 탭이 서로를 가리킨다', async ({ page }) => {
    test.skip(!groupId, '등록된 법인이 없습니다');
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));

    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });

    for (const p of PAGES) {
      const res = await page.goto(`${BASE_URL}/groups/${groupId}/${p.path}`, { waitUntil: 'domcontentloaded' });
      expect(res.status(), `${p.title} 화면 상태코드`).toBe(200);
      await expect(page.getByText(p.mustHave, { exact: false }).first(),
        `${p.title} 화면 내용`).toBeVisible();
      // 탭이 여섯 화면을 모두 가리켜야 화면 사이를 오갈 수 있다.
      for (const other of PAGES) {
        await expect(page.locator(`.branch-tabs a[href="/groups/${groupId}/${other.path}"]`),
          `${p.title}에서 ${other.title} 탭`).toHaveCount(1);
      }
    }

    expect(problems, `페이지 오류: ${problems.join(' | ')}`).toEqual([]);
  });

  test('법인 설정이 없으면 지사 설정을 쓴다고 알린다', async ({ page }) => {
    test.skip(!groupId, '등록된 법인이 없습니다');
    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });

    // 이 검사는 실사용 설정을 건드리지 않으려고 "법인 요금표가 비어 있는" 법인을 찾아서 본다.
    const empty = await db.get(`
      SELECT g.id FROM groups_tbl g
      WHERE NOT EXISTS (SELECT 1 FROM group_fare_rules f WHERE f.group_id = g.id)
      ORDER BY g.id LIMIT 1
    `);
    test.skip(!empty, '법인 요금표가 비어 있는 법인이 없습니다');

    await page.goto(`${BASE_URL}/groups/${empty.id}/fare-rules`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('소속 지사', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('탁송 요금표가 적용됩니다', { exact: false })).toBeVisible();
  });

  // 정산내역은 청구 근거라 "열린다"로는 부족하다. 검사용 완료 오더를 넣고, 그 달만 조회했을 때
  // 목록과 하단 합계가 서로 맞는지 본다 — 둘이 어긋나면 관리자는 어느 쪽을 믿을지 알 수 없다.
  test('정산내역은 지정한 달의 완료건만 보이고 합계가 목록과 맞는다', async ({ page }) => {
    test.skip(!groupId, '등록된 법인이 없습니다');
    const MARK = 'e2e-settle';
    // 남은 검사용 오더가 다음 실행의 합계를 부풀린다. 이력이 오더를 참조해 이력부터 지운다.
    const wipe = async () => {
      const rows = await db.all('SELECT id FROM orders WHERE oid LIKE ?', [`${MARK}%`]);
      for (const r of rows) {
        await db.run('DELETE FROM order_status_history WHERE order_id = ?', [r.id]);
        await db.run('DELETE FROM orders WHERE id = ?', [r.id]);
      }
    };
    await wipe();

    const branch = await db.get('SELECT id FROM branches ORDER BY id LIMIT 1');
    // 실사용 데이터와 섞이지 않도록 아주 오래된 달을 쓴다 — 이 달의 실적은 검사용뿐이다.
    const MONTH = '2019-03';
    const made = [];
    try {
      for (const [i, fare] of [11000, 22000].entries()) {
        const row = await db.get(
          `INSERT INTO orders (oid, branch_id, requester_group_id, status, reserved_date, reserved_time,
                               origin_address, destination_address, fare_amount, ferry_fare_amount)
           VALUES (?, ?, ?, '완료', '2019-03-10', '09:00', ?, ?, ?, 0) RETURNING id`,
          [`${MARK}-${i}`, branch.id, groupId, `검사출발${i}`, `검사도착${i}`, fare]
        );
        made.push(Number(row.id));
        await db.run(
          `INSERT INTO order_status_history (order_id, old_status, new_status, created_at)
           VALUES (?, '기사배정', '완료', ?)`,
          [row.id, `${MONTH}-1${i} 10:00:00`]
        );
      }

      await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
      const res = await page.goto(`${BASE_URL}/groups/${groupId}/settlement?month=${MONTH}`,
        { waitUntil: 'domcontentloaded' });
      expect(res.status()).toBe(200);

      const rows = page.locator('.settlement-table tbody tr');
      await expect(rows, '그 달의 완료건 2건').toHaveCount(2);
      await expect(page.getByText('검사출발0')).toBeVisible();
      // 합계는 33,000원 — 목록의 두 건을 더한 값이다.
      await expect(page.locator('.settlement-table tfoot')).toContainText('33,000원');
      await expect(page.getByText('건당 평균').locator('..')).toContainText('16,500원');

      // 다른 달로 옮기면 이 건들이 따라오면 안 된다.
      await page.goto(`${BASE_URL}/groups/${groupId}/settlement?month=2019-04`,
        { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('검사출발0')).toHaveCount(0);
      await expect(page.getByText('이 달에 완료된 오더가 없습니다')).toBeVisible();
    } finally {
      await wipe();
    }
  });

  // 기타 정산 내역은 오더상세에서 넣고 정산내역에서 청구한다. 두 화면이 따로 놀면(항목 이름이
  // 갈리거나 '별도 청구'가 안 지켜지거나) 청구서가 틀리므로 한 번에 이어서 본다.
  test('오더상세에서 넣은 실비가 정산내역에 별도 청구분만 올라온다', async ({ page }) => {
    test.skip(!groupId, '등록된 법인이 없습니다');
    const MARK = 'e2e-extra';
    const wipe = async () => {
      const rows = await db.all('SELECT id FROM orders WHERE oid LIKE ?', [`${MARK}%`]);
      for (const r of rows) {
        await db.run('DELETE FROM order_extra_charges WHERE order_id = ?', [r.id]);
        await db.run('DELETE FROM order_status_history WHERE order_id = ?', [r.id]);
        await db.run('DELETE FROM orders WHERE id = ?', [r.id]);
      }
    };
    await wipe();

    const branch = await db.get('SELECT id FROM branches ORDER BY id LIMIT 1');
    const MONTH = '2019-05';
    let orderId = null;
    try {
      const row = await db.get(
        `INSERT INTO orders (oid, branch_id, requester_group_id, status, reserved_date, reserved_time,
                             vehicle_number, origin_address, destination_address, fare_amount, ferry_fare_amount)
         VALUES (?, ?, ?, '완료', '2019-05-10', '09:00', '99하8877', ?, '검사도착', 100000, 0) RETURNING id`,
        [`${MARK}-1`, branch.id, groupId, `${MARK}출발지`]
      );
      orderId = Number(row.id);
      await db.run(
        `INSERT INTO order_status_history (order_id, old_status, new_status, created_at)
         VALUES (?, '기사배정', '완료', ?)`, [orderId, `${MONTH}-10 18:00:00`]
      );

      await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
      await page.goto(`${BASE_URL}/orders/${orderId}`, { waitUntil: 'domcontentloaded' });

      // 두 줄을 넣는다: 청구할 톨게이트비와, 지사가 부담하는 주차요금.
      await page.locator('#extraChargeAdd').click();
      await page.locator('#extraChargeAdd').click();
      const rowAt = (i) => page.locator('#extraChargeBody tr').nth(i);

      // 선택지는 요금설정에 따라 달라진다 — "기본요금 포함"으로 둔 항목은 이중 청구가 되므로
      // 빠진다(lib/extraCharges.js billableTypesForOrder). 그래서 항목 이름을 박아두면 안 된다.
      // 실제로 '톨게이트'를 박아뒀다가, 그 항목이 빠진 법인에서 선택이 영영 안 돼 검사가 멈췄다.
      const options = await rowAt(0).locator('select[name="extra_charge_type"] option')
        .evaluateAll((els) => els.map((e) => e.value).filter(Boolean));
      expect(options.length, '청구 가능한 항목이 최소 2개는 있어야 이 검사가 성립한다')
        .toBeGreaterThanOrEqual(2);
      const [typeA, typeB] = options;

      await rowAt(0).locator('select[name="extra_charge_type"]').selectOption(typeA);
      await rowAt(0).locator('input[name="extra_charge_amount"]').fill('4500');
      await rowAt(1).locator('select[name="extra_charge_type"]').selectOption(typeB);
      await rowAt(1).locator('input[name="extra_charge_amount"]').fill('40000');
      // 두 번째 줄만 별도 청구를 끈다 — 체크박스 값이 행 번호라, 여기가 어긋나면 엉뚱한 줄이 꺼진다.
      await rowAt(1).locator('input[name="extra_charge_billable"]').uncheck();
      await page.locator('#extraChargeForm button[type="submit"]').click();
      await page.waitForURL(new RegExp(`/orders/${orderId}$`), { timeout: 20000 });

      // 저장된 줄이 화면에 다시 보여야 한다 — 안 보이면 관리자는 안 들어간 줄 알고 또 넣는다.
      await expect(page.locator('#extraChargeBody tr')).toHaveCount(2);

      await page.goto(`${BASE_URL}/groups/${groupId}/settlement?month=${MONTH}`, { waitUntil: 'domcontentloaded' });
      const extraRows = page.locator('.extra-charge-table tbody tr');
      await expect(extraRows, '별도 청구 한 건만').toHaveCount(1);
      await expect(extraRows.first()).toContainText(typeA);
      await expect(extraRows.first()).toContainText('99하8877');
      await expect(extraRows.first()).toContainText(`${MARK}출발지`);
      // 지사가 부담하는 실비가 청구서에 오르면 없는 돈을 청구하게 된다.
      await expect(page.locator('.extra-charge-table')).not.toContainText(typeB);

      // 합계표와 총 청구액이 목록과 맞아야 한다.
      await expect(page.locator('.extra-charge-summary-table tfoot')).toContainText('4,500원');
      // 하단 금액 통계 블록을 콕 집는다 — 안내 문구에도 "총 청구액"이라는 말이 들어가서
      // 그냥 텍스트로 찾으면 두 곳에 걸린다.
      await expect(page.locator('.stat-row').getByText('총 청구액').locator('..'))
        .toContainText('104,500원');
    } finally {
      await wipe();
    }
  });
});
