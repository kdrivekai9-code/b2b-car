// 지사관리 "고객 통보" 설정 화면 — 상태별 사용 여부·보내는 시점·문구를 저장한다.
//
// 이 화면의 값이 그대로 고객에게 나가는 문구가 된다. 저장이 조용히 안 되면 관리자는 바꿨다고
// 믿는데 실제로는 옛 문구가 계속 나간다 — 화면만 보고는 알 수 없는 종류의 고장이라 여기서 본다.
const { test, expect } = require('@playwright/test');
const db = require('../../db');
const { loginWithRetry } = require('./helpers/auth');

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
// 계정·비밀번호는 한 곳에서 가져온다 — 값이 없으면 즉시 멈춘다(tests/e2e-credentials.js).
const { LOGIN_ID, PASSWORD } = require('../e2e-credentials');

let branchId = null;
let savedRows = [];
let supportsAttachPhotos = false;

// 이 DB는 프로덕션과 같다. 지사가 실제로 저장해둔 설정이 있을 수 있으므로, 손대기 전에 그대로
// 떠놓고 끝나면 되돌린다 — "테스트가 만든 행을 지운다"만으로는 원래 있던 행까지 날아간다.
test.beforeAll(async () => {
  const branch = await db.get('SELECT id FROM branches ORDER BY id LIMIT 1');
  branchId = branch ? Number(branch.id) : null;
  if (!branchId) return;
  // attach_photos까지 떠놓는다 — 빼면 복원할 때 그 스위치가 조용히 꺼진다.
  savedRows = await db.all(
    'SELECT * FROM branch_customer_notifications WHERE branch_id = ?',
    [branchId]
  ).catch(() => []);
  const col = await db.get(
    "SELECT 1 AS ok FROM information_schema.columns WHERE table_name = 'branch_customer_notifications' AND column_name = 'attach_photos'"
  ).catch(() => null);
  supportsAttachPhotos = !!col;
});

