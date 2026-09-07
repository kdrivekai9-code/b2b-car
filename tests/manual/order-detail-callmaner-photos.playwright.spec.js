// 오더 상세(Next.js)의 콜마너 탁송사진 섹션.
//
// 왜 필요한가: 이 화면은 서버 컴포넌트라 이벤트 핸들러(onError)를 그대로 넣으면
// "Event handlers cannot be passed to Client Component props" 런타임 오류가 난다.
// next build는 통과하고 화면을 열 때만 터지는 종류라, 빌드 검사로는 절대 못 잡는다 —
// 실제로 그렇게 배포됐다가 사용자가 화면에서 발견했다.
//
// 그래서 "빌드가 되는가"가 아니라 "화면이 실제로 열리는가"를 본다.
const { test, expect } = require('@playwright/test');
const db = require('../../db');
const { loginWithRetry } = require('./helpers/auth');

// 이 화면은 Next(3001)에서 뜬다(NEXT_ORDER_DETAIL_EDIT_ENABLED). Express(3000)로 열면
// 서버 컴포넌트를 타지 않아 이 검사가 무의미해진다.
const BASE_URL = process.env.E2E_NEXT_BASE_URL || 'http://localhost:3001';
// 계정·비밀번호는 한 곳에서 가져온다 — 값이 없으면 즉시 멈춘다(tests/e2e-credentials.js).
const { LOGIN_ID, PASSWORD } = require('../e2e-credentials');
const MARK = 'e2e-detail-photos';

let orderId = null;

test.beforeAll(async () => {
  const branch = await db.get('SELECT id FROM branches ORDER BY id LIMIT 1');
  const order = await db.get(
    `INSERT INTO orders (oid, branch_id, status, memo_customer, origin_address, destination_address, reserved_date, reserved_time)
     VALUES (?, ?, '완료', ?, ?, ?, '2026-08-20', '14:00') RETURNING id`,
    [`${MARK}-oid`, branch.id, MARK, '서울 강서구', '경기 성남시']
  );
  orderId = Number(order.id);
  for (const [phase, seq] of [['start', 1], ['start', 2], ['end', 1]]) {
    await db.run(
      `INSERT INTO order_callmaner_photos (order_id, phase, seq, url) VALUES (?, ?, ?, ?)`,
      [orderId, phase, seq, `https://example.invalid/${MARK}_${phase}_${seq}.jpg`]
    ).catch(() => {});
  }
});

test.afterAll(async () => {
  if (orderId) {
    await db.run('DELETE FROM order_callmaner_photos WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]).catch(() => {});
  }
  // 풀은 여기서 닫지 않는다 — workers: 1이라 같은 프로세스의 다음 스펙이 죽는다.
  // 전부 끝난 뒤 한 번 닫는 일은 tests/global-teardown.js가 맡는다.
});

test.describe('오더 상세 · 콜마너 탁송사진', () => {
  test.describe.configure({ timeout: 90000 });

  test('서버 컴포넌트 오류 없이 사진이 렌더된다', async ({ page }) => {
    // 썸네일 자체가 안 열리는 것(ERR_NAME_NOT_RESOLVED)은 여기서 보려는 오류가 아니다 —
    // 이 검사는 일부러 열리지 않는 URL을 쓰고, 링크 만료 시의 폴백이 그 상황이다.
    // 자바스크립트/렌더 오류만 모은다.
    const problems = [];
    const isImageLoadFailure = (t) => /Failed to load resource/.test(t);
    page.on('pageerror', (e) => problems.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !isImageLoadFailure(m.text())) problems.push(m.text());
    });

    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    const res = await page.goto(`${BASE_URL}/orders/${orderId}`, { waitUntil: 'networkidle' });
    expect(res.status()).toBe(200);

    // 이 문구가 화면에 찍히면 서버 컴포넌트에 핸들러를 넘긴 것이다.
    const body = await page.textContent('body');
    expect(body).not.toContain('Event handlers cannot be passed');

    await expect(page.getByText('콜마너 탁송사진')).toBeVisible();

    // 8308a98부터 운행전·운행후를 **순번으로 짝지어** 놓는다. 그래서 "운행전"이라는 글자가
    // 안내문과 칸마다 여럿 나온다 — getByText('운행전')은 strict mode에서 걸린다.
    // 무엇을 보려는지에 맞춰 자리를 지목한다.
    await expect(page.getByText('운행전 · 운행후')).toBeVisible();

    // 넣어둔 사진은 start/1, start/2, end/1 세 장이다. 순번은 1·2 두 줄이 되고,
    // 줄마다 운행전·운행후 두 칸이라 칸은 넷, 그중 하나(2번 운행후)는 빈 자리다.
    await expect(page.locator('.photo-row')).toHaveCount(2);
    await expect(page.locator('.photo-cell')).toHaveCount(4);
    // 링크는 만료될 수 있어 썸네일이 깨져도 되지만, 링크 자체는 남아야 한다.
    await expect(page.locator('a.photo-cell')).toHaveCount(3);
    // 빠진 자리가 보여야 "안 찍었다"를 알 수 있다 — 그게 이 배치의 목적이다.
    await expect(page.locator('.photo-cell.empty')).toHaveCount(1);
    await expect(page.getByText('운행후 없음')).toBeVisible();

    // 같은 줄에 같은 항목의 운행전·운행후가 놓여야 비교가 된다. 순번이 어긋나면
    // 흠집이 언제 생겼는지를 엉뚱한 사진으로 따지게 된다.
    const firstRow = page.locator('.photo-row').first();
    await expect(firstRow.locator('.photo-label')).toHaveText('1. 전면');
    await expect(firstRow.locator('.photo-phase')).toHaveText(['운행전', '운행후']);

    expect(problems, `콘솔/페이지 오류: ${problems.join(' | ')}`).toEqual([]);
  });
});
