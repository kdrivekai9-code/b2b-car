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

  // 계기판 표시가 붙는지 보려면 열세 장이 다 있어야 한다.
  //
  // 운행후도 함께 넣는다. 촬영 순서가 단계마다 달라(운행후는 계기판이 **1번**) 단계를 무시하고
  // 번호로 계기판을 가리면 고객이 바퀴 사진을 계기판으로 본다 — 실제로 그렇게 되어 있었다.
  for (const phase of ['start', 'end']) {
    for (let seq = 1; seq <= 13; seq += 1) {
      await db.run(
        `INSERT INTO order_callmaner_photos (order_id, phase, seq, url) VALUES (?, ?, ?, ?)`,
        [orderId, phase, seq, `https://example.invalid/${MARK}_${phase}_${seq}.jpg`]
      );
    }
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
  // 풀은 여기서 닫지 않는다 — workers: 1이라 같은 프로세스의 다음 스펙이 죽는다.
  // 전부 끝난 뒤 한 번 닫는 일은 tests/global-teardown.js가 맡는다.
});

test.describe('고객용 사진 모아보기', () => {
  test.describe.configure({ timeout: 90000 });

  test('항목 이름과 계기판 표시가 붙어 사진이 나온다', async ({ page }) => {
    await page.goto(`${BASE_URL}/photos/${token}`, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('.group-title').first()).toContainText('운행 전 · 13장');
    await expect(page.locator('.cell')).toHaveCount(26);

    // 번호가 아니라 **항목 이름**이 붙는다. 고객이 "3번"만 보고는 무엇을 찍은 것인지 모른다.
    const before = page.locator('.group').nth(0);
    const after = page.locator('.group').nth(1);
    await expect(before.locator('.cap').first()).toContainText('1. 전면');
    // 운행후는 계기판이 1번이라 이름이 한 칸씩 밀린다 — 여기서 번호로 이름을 붙이면 전부 어긋난다.
    await expect(after.locator('.cap').first()).toContainText('1. 계기판');
    await expect(after.locator('.cap').nth(1)).toContainText('2. 전면');

    // 계기판 표시는 단계마다 다른 자리에 붙는다: 운행전 13번, 운행후 1번.
    // 번호로 가리면 고객이 보조석 앞바퀴를 계기판으로 본다(실제로 그랬다).
    await expect(page.locator('.cap.odo')).toHaveCount(2);
    await expect(before.locator('.cap.odo')).toContainText('13. 계기판');
    await expect(after.locator('.cap.odo')).toContainText('1. 계기판');

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
