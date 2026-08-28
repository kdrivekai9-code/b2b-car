// 차종 관리 화면이 "등록된 것"만이 아니라 "자동으로 인식되는 것"까지 보여주는지.
//
// 실사용 지적(2026-08-28): "등록화면이 내가 등록한 것밖에 안 보인다."
//
// 그 말이 맞았다. 화면은 vehicle_models 테이블만 그렸는데 그 표에는 몇 건뿐이고, 실제 판정
// 근거인 사전(수입 브랜드 125개 등)은 코드(lib/vehicleClass.js)에 있어 화면에 없었다.
// 게다가 안내문이 "여기 등록된 판정값으로 붙습니다"여서, 그대로 읽으면 등록하지 않은 차종에는
// 할증이 안 붙는 줄 안다 — 실제로는 등록이 없어도 사전으로 판정해서 붙는다.
//
// 관리자가 이걸 모르면 두 방향으로 틀린다: 이미 잡히는 차종을 중복 등록하거나, 반대로 새고
// 있는 차종을 못 찾는다.
const { test, expect } = require('@playwright/test');
const { loginWithRetry } = require('./helpers/auth');
const db = require('../../db');
const { IMPORT_BRANDS, EV_KEYWORDS, classifyVehicleModel } = require('../../lib/vehicleClass');

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
// 로그인 계정: 실사용 admin으로 로그인하면 단일 세션 강제 때문에 그 계정을 쓰던 사람이
// 로그아웃된다 — QA 전용 계정을 쓴다. 비밀번호는 .env(E2E_PASSWORD)에서 온다.
const LOGIN_ID = process.env.E2E_LOGIN_ID || 'qa_test_bot';
const PASSWORD = process.env.E2E_PASSWORD || '';

test.afterAll(async () => { await db.pool.end().catch(() => {}); });

