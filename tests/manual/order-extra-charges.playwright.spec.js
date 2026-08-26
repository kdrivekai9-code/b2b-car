// 기타 정산 내역 입력이 Next 오더상세에서도 되는지.
//
// 프로덕션이 띄우는 오더상세는 Next다(NEXT_ORDER_DETAIL_EDIT_ENABLED). EJS 쪽은
// group-settings-pages 스펙에서 정산내역까지 이어서 보고 있고, 여기서는 같은 입력이 React
// 패널에서도 되는지만 본다 — 화면이 둘인데 한쪽만 고치면 실사용에서 안 보인다.
//
// 저장은 순수 <form> POST라 같은 라우트(POST /:id/extra-charges)로 간다. 그래서 확인할 것은
// "React가 그 폼을 제대로 그리는가"와, 체크박스 값이 행 번호라는 규칙이 지켜지는가다.
const { test, expect } = require('@playwright/test');
const db = require('../../db');
const { loginWithRetry } = require('./helpers/auth');

const BASE_URL = process.env.E2E_NEXT_BASE_URL || 'http://localhost:3001';
// 로그인 계정: 실사용 admin으로 로그인하면 단일 세션 강제(users.active_session_hash) 때문에
// 그 계정을 쓰던 사람이 로그아웃된다 — QA 전용 계정을 쓴다. 비밀번호는 .env(E2E_PASSWORD)에서
// 온다(저장소에 적지 않는다).
//
// 알려진 제약: 여러 스펙을 한 번에 돌리면 같은 계정으로 :3000 · :3001을 오가며 로그인이
// 반복돼 로그인 시도 제한에 걸린다. 스펙 단위로 돌리는 것을 전제로 한다.
// 계정·비밀번호는 한 곳에서 가져온다 — 값이 없으면 즉시 멈춘다(tests/e2e-credentials.js).
const { LOGIN_ID, PASSWORD } = require('../e2e-credentials');

const MARK = 'e2e-nextextra';
let orderId = null;

async function wipe() {
  const rows = await db.all('SELECT id FROM orders WHERE oid LIKE ?', [`${MARK}%`]);
  for (const r of rows) {
    await db.run('DELETE FROM order_extra_charges WHERE order_id = ?', [r.id]);
    await db.run('DELETE FROM order_status_history WHERE order_id = ?', [r.id]);
    await db.run('DELETE FROM orders WHERE id = ?', [r.id]);
  }
}

test.beforeAll(async () => {
  await wipe();
  const branch = await db.get('SELECT id FROM branches ORDER BY id LIMIT 1');
  const row = await db.get(
    `INSERT INTO orders (oid, branch_id, status, reserved_date, reserved_time,
                         vehicle_number, origin_address, destination_address, fare_amount)
     VALUES (?, ?, '접수', '2026-08-26', '10:00', '11가2233', ?, '경기 성남시', 50000) RETURNING id`,
    [`${MARK}-1`, branch.id, `${MARK}출발`]
  );
  orderId = Number(row.id);
});

test.afterAll(async () => {
  await wipe();
  await db.pool.end().catch(() => {});
});

test.describe('오더상세(Next) · 기타 정산 내역', () => {
  test.describe.configure({ timeout: 180000 });

  test('항목을 넣어 저장하면 DB에 들어가고 화면에 다시 보인다', async ({ page }) => {
    test.skip(!orderId, '검사용 오더를 만들지 못했습니다');
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));

    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    await page.goto(`${BASE_URL}/orders/${orderId}`, { waitUntil: 'domcontentloaded' });

    const card = page.locator('.card', { hasText: '기타 정산 내역' });
    await expect(card).toHaveCount(1);
    // 일자 기본값은 오더 예약일이다 — 매번 같은 날짜를 손으로 넣게 하면 안 넣는다.
    await card.getByRole('button', { name: '+ 항목 추가' }).click();
    await expect(card.locator('input[name="extra_charge_date"]').first()).toHaveValue('2026-08-26');

    await card.getByRole('button', { name: '+ 항목 추가' }).click();
    const rowAt = (i) => card.locator('tbody tr').nth(i);
    await rowAt(0).locator('select[name="extra_charge_type"]').selectOption('주유비');
    await rowAt(0).locator('input[name="extra_charge_amount"]').fill('60000');
    await rowAt(1).locator('select[name="extra_charge_type"]').selectOption('주차요금');
    await rowAt(1).locator('input[name="extra_charge_amount"]').fill('3000');
    // 두 번째 줄만 별도 청구를 끈다 — 체크박스 값이 행 번호라 어긋나면 엉뚱한 줄이 꺼진다.
    await rowAt(1).locator('input[name="extra_charge_billable"]').uncheck();
    await card.getByRole('button', { name: '저장' }).click();
    await page.waitForURL(new RegExp(`/orders/${orderId}$`), { timeout: 30000 });

    const saved = await db.all(
      'SELECT charge_type, amount, billable, charged_on FROM order_extra_charges WHERE order_id = ? ORDER BY id',
      [orderId]
    );
    expect(saved.map((r) => r.charge_type)).toEqual(['주유비', '주차요금']);
    expect(saved.map((r) => Number(r.amount))).toEqual([60000, 3000]);
    expect(saved.map((r) => r.billable)).toEqual([true, false]);
    expect(saved.map((r) => r.charged_on)).toEqual(['2026-08-26', '2026-08-26']);

    // 저장된 줄이 화면에 다시 보여야 한다 — 안 보이면 관리자는 안 들어간 줄 알고 또 넣는다.
    const reopened = page.locator('.card', { hasText: '기타 정산 내역' });
    await expect(reopened.locator('tbody tr')).toHaveCount(2);
    await expect(reopened.locator('input[name="extra_charge_amount"]').first()).toHaveValue('60000');
    await expect(reopened.locator('input[name="extra_charge_billable"]').nth(1)).not.toBeChecked();

    // 줄을 지우면 남은 줄의 행 번호가 다시 매겨져야 한다 — 안 그러면 체크가 밀린다.
    await reopened.locator('tbody tr').nth(0).getByRole('button', { name: '삭제' }).click();
    await expect(reopened.locator('input[name="extra_charge_billable"]')).toHaveValue('0');

    expect(problems, `페이지 오류: ${problems.join(' | ')}`).toEqual([]);
  });
});
