// 배차 요금이 화면까지 나오는지 — 지사 요금표 화면과 오더리스트 컬럼.
//
// 계산과 콜마너 페이로드는 scripts/check-dispatch-fare.js가 본다. 여기서 보는 것은 그 값을
// 사람이 실제로 등록하고 확인할 수 있는가다.
//
//  · 지사관리 · 배차 요금 화면은 EJS다 — 문법 오류가 빌드에서 안 잡히고 열 때 500이 난다.
//  · 오더리스트 배차 요금 컬럼은 Next가 그린다. 그리고 컬럼 설정이 localStorage에 저장돼 있어,
//    "코드에 컬럼을 넣었다"와 "화면에 보인다"가 다르다 — 저장된 설정이 있는 사람에게도 새 컬럼이
//    켜지는지 함께 본다.
const { test, expect } = require('@playwright/test');
const db = require('../../db');
const { loginWithRetry } = require('./helpers/auth');

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const NEXT_BASE_URL = process.env.E2E_NEXT_BASE_URL || 'http://localhost:3001';
// 로그인 계정: 실사용 admin으로 로그인하면 단일 세션 강제(users.active_session_hash) 때문에
// 그 계정을 쓰던 사람이 로그아웃된다 — QA 전용 계정을 쓴다. 비밀번호는 .env(E2E_PASSWORD)에서
// 온다(저장소에 적지 않는다).
//
// 알려진 제약: 여러 스펙을 한 번에 돌리면 같은 계정으로 :3000 · :3001을 오가며 로그인이
// 반복돼 로그인 시도 제한에 걸린다. 스펙 단위로 돌리는 것을 전제로 한다.
// 계정·비밀번호는 한 곳에서 가져온다 — 값이 없으면 즉시 멈춘다(tests/e2e-credentials.js).
const { LOGIN_ID, PASSWORD } = require('../e2e-credentials');

const MARK = 'e2e-dfare';
let branchId = null;
let orderIds = [];

async function wipeOrders() {
  const rows = await db.all('SELECT id FROM orders WHERE oid LIKE ?', [`${MARK}%`]);
  for (const r of rows) {
    await db.run('DELETE FROM order_status_history WHERE order_id = ?', [r.id]);
    await db.run('DELETE FROM orders WHERE id = ?', [r.id]);
  }
}

test.beforeAll(async () => {
  await wipeOrders();
  const branch = await db.get('SELECT id FROM branches ORDER BY id LIMIT 1');
  branchId = branch ? Number(branch.id) : null;
  if (!branchId) return;
  // 배차 요금이 있는 오더와 없는 오더 — 없는 쪽이 0원으로 찍히면 "무료 배차"로 읽힌다.
  for (const [i, fare] of [38000, null].entries()) {
    const row = await db.get(
      `INSERT INTO orders (oid, branch_id, status, reserved_date, reserved_time,
                           origin_address, destination_address, fare_amount, dispatch_fare_amount)
       VALUES (?, ?, '접수', '2026-08-26', '10:00', ?, '경기 성남시', 120000, ?) RETURNING id`,
      [`${MARK}-${i}`, branchId, `${MARK}출발${i}`, fare]
    );
    orderIds.push(Number(row.id));
  }
});

test.afterAll(async () => {
  await wipeOrders();
  await db.pool.end().catch(() => {});
});