test.describe('차종 관리 · 자동 인식 사전', () => {
  test.describe.configure({ timeout: 180000 });

  test('등록 건수와 무관하게 자동 인식 사전이 보이고 검색된다', async ({ page }) => {
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));

    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    const res = await page.goto(`${BASE_URL}/vehicle-models`, { waitUntil: 'domcontentloaded' });
    expect(res.status()).toBe(200);

    const dict = page.locator('.card', { hasText: '자동 인식 사전' });
    await expect(dict, '사전 섹션이 있어야 한다').toHaveCount(1);

    // 사전이 코드에서 그대로 실려야 한다 — 일부만 그리면 "없는 줄" 알고 중복 등록한다.
    // 코드의 사전 길이를 그대로 기대값으로 쓴다(화면과 코드가 갈리면 여기서 걸린다).
    const words = dict.locator('.dict-word');
    await expect(dict.locator('.dict-group[data-key="import_brand"] .dict-word'))
      .toHaveCount(IMPORT_BRANDS.length);
    await expect(dict.locator('.dict-group[data-key="ev"] .dict-word'))
      .toHaveCount(EV_KEYWORDS.length);
    // 묶음을 지정해서 본다 — 'tesla'는 수입 브랜드이자 전기차라 두 묶음에 다 들어 있다.
    const brandGroup = dict.locator('.dict-group[data-key="import_brand"]');
    await expect(brandGroup.getByText('벤츠', { exact: true })).toHaveCount(1);
    await expect(brandGroup.getByText('tesla', { exact: true })).toHaveCount(1);
    await expect(dict.locator('.dict-group[data-key="ev"]').getByText('tesla', { exact: true })).toHaveCount(1);

    // 등록된 차종은 몇 건뿐인데 사전은 수백 개다 — 이 차이가 이번 지적의 핵심이다.
    expect(await words.count(), '사전 낱말 수').toBeGreaterThan(100);

    // 안내문이 "등록해야 붙는다"로 읽히면 안 된다.
    await expect(page.getByText('등록하지 않은 차종에도 붙습니다')).toBeVisible();

    // 검색이 되어야 쓸모가 있다 — 수백 개를 눈으로 훑을 수는 없다.
    await page.locator('#dictFilter').fill('벤츠');
    await expect(brandGroup.getByText('벤츠', { exact: true })).toBeVisible();
    // 걸리지 않은 낱말은 숨는다.
    await expect(dict.locator('.dict-group[data-key="large"]').getByText('봉고', { exact: true })).toBeHidden();
    // 걸린 게 하나도 없는 묶음은 통째로 숨는다 — 빈 묶음이 남으면 "없음"인지 "안 펼침"인지 모른다.
    const visibleGroups = await dict.locator('.dict-group:visible').count();
    expect(visibleGroups).toBeGreaterThan(0);

    await page.locator('#dictFilter').fill('');
    await expect(dict.locator('.dict-group[data-key="large"]').getByText('봉고', { exact: true })).toBeAttached();

    expect(problems, `페이지 오류: ${problems.join(' | ')}`).toEqual([]);
  });

  // 코드 사전에 빠진 브랜드를 배포 없이 채울 수 있어야 한다 — 못 채우면 그 차종은 할증이
  // 조용히 빠진 채로 남는다(요금이 적게 나가는 쪽이라 아무도 눈치채지 못한다).
  test('빠진 낱말을 화면에서 더하면 판정에 반영되고, 지우면 되돌아간다', async ({ page }) => {
    const WORD = 'e2e쿠프라';
    const wipe = async () => {
      await db.run('DELETE FROM vehicle_class_keywords WHERE word LIKE ?', [`${WORD}%`]).catch(() => {});
    };
    await wipe();

    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    try {
      await page.goto(`${BASE_URL}/vehicle-models`, { waitUntil: 'domcontentloaded' });

      // 더하기 전에는 아무 할증도 안 붙는 이름이어야 검사가 성립한다.
      expect(classifyVehicleModel(`${WORD} 포맨터`).isImported, '검사 전제').toBe(false);

      const form = page.locator('form[action="/vehicle-models/keywords"]');
      await form.locator('select[name="kind"]').selectOption('import_brand');
      await form.locator('input[name="word"]').fill(WORD);
      await form.locator('input[name="note"]').fill('e2e');
      await form.getByRole('button', { name: '추가' }).click();
      await page.waitForURL(/saved=1/, { timeout: 20000 });

      const saved = await db.get('SELECT kind, word FROM vehicle_class_keywords WHERE word = ?', [WORD]);
      expect(saved && saved.kind).toBe('import_brand');
      // 목록에 다시 보여야 관리자가 무엇을 더했는지 안다.
      await expect(page.getByText(WORD, { exact: true })).toBeVisible();

      // 한 글자는 아무 이름에나 걸려 국산차를 수입으로 만든다 — 막혀야 한다.
      // 화면에는 minlength가 있어 브라우저가 먼저 막지만, 그건 우회할 수 있으니 **서버가**
      // 막는지를 본다(화면 검증만 있으면 API로 넣으면 그대로 들어간다).
      await expect(form.locator('input[name="word"]')).toHaveAttribute('minlength', '2');
      const rejected = await page.evaluate(async () => {
        const body = new URLSearchParams({ kind: 'import_brand', word: '가' });
        const r = await fetch('/vehicle-models/keywords', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        return r.url;
      });
      expect(decodeURIComponent(rejected), '서버가 사유를 밝히며 거절해야 한다').toContain('두 글자 이상');
      expect(await db.get('SELECT id FROM vehicle_class_keywords WHERE word = ?', ['가'])).toBeFalsy();

      // 지우면 되돌아가야 한다 — 잘못 넣었을 때 되돌릴 길이 없으면 아무도 안 쓴다.
      const row = page.locator('tr', { hasText: WORD });
      await row.getByRole('button', { name: '삭제' }).click();
      await page.waitForURL(/saved=1/, { timeout: 20000 });
      expect(await db.get('SELECT id FROM vehicle_class_keywords WHERE word = ?', [WORD])).toBeFalsy();
    } finally {
      await wipe();
    }
  });
});
