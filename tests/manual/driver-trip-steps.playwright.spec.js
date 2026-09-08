// 기사 화면 운행 단계 버튼 — 휴대폰 폭에서 순서대로 눌러본다.
//
// 왜 필요한가: 이 화면은 기사에게 유일한 통로다. 버튼 줄이 안 보이거나(입력창에 가려짐),
// 눌러야 할 것이 화면 밖에 있으면 기사는 아무것도 못 하고 전화를 건다 — 이 기능이 없애려던
// 바로 그 전화다. 경유지 개수만큼 사슬이 길어지므로 가로 넘침이 실제 위험이다.
//
// 서버 판정(순서·중복·대기시간)은 scripts/check-driver-trip-steps.js가 본다. 여기서는
// **화면에서 실제로 눌리는지**만 본다.
const { test, expect } = require('@playwright/test');
const db = require('../../db');
const driverToken = require('../../lib/driverToken');

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const SABUN = 'zzq단계스펙';

test.describe.configure({ mode: 'serial', timeout: 120000 });

test.describe('기사 화면 운행 단계', () => {
  let page;
  let orderId = null;

  test.beforeAll(async ({ browser }) => {
    const donor = await db.get(`SELECT branch_id, requester_group_id, created_by FROM orders
                                 WHERE branch_id IS NOT NULL ORDER BY id DESC LIMIT 1`);
    const made = await db.get(
      `INSERT INTO orders (oid, branch_id, requester_group_id, status, reserved_date, reserved_time,
         origin_address, destination_address, fare_amount, created_by, callmaner_driver_sabun, memo_customer)
       VALUES ('zzq단계스펙', ?, ?, '기사배정', '2026-09-08', '10:00', '검사로 출발지', '검사로 도착지', 0, ?, ?, '검사로')
       RETURNING id`,
      [donor.branch_id, donor.requester_group_id, donor.created_by, SABUN]);
    orderId = made.id;
    // 경유지 둘 — 번호(경유지1/경유지2)가 붙는지까지 보려면 하나로는 안 된다.
    await db.run(`INSERT INTO order_waypoints (order_id, seq, address)
                  VALUES (?, 1, '검사로 경유지1'), (?, 2, '검사로 경유지2')`, [orderId, orderId]);

    // 아이폰 SE 폭. 기사 화면에서 가장 좁은 실기다 — 여기서 가려지면 어디서든 가려진다.
    page = await browser.newPage({ viewport: { width: 375, height: 667 } });
    const token = driverToken.sign({ sabun: SABUN, name: '검사기사' }, 900);
    await page.goto(`${BASE}/driver/enter?t=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' });
  });

  test.afterAll(async () => {
    if (page) await page.close();
    if (orderId) {
      await db.run(`DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE order_id = ?)`, [orderId]).catch(() => {});
      await db.run('DELETE FROM chat_sessions WHERE order_id = ?', [orderId]).catch(() => {});
      await db.run('DELETE FROM order_trip_steps WHERE order_id = ?', [orderId]).catch(() => {});
      await db.run('DELETE FROM order_waypoints WHERE order_id = ?', [orderId]).catch(() => {});
      await db.run('DELETE FROM order_status_history WHERE order_id = ?', [orderId]).catch(() => {});
      await db.run('DELETE FROM orders WHERE id = ?', [orderId]).catch(() => {});
      await db.run('DELETE FROM drivers WHERE callmaner_sabun = ?', [SABUN]).catch(() => {});
    }
    // 풀은 tests/global-teardown.js가 전부 끝난 뒤 한 번 닫는다.
  });

  test('경유지 개수만큼 사슬이 미리 깔리고, 누를 수 있는 것은 하나뿐이다', async () => {
    await page.goto(`${BASE}/driver/chat?order=${orderId}`, { waitUntil: 'domcontentloaded' });
    const steps = page.locator('#triprail .step');
    // 출발지도착 → 운행시작 → (경유지1 대기 → 운행시작) → (경유지2 대기 → 운행시작) → 운행완료
    await expect(steps).toHaveCount(7);
    await expect(steps.nth(0)).toContainText('출발지 도착');
    await expect(steps.nth(2)).toContainText('경유지1 대기');
    await expect(steps.nth(4)).toContainText('경유지2 대기');
    await expect(steps.nth(6)).toContainText('운행 완료');
    // 단계 사이에 이동 화살표가 있어야 순서로 읽힌다.
    await expect(page.locator('#triprail .arrow2')).toHaveCount(6);

    // 활성은 첫 단계 하나. 나머지는 눌러도 안 된다(비활성)는 것이 보여야 잘못 누르지 않는다.
    await expect(page.locator('#triprail .step.now')).toHaveCount(1);
    await expect(steps.nth(0)).toBeEnabled();
    await expect(steps.nth(1)).toBeDisabled();
    await expect(steps.nth(6)).toBeDisabled();

    // 입력창에 가려지지 않아야 한다 — 버튼 줄이 입력창 위에 있고 화면 안에 들어와야 한다.
    const rail = await page.locator('#trip').boundingBox();
    const form = await page.locator('form#send').boundingBox();
    expect(rail.y + rail.height).toBeLessThanOrEqual(form.y + 1);
    expect(rail.y + rail.height).toBeLessThanOrEqual(667);
    // 장갑 낀 손으로 누른다 — 탭 목표가 44px 아래로 내려가면 안 된다.
    const box = await steps.nth(0).boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test('순서대로 누르면 시각이 남고, 대기 중에는 분이 보인다', async () => {
    const steps = page.locator('#triprail .step');
    await steps.nth(0).click();                       // 출발지 도착
    await expect(steps.nth(0)).toHaveClass(/done/);
    // 누른 시각(HH:MM)이 버튼에 남아야 기사가 자기가 눌렀는지 확인할 수 있다.
    await expect(steps.nth(0)).toContainText(/\d{2}:\d{2}/);
    await expect(steps.nth(1)).toBeEnabled();

    await steps.nth(1).click();                       // 운행 시작
    await expect(steps.nth(2)).toBeEnabled();
    await steps.nth(2).click();                       // 경유지1 대기

    // 대기 중이면 재출발 버튼 앞에 지금까지의 대기 분이 보인다.
    await expect(page.locator('#waitnow')).toBeVisible();
    await expect(page.locator('#waitnow')).toContainText('대기');

    // 기다린 것처럼 시각을 뒤로 돌리고 다시 읽으면 그 분이 반영된다.
    await db.run(`UPDATE order_trip_steps
                     SET occurred_at = to_char((now() at time zone 'Asia/Seoul') - interval '23 minutes', 'YYYY-MM-DD HH24:MI:SS')
                   WHERE order_id = ? AND step_key = 'waypoint_wait' AND seq = 1`, [orderId]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#waitnow')).toContainText('대기 23분');

    await page.locator('#triprail .step').nth(3).click();  // 경유지1에서 운행 시작
    // 기록된 대기시간이 버튼에 남는다.
    await expect(page.locator('#triprail .step').nth(3)).toContainText('23분');
    const saved = await db.get(
      `SELECT wait_minutes FROM order_trip_steps WHERE order_id = ? AND step_key = 'waypoint_resume' AND seq = 1`,
      [orderId]);
    expect(Number(saved.wait_minutes)).toBe(23);
  });

  test('운행 완료는 한 번 묻고, 끝나면 더 누를 것이 없다', async () => {
    const steps = page.locator('#triprail .step');
    await steps.nth(4).click();   // 경유지2 대기
    await steps.nth(5).click();   // 운행 시작
    await expect(steps.nth(6)).toBeEnabled();

    // 되돌릴 수 없는 단계라 확인을 받는다. 취소하면 기록되지 않아야 한다.
    page.once('dialog', (d) => d.dismiss());
    await steps.nth(6).click();
    await expect(steps.nth(6)).not.toHaveClass(/done/);

    page.once('dialog', (d) => d.accept());
    await steps.nth(6).click();
    await expect(steps.nth(6)).toHaveClass(/done/);
    await expect(page.locator('#triprail .step.now')).toHaveCount(0);

    // 대화에도 남아야 한다 — 상담원은 이 화면을 못 보고 대화만 본다.
    const lines = await db.all(
      `SELECT m.message FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
        WHERE s.order_id = ? AND m.message LIKE '[운행]%' ORDER BY m.id`, [orderId]);
    expect(lines.length).toBe(7);
    expect(lines[3].message).toContain('대기 23분');
  });
});
