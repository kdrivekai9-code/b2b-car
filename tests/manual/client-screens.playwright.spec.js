// 고객(client) 계정으로만 보이는 화면들 — 오더 리스트 컬럼 구성과 사진 전송리스트.
//
// 왜 따로 필요한가: 이 화면들은 관리자 계정으로 열 수 없다(requireRole('client'), 그리고
// 컬럼 기본값이 역할로 갈린다). 그래서 지금까지 서버 쪽 검사와 템플릿 렌더로만 확인했고
// "실제 브라우저에서 그렇게 보이는지"는 확인하지 못한 채로 있었다.
//
// 계정은 E2E_CLIENT_LOGIN_ID / E2E_CLIENT_PASSWORD를 쓴다. 없으면 이 파일만 건너뛴다 —
// 관리자 계정처럼 없다고 전체를 멈추면 그 계정이 없는 환경에서 나머지 검사까지 못 돌린다.
const { test, expect } = require('@playwright/test');
const { loginWithRetry } = require('./helpers/auth');
const { clientCredentials } = require('../e2e-credentials');

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const CLIENT = clientCredentials();

// 로그인은 이 파일에서 딱 한 번만 한다.
//
// 이 서비스는 단일세션이라 같은 계정으로 다시 로그인하면 앞 세션이 끊긴다. 테스트마다
// 로그인하면(beforeEach) 그 횟수만큼 세션이 갈리고, 한 워커에서 여러 스펙이 이어 도는 이 설정
// (workers: 1)에서는 **다른 스펙 파일의 로그인까지 밀어낸다** — 실제로 그렇게 해서
// group-settings-pages가 403으로 무더기 실패했다(access_logs에 LOGIN_BLOCKED로 남는다).
// 그래서 serial 모드로 페이지 하나를 공유한다.
test.describe.configure({ mode: 'serial', timeout: 120000 });

test.describe('고객 화면', () => {
  test.skip(!CLIENT, 'E2E_CLIENT_LOGIN_ID / E2E_CLIENT_PASSWORD가 없어 건너뜁니다.');

  let page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await loginWithRetry(page, { baseUrl: BASE, loginId: CLIENT.loginId, password: CLIENT.password });
  });
  test.afterAll(async () => { if (page) await page.close(); });

  // 컬럼 설정은 브라우저(localStorage)에 남는다. 앞선 테스트가 남긴 값이 있으면 기본값을
  // 확인할 수 없으므로 목록을 볼 때마다 비우고 다시 연다.
  async function openOrdersFresh() {
    await page.goto(`${BASE}/orders`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      localStorage.removeItem('orderList.columns.v1');
      localStorage.removeItem('orderList.widths.v1');
      localStorage.removeItem('orderList.density.v1');
    });
    await page.goto(`${BASE}/orders`, { waitUntil: 'domcontentloaded' });
  }

  test('오더 리스트 — 지사는 없고, 담당자가 요청 법인 자리에 온다', async () => {
    await openOrdersFresh();
    const table = page.locator('#ordersTable');
    await expect(table).toHaveAttribute('data-my-role', 'client');

    // 지사는 아예 그리지 않는다 — 고객은 자기 지사 하나뿐이라 모든 줄이 같은 값이다.
    await expect(table.locator('th[data-column="branch"]')).toHaveCount(0);
    await expect(table.locator('th[data-column="created_by"]')).toHaveCount(1);

    // 보이는 헤더 순서: OID 다음이 담당자여야 하고, 요청 법인은 기본으로 꺼져 있어야 한다.
    const visible = await table.locator('thead th:visible').evaluateAll(
      (els) => els.map((el) => el.dataset.column)
    );
    expect(visible.slice(0, 2)).toEqual(['oid', 'created_by']);
    expect(visible).not.toContain('group');
    expect(visible).not.toContain('branch');

    // 컬럼 설정 창에서는 요청 법인을 고를 수 있어야 한다(지우지 않고 맨 뒤로 보낸 것뿐이다).
    const all = await table.locator('thead th').evaluateAll((els) => els.map((el) => el.dataset.column));
    expect(all).toContain('group');
    expect(all[all.length - 1]).toBe('group');
  });

  test('오더 리스트 — 담당자 칸에 회사명 없이 이름만 나온다', async () => {
    await openOrdersFresh();
    const cells = page.locator('#ordersTable td[data-column="created_by"]');
    const count = await cells.count();
    test.skip(count === 0, '이 법인에 오더가 없어 담당자 칸을 확인할 수 없습니다.');

    // 같은 법인 안에서는 회사명이 모든 줄에 반복될 뿐이라 뗀다. 법인명이 그대로 남아 있으면
    // 정작 사람 이름이 뒤로 밀린다.
    const groupName = await page.locator('#ordersTable td[data-column="group"]').first()
      .evaluate((el) => el.textContent.trim()).catch(() => '');
    const texts = await cells.allTextContents();
    texts.forEach((t) => {
      expect(t.trim()).not.toBe('');
      if (groupName && groupName !== '-') expect(t.trim().startsWith(groupName)).toBe(false);
    });
  });

  test('사진 전송리스트 — 목록이 열리고 사진보기·다운로드로 이어진다', async () => {
    await page.goto(`${BASE}/my/photos`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: '사진 전송리스트' })).toBeVisible();

    const rows = page.locator('table.table tbody tr');
    const count = await rows.count();
    if (!count) {
      // 사진이 붙은 오더가 없는 환경도 정상이다 — 그때는 안내 문구가 떠야 한다.
      await expect(page.getByText('아직 사진이 등록된 오더가 없습니다.')).toBeVisible();
      return;
    }

    const view = rows.first().getByRole('link', { name: /사진보기/ });
    const blocked = await rows.first().getByText('사진 공개가 설정되지 않았습니다').count();
    test.skip(blocked > 0, '이 지사는 사진 공개가 꺼져 있어 상세를 확인할 수 없습니다.');

    await view.click();
    await expect(page.getByRole('heading', { name: '탁송 사진' })).toBeVisible();
    // 운행 전/완료 후가 나뉘어 보여야 같은 자리를 비교할 수 있다 — 사고 처리의 전부가 그것이다.
    const sections = await page.locator('.card h2').allTextContents();
    expect(sections.some((t) => t.includes('운행 전') || t.includes('운행 완료 후'))).toBe(true);
    // 항목 이름이 붙어야 무엇을 찍은 사진인지 알 수 있다.
    await expect(page.locator('.photo-cap').first()).toBeVisible();

    // 전체 다운로드가 실제로 ZIP을 준다. 콜마너 링크가 만료됐으면 502가 정상이라 그것도 통과로
    // 본다 — 여기서 보려는 것은 "버튼이 이어져 있고 서버가 zip으로 답한다"이다.
    const url = page.url();
    const res = await page.request.get(`${url}/download.zip`);
    expect([200, 502]).toContain(res.status());
    if (res.status() === 200) {
      expect(res.headers()['content-type']).toContain('zip');
      const body = await res.body();
      // ZIP 서명(PK\x03\x04) — 이름만 .zip인 파일이 내려오는 것을 막는다.
      expect(body.slice(0, 4).toString('latin1')).toBe('PK');
    }
  });

  test('사진 전송리스트 메뉴가 사이드바에 있다', async () => {
    await page.goto(`${BASE}/orders`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('nav a[href="/my/photos"]')).toHaveCount(1);
    await expect(page.locator('nav a[href="/my/settlement"]')).toHaveCount(1);
  });
});
