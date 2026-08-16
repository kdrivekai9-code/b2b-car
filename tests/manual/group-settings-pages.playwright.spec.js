// 법인관리 서브메뉴 6개가 실제로 열리는지.
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
const LOGIN_ID = process.env.E2E_LOGIN_ID || 'admin';
const PASSWORD = process.env.E2E_PASSWORD || 'Admin!2345';

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
  { path: 'customer-notifications', title: '고객 통보', mustHave: '상태별 고객 통보' },
  { path: 'dispatch-delay', title: '배차지연 알림', mustHave: '지연 판단과 상향 금액' },
];

test.describe('법인관리 · 법인별 설정 화면', () => {
  test.describe.configure({ timeout: 180000 });

  test('여섯 화면이 모두 열리고 탭이 서로를 가리킨다', async ({ page }) => {
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
});
