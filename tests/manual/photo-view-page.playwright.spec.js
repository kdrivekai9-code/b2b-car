// 고객용 사진 모아보기 페이지(/photos/:token).
//
// 왜 필요한가: 카카오톡 본문에 사진 링크를 13줄 나열할 수 없어 이 페이지 하나로 모았다.
// 고객이 로그인 없이 여는 유일한 열람 경로라, 토큰이 틀렸을 때와 지사가 열람을 막았을 때
// 실제로 막히는지가 중요하다 — 링크 하나로 남의 오더 사진이 열리면 안 된다.
const { test, expect } = require('@playwright/test');
const db = require('../../db');

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const MARK = 'e2e-photo-view';

let orderId = null;
let token = null;
let branchId = null;
let savedCanView = null;

test.beforeAll(async () => {
  const branch = await db.get('SELECT id FROM branches ORDER BY id LIMIT 1');
  branchId = Number(branch.id);
  const settings = await db.get('SELECT client_can_view FROM branch_photo_settings WHERE branch_id = ?', [branchId]).catch(() => null);
  savedCanView = settings ? settings.client_can_view : null;

  const order = await db.get(
    `INSERT INTO orders (oid, branch_id, status, memo_customer, origin_address, destination_address, reserved_date, reserved_time)
     VALUES (?, ?, '완료', ?, ?, ?, '2026-08-20', '14:00') RETURNING id, photo_view_token`,
    [`${MARK}-oid`, branchId, MARK, '서울 강서구', '경기 성남시']
  );
  orderId = Number(order.id);
  token = order.photo_view_token;

  // 계기판 표시가 붙는지 보려면 지사 설정 순번(기본 13)만큼 사진이 있어야 한다.
  for (let seq = 1; seq <= 13; seq += 1) {
    await db.run(
      `INSERT INTO order_callmaner_photos (order_id, phase, seq, url) VALUES (?, 'start', ?, ?)`,
      [orderId, seq, `https://example.invalid/${MARK}_1_${seq}.jpg`]
    );
  }
  // 열람 허용 상태에서 시작한다(막힘 검사는 테스트 안에서 직접 끈다).
  // client_can_view는 boolean이 아니라 integer(0/1)다 — 이 스키마의 다른 플래그들과 같다.
  await db.run(
    `INSERT INTO branch_photo_settings (branch_id, client_can_view) VALUES (?, 1)
     ON CONFLICT (branch_id) DO UPDATE SET client_can_view = 1`,
    [branchId]
  ).catch(() => {});
});

test.afterAll(async () => {
  if (orderId) {
    await db.run('DELETE FROM order_callmaner_photos WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]).catch(() => {});
  }
  // 지사 설정은 손대기 전 값으로 되돌린다(운영 지사 설정이다).
  if (branchId && savedCanView !== null) {
    await db.run('UPDATE branch_photo_settings SET client_can_view = ? WHERE branch_id = ?', [savedCanView, branchId]).catch(() => {});
  }
  await db.pool.end().catch(() => {});
});

test.describe('고객용 사진 모아보기', () => {
  test.describe.configure({ timeout: 90000 });

  test('번호와 계기판 표시가 붙어 사진이 나온다', async ({ page }) => {
    await page.goto(`${BASE_URL}/photos/${token}`, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('.group-title')).toContainText('운행 전 · 13장');
    await expect(page.locator('.cell')).toHaveCount(13);
    // 13번만 계기판으로 표시된다 — 이 번호가 틀리면 고객이 엉뚱한 사진을 계기판으로 본다.
    await expect(page.locator('.cap.odo')).toHaveCount(1);
    await expect(page.locator('.cap.odo')).toContainText('13 계기판');
    // 원본은 새 탭으로 열되 opener를 넘기지 않는다(외부 링크).
    await expect(page.locator('.cell').first()).toHaveAttribute('rel', /noopener/);
  });

  test('잘못된 토큰은 404다', async ({ page }) => {
    // 형식이 아예 다른 것과, 형식은 맞지만 없는 것 둘 다 막혀야 한다.
    for (const bad of ['nope', '00000000-0000-0000-0000-000000000000']) {
      const res = await page.goto(`${BASE_URL}/photos/${bad}`, { waitUntil: 'domcontentloaded' });
      expect(res.status()).toBe(404);
    }
  });

  test('지사가 열람을 막으면 링크를 알아도 볼 수 없다', async ({ page }) => {
    await db.run('UPDATE branch_photo_settings SET client_can_view = 0 WHERE branch_id = ?', [branchId]);
    try {
      const res = await page.goto(`${BASE_URL}/photos/${token}`, { waitUntil: 'domcontentloaded' });
      expect(res.status()).toBe(403);
      await expect(page.locator('.empty')).toContainText('공개되어 있지 않습니다');
      // 막힌 화면에는 사진이 한 장도 없어야 한다.
      await expect(page.locator('.cell')).toHaveCount(0);
    } finally {
      await db.run('UPDATE branch_photo_settings SET client_can_view = 1 WHERE branch_id = ?', [branchId]);
    }
  });
});