test.describe('배차 요금', () => {
  test.describe.configure({ timeout: 180000 });

  test('지사관리 배차 요금 화면이 열리고 저장한 구간이 다시 보인다', async ({ page }) => {
    test.skip(!branchId, '등록된 지사가 없습니다');
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));

    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });

    // 실사용 지사의 배차 요금표를 덮어쓰면 그 지사의 배차 금액이 바뀐다 — 원래 값을 담아뒀다가
    // 끝나고 그대로 되돌린다.
    const before = await db.all(
      'SELECT * FROM branch_dispatch_fare_rules WHERE branch_id = ? ORDER BY tier_seq', [branchId]
    );
    try {
      const res = await page.goto(`${BASE_URL}/branches/${branchId}/dispatch-fare-rules`,
        { waitUntil: 'domcontentloaded' });
      expect(res.status()).toBe(200);
      await expect(page.getByText('거리 구간별 배차 요금', { exact: false })).toBeVisible();
      // 이 화면이 고객 청구액이 아니라는 것은 화면에서 읽혀야 한다 — 헷갈리면 계약 단가가 바뀐다.
      await expect(page.getByText('콜마너', { exact: false }).first()).toBeVisible();

      // 구간이 없는 지사는 입력행도 없다 — 공용 스크립트(public/js/fare-rules.js)로 한 줄 만든다.
      // 이 지사에 구간이 이미 있으면 첫 줄을 그대로 덮어쓴다(끝나고 원래대로 되돌린다).
      if (await page.locator('#fareTiersBody tr').count() === 0) {
        await page.locator('#addTierBtn').click();
        await expect(page.locator('#fareTiersBody tr')).toHaveCount(1);
      }
      await page.locator('input[name="base_distance_km"]').first().fill('10');
      await page.locator('input[name="base_fare"]').first().fill('30000');
      await page.locator('input[name="surcharge_unit_km"]').first().fill('1');
      await page.locator('input[name="surcharge_fare"]').first().fill('800');
      await page.getByRole('button', { name: '저장' }).click();
      await page.waitForURL(/saved=1/, { timeout: 20000 });

      // 저장 후 다시 그려진 화면에 값이 남아야 한다 — 저장은 됐는데 화면이 비면 관리자는
      // 요금표가 안 들어간 줄 알고 다시 저장한다.
      await expect(page.locator('input[name="base_fare"]').first()).toHaveValue('30000');

      const saved = await db.get(
        'SELECT base_fare, surcharge_fare FROM branch_dispatch_fare_rules WHERE branch_id = ? ORDER BY tier_seq LIMIT 1',
        [branchId]
      );
      expect(Number(saved.base_fare)).toBe(30000);
      expect(Number(saved.surcharge_fare)).toBe(800);
    } finally {
      await db.run('DELETE FROM branch_dispatch_fare_rules WHERE branch_id = ?', [branchId]);
      for (const r of before) {
        await db.run(
          `INSERT INTO branch_dispatch_fare_rules (branch_id, tier_seq, base_distance_km, base_fare,
             surcharge_unit_km, surcharge_fare, max_distance_km, max_fare, round_unit, round_method)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.branch_id, r.tier_seq, r.base_distance_km, r.base_fare, r.surcharge_unit_km,
            r.surcharge_fare, r.max_distance_km, r.max_fare, r.round_unit, r.round_method]
        );
      }
    }

    expect(problems, `페이지 오류: ${problems.join(' | ')}`).toEqual([]);
  });

  test('오더리스트에 배차 요금이 보이고, 없는 오더는 0원이 아니라 -로 나온다', async ({ page }) => {
    test.skip(!orderIds.length, '검사용 오더를 만들지 못했습니다');
    await loginWithRetry(page, { baseUrl: NEXT_BASE_URL, loginId: LOGIN_ID, password: PASSWORD });

    // 컬럼 설정이 저장돼 있는 사람 — 배차 요금이 생기기 전에 저장한 상태를 흉내낸다.
    // 이 경우에도 새 컬럼이 켜져야 한다(안 그러면 코드에만 있고 화면엔 영영 없다).
    await page.goto(`${NEXT_BASE_URL}/orders`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      localStorage.setItem('orderList.columns.v1', JSON.stringify({
        order: ['oid', 'branch', 'origin', 'destination', 'fare', 'status'],
        visible: ['oid', 'branch', 'origin', 'destination', 'fare', 'status'],
      }));
    });

    await page.goto(`${NEXT_BASE_URL}/orders?q=${encodeURIComponent(MARK)}`, { waitUntil: 'networkidle' });
    await expect(page.locator('th', { hasText: '배차 요금' })).toHaveCount(1);

    // 행 전체가 아니라 그 칸을 본다 — 계약 요금 120,000원에도 "0원"이 들어 있어서 행 전체로
    // 보면 무엇을 확인한 건지 알 수 없다.
    const cell = (mark) => page.locator(`tbody tr:has-text("${mark}") td[data-column="dispatch_fare"]`);
    await expect(page.locator(`tbody tr:has-text("${MARK}출발0")`)).toHaveCount(1);
    await expect(cell(`${MARK}출발0`)).toHaveText('38,000원');
    // 배차 요금이 없는 오더가 0원으로 찍히면 "무료 배차"로 읽힌다.
    await expect(cell(`${MARK}출발1`)).toHaveText('-');
  });
});