test.afterAll(async () => {
  if (branchId) {
    await db.run('DELETE FROM branch_customer_notifications WHERE branch_id = ?', [branchId]).catch(() => {});
    for (const row of savedRows) {
      const ok = await db.run(`
        INSERT INTO branch_customer_notifications (branch_id, event_type, enabled, delay_minutes, message_template, attach_photos)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [branchId, row.event_type, row.enabled, row.delay_minutes, row.message_template, row.attach_photos === true])
        .then(() => true).catch(() => false);
      if (!ok) {
        // attach_photos 컬럼이 없는 DB(마이그레이션 전)
        await db.run(`
          INSERT INTO branch_customer_notifications (branch_id, event_type, enabled, delay_minutes, message_template)
          VALUES (?, ?, ?, ?, ?)
        `, [branchId, row.event_type, row.enabled, row.delay_minutes, row.message_template]).catch(() => {});
      }
    }
  }
  // 풀은 여기서 닫지 않는다 — workers: 1이라 같은 프로세스의 다음 스펙이 죽는다.
  // 전부 끝난 뒤 한 번 닫는 일은 tests/global-teardown.js가 맡는다.
});

async function openPage(page) {
  await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
  // 첫 지사를 대상으로 본다 — 어느 지사든 화면 구조는 같다.
  await page.goto(`${BASE_URL}/branches`, { waitUntil: 'domcontentloaded' });
  const firstTab = page.locator('.branch-tabs a', { hasText: '고객 통보' }).first();
  await expect(firstTab).toBeVisible();
  await firstTab.click();
  await page.waitForLoadState('domcontentloaded');
  // 화면이 고른 지사가 스냅샷을 뜬 지사와 같은지 확인한다 — 다르면 엉뚱한 지사를 되돌리게 된다.
  const match = page.url().match(/\/branches\/(\d+)\/customer-notifications/);
  expect(match && Number(match[1])).toBe(branchId);
}

test.describe('지사관리 · 고객 통보', () => {
  test.describe.configure({ timeout: 90000 });

  test('다섯 가지 사건이 모두 설정 대상으로 나온다', async ({ page }) => {
    await openPage(page);

    // 사건이 하나 늘었는데 화면에서 빠지면, 그 통보만 아무도 못 끄는 상태가 된다.
    // 시간칸은 "상태 변경 후"일 때만 보이므로(즉시면 감춘다) 존재만 확인한다 — 보임 여부는
    // 아래 '즉시를 고르면' 검사에서 라디오와 함께 본다.
    for (const key of ['dispatched', 'started', 'completed', 'dispatch_cancelled', 'cancelled']) {
      await expect(page.locator(`textarea[name="message_${key}"]`)).toBeVisible();
      await expect(page.locator(`input[name="delay_${key}"]`)).toHaveCount(1);
      await expect(page.locator(`input[name="enabled_${key}"]`)).toBeVisible();
    }

    // 지연 기본값 자체(배차 2분, 나머지 0분)는 지사가 바꿀 수 있는 값이라 여기서 단언하지
    // 않는다 — 코드 기본값은 scripts/check-kakao-order-notify.js가 본다. 여기서는 화면이
    // 저장값과 라디오 상태를 어긋나지 않게 그리는지만 확인한다.
    for (const key of ['dispatched', 'started', 'completed', 'dispatch_cancelled', 'cancelled']) {
      const value = Number(await page.locator(`input[name="delay_${key}"]`).inputValue());
      expect(Number.isInteger(value) && value >= 0 && value <= 120).toBe(true);
      const nowChecked = await page.locator(`input[name="delay_mode_${key}"][value="now"]`).isChecked();
      expect(nowChecked).toBe(value === 0);
    }
  });

  test('변수 칩을 누르면 커서 위치에 토큰이 들어간다', async ({ page }) => {
    await openPage(page);

    const box = page.locator('textarea[name="message_started"]');
    await box.fill('');
    await box.click();
    await page.locator('.var-chip[data-target="message_started"][data-token="{oid}"]').click();
    await expect(box).toHaveValue('{oid}');
    // 이어서 누르면 커서 뒤에 붙는다(값을 갈아치우지 않는다).
    await page.locator('.var-chip[data-target="message_started"][data-token="{driver_name}"]').click();
    await expect(box).toHaveValue('{oid}{driver_name}');
  });

  test('즉시를 고르면 분 입력이 감춰지고 0으로 잠긴다', async ({ page }) => {
    await openPage(page);

    const delay = page.locator('input[name="delay_dispatched"]');
    await page.locator('input[name="delay_mode_dispatched"][value="now"]').check();
    // 시간칸은 눈에서 사라진다 — "즉시"인데 분 입력이 남아 있으면 뭘 고른 건지 헷갈린다.
    await expect(delay).toBeHidden();
    await expect(delay).toHaveValue('0');
    // 감췄을 뿐 DOM에는 남아야 한다. disabled/제거면 값이 전송되지 않아 서버 검증(필수)에 걸린다.
    await expect(delay).toHaveJSProperty('readOnly', true);
    await expect(delay).toBeEnabled();

    await page.locator('input[name="delay_mode_dispatched"][value="later"]').check();
    await expect(delay).toBeVisible();
    await expect(delay).toHaveJSProperty('readOnly', false);
  });

  test('즉시로 저장해도 서버 검증에 걸리지 않는다', async ({ page }) => {
    // 시간칸을 감추는 방식이 잘못되면(disabled·DOM 제거) 값이 전송되지 않아 저장이 조용히
    // 실패하거나 서버 검증 오류로 튄다. 감춘 채로 실제 저장까지 되는지 본다.
    await openPage(page);
    const url = page.url();
    const originalDelay = await page.locator('input[name="delay_completed"]').inputValue();

    try {
      await page.locator('input[name="delay_mode_completed"][value="now"]').check();
      await page.locator('button[type="submit"][form="customerNotificationsForm"]').click();
      await page.waitForLoadState('domcontentloaded');
      await expect(page.locator('.success-msg')).toContainText('저장되었습니다');

      const row = await db.get(
        "SELECT delay_minutes FROM branch_customer_notifications WHERE branch_id = ? AND event_type = 'completed'",
        [branchId]
      );
      expect(Number(row.delay_minutes)).toBe(0);
    } finally {
      // 실제 운영 지사의 설정이라 원래 값으로 되돌린다. 원래도 0이었으면 되돌릴 것이 없다 —
      // 없는 값을 만들어 넣지 않는다(1분으로 되돌렸다가 실제 설정을 바꿔버린 적이 있다).
      if (originalDelay !== '0') {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.locator('input[name="delay_mode_completed"][value="later"]').check();
        await page.locator('input[name="delay_completed"]').fill(originalDelay);
        await page.locator('button[type="submit"][form="customerNotificationsForm"]').click();
        await page.waitForLoadState('domcontentloaded');
      }
    }
  });

  test('사진첨부는 운행시작·운행완료에만 있고 저장된다', async ({ page }) => {
    await openPage(page);
    const url = page.url();

    // 배차 시점에는 아직 탁송사진이 없어 스위치를 주지 않는다.
    await expect(page.locator('input[name="attach_photos_dispatched"]')).toHaveCount(0);
    await expect(page.locator('input[name="attach_photos_started"]')).toHaveCount(1);
    await expect(page.locator('input[name="attach_photos_completed"]')).toHaveCount(1);

    // 컬럼이 없으면(마이그레이션 20260814010000 전) 저장 자체가 불가하다 — 화면 구조만 확인하고 끝낸다.
    test.skip(!supportsAttachPhotos, 'attach_photos 컬럼이 아직 없습니다');

    const box = page.locator('input[name="attach_photos_completed"]');
    const original = await box.isChecked();
    try {
      await box.setChecked(!original);
      await page.locator('button[type="submit"][form="customerNotificationsForm"]').click();
      await page.waitForLoadState('domcontentloaded');
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('input[name="attach_photos_completed"]')).toBeChecked({ checked: !original });
    } finally {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.locator('input[name="attach_photos_completed"]').setChecked(original);
      await page.locator('button[type="submit"][form="customerNotificationsForm"]').click();
      await page.waitForLoadState('domcontentloaded');
    }
  });

  test('미리보기가 실제 렌더 결과를 보여준다', async ({ page }) => {
    await openPage(page);

    // 화면에서 규칙을 다시 구현하면 실제 발송과 어긋나므로 서버 렌더 결과를 그대로 보여준다.
    const preview = page.locator('.notify-event-block', { has: page.locator('textarea[name="message_started"]') })
      .locator('.notify-preview pre');
    await expect(preview).toContainText('요청하신 탁송건이 운행시작 되었습니다');
    await expect(preview).toContainText('OID1246');
    // 변수가 치환되지 않고 그대로 남으면 안 된다.
    await expect(preview).not.toContainText('{oid}');
  });

  test('바꾼 문구와 시점이 저장되고 다시 열어도 남아 있다', async ({ page }) => {
    await openPage(page);
    const url = page.url();

    const marker = `자동확인-${Date.now()}`;
    const original = await page.locator('textarea[name="message_completed"]').inputValue();
    const originalDelay = await page.locator('input[name="delay_completed"]').inputValue();

    try {
      await page.locator('textarea[name="message_completed"]').fill(`{oid} ${marker}`);
      // 즉시(기본 0분)일 때 분 입력은 readonly다 — 먼저 "상태 변경 후"를 골라야 값을 바꿀 수 있다.
      await page.locator('input[name="delay_mode_completed"][value="later"]').check();
      await page.locator('input[name="delay_completed"]').fill('3');
      await page.locator('button[type="submit"][form="customerNotificationsForm"]').click();
      await page.waitForLoadState('domcontentloaded');

      await expect(page.locator('.success-msg')).toContainText('저장되었습니다');
      // 저장 후 화면이 아니라 다시 불러온 화면에서 확인한다 — 폼에 남은 값은 저장 여부를 증명하지 못한다.
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('textarea[name="message_completed"]')).toHaveValue(`{oid} ${marker}`);
      await expect(page.locator('input[name="delay_completed"]')).toHaveValue('3');
    } finally {
      // 실제 운영 지사의 설정이라 원래 값으로 되돌린다.
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.locator('textarea[name="message_completed"]').fill(original);
      await page.locator('input[name="delay_mode_completed"][value="later"]').check();
      await page.locator('input[name="delay_completed"]').fill(originalDelay);
      await page.locator('button[type="submit"][form="customerNotificationsForm"]').click();
      await page.waitForLoadState('domcontentloaded');
    }
  });

  test('잘못된 값은 저장하지 않고 이유를 알려준다', async ({ page }) => {
    await openPage(page);

    await page.locator('textarea[name="message_cancelled"]').fill('   ');
    await page.locator('button[type="submit"][form="customerNotificationsForm"]').click();
    await page.waitForLoadState('domcontentloaded');

    // 빈 문구가 저장되면 그 상태에서는 고객에게 아무 말도 못 하게 된다.
    await expect(page.locator('.error-msg')).toContainText('문구를 입력해주세요');
  });
});
