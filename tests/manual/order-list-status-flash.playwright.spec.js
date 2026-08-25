// 오더 리스트에서 상태가 바뀐 행이 그 상태의 색으로 깜빡이는지.
//
// 왜 필요한가: 목록은 SSE로 조용히 갱신된다. 예전에는 바뀐 행을 노란 배경으로만 알렸는데,
// 그것만으로는 "무언가 바뀌었다"까지만 알 수 있고 무엇으로 바뀌었는지는 행을 읽어야 했다
// (사용자 요청 2026-08-25). 상태색으로 깜빡이면 훑는 중에도 눈에 걸린다.
//
// 이 동작은 "직전 목록과 지금 목록의 차이"에서 나온다 — 화면을 새로 열면 비교 대상이 없어
// 아무것도 깜빡이지 않는 게 정상이다. 그래서 화면을 열어둔 채 DB에서 상태를 바꾸고, SSE
// 갱신이 도착한 뒤를 본다.
const { test, expect } = require('@playwright/test');
const db = require('../../db');
const { loginWithRetry } = require('./helpers/auth');

// 프로덕션이 띄우는 것은 Next 목록이다(NEXT_STAGE1_ORDERS_ENABLED). Express로 열면 이 코드가
// 아예 돌지 않는다.
const BASE_URL = process.env.E2E_NEXT_BASE_URL || 'http://localhost:3001';
const LOGIN_ID = process.env.E2E_LOGIN_ID || 'admin';
const PASSWORD = process.env.E2E_PASSWORD || 'Admin!2345';

const MARK = 'e2e-flash';
let orderId = null;

test.beforeAll(async () => {
  const branch = await db.get('SELECT id FROM branches ORDER BY id LIMIT 1');
  const row = await db.get(
    `INSERT INTO orders (oid, branch_id, status, memo_customer, origin_address, destination_address, reserved_date, reserved_time)
     VALUES (?, ?, '접수', ?, ?, ?, '2026-08-26', '10:00') RETURNING id`,
    [`${MARK}-oid`, branch.id, MARK, '서울 강남구', '경기 성남시']
  );
  orderId = Number(row.id);
});

test.afterAll(async () => {
  if (orderId) await db.run('DELETE FROM orders WHERE id = ?', [orderId]).catch(() => {});
  await db.pool.end().catch(() => {});
});

test.describe('오더 리스트 · 상태변경 깜빡임', () => {
  test.describe.configure({ timeout: 180000 });

  test('상태가 바뀌면 그 상태의 색으로 깜빡인다', async ({ page }) => {
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));

    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    await page.goto(`${BASE_URL}/orders?q=${encodeURIComponent(MARK)}`, { waitUntil: 'networkidle' });

    const row = page.locator(`tbody tr:has-text("${MARK}-oid")`);
    await expect(row, '검사용 오더가 목록에 보여야 한다').toHaveCount(1);
    // 화면을 갓 열었을 때는 비교 대상이 없어 깜빡이지 않는다 — 전부 깜빡이면 소음이다.
    await expect(row).not.toHaveClass(/order-row-status-flash/);

    // 상태를 API로 바꾼다 — 그래야 서버가 SSE를 쏘고(broadcastOrderListChanged) 목록이
    // 페이지 이동 없이 갱신된다. DB만 고치면 신호가 없어 화면이 그대로다.
    // 새로고침으로는 이 동작을 볼 수 없다 — 화면을 새로 열면 비교할 직전 목록이 없다.
    const posted = await page.evaluate(async (id) => {
      const r = await fetch(`/orders/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify({ status: '기사배정', note: 'e2e' }),
      });
      return r.status;
    }, orderId);
    expect([200, 204, 302]).toContain(posted);

    // 기사배정은 amber다(config.js STATUS_COLORS) — 상태에 맞는 색이어야 의미가 있다.
    await expect(row).toHaveClass(/order-row-status-flash/, { timeout: 20000 });
    await expect(row).toHaveClass(/order-flash-amber/);

    // 3초 뒤에는 스스로 걷힌다 — 계속 깜빡이면 다음 변경을 알아볼 수 없다.
    await expect(row).not.toHaveClass(/order-row-status-flash/, { timeout: 15000 });

    expect(problems, `페이지 오류: ${problems.join(' | ')}`).toEqual([]);
  });

  test('상태색과 깜빡임 규칙이 CSS에 정의되어 있다', async ({ page }) => {
    // 클래스만 붙고 CSS가 없으면 아무 일도 일어나지 않는다 — 눈으로만 확인하면 놓친다.
    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    await page.goto(`${BASE_URL}/orders`, { waitUntil: 'domcontentloaded' });

    const applied = await page.evaluate(() => {
      const tr = document.createElement('tr');
      tr.className = 'order-row-status-flash order-flash-amber';
      const td = document.createElement('td');
      tr.appendChild(td);
      const tbody = document.querySelector('tbody') || document.body;
      tbody.appendChild(tr);
      const cs = getComputedStyle(td);
      const out = {
        animationName: cs.animationName,
        duration: cs.animationDuration,
        count: cs.animationIterationCount,
        flashBg: cs.getPropertyValue('--flash-bg').trim(),
      };
      tr.remove();
      return out;
    });

    expect(applied.animationName, '깜빡임 애니메이션이 걸려야 한다').toBe('orderStatusFlash');
    // 0.5초 × 6회 = 3초(사용자 지정). 이 곱이 3초가 아니면 색이 남거나 먼저 꺼진다.
    expect(parseFloat(applied.duration) * parseFloat(applied.count)).toBeCloseTo(3, 1);
    expect(applied.flashBg, '상태색이 지정돼야 한다').toBeTruthy();
  });
});
