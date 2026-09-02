// 법인 고객(client) 계정은 소속 법인 없이 만들 수 없다.
//
// 왜 필요한가: 법인이 빈 client 계정은 그 계정이 낸 오더를 requester_group_id 없이 저장하고
// (POST /orders가 세션의 group_id를 그대로 쓴다), 법인 정산은 그 값으로 모으므로 그 오더는
// 어느 정산서에도 오르지 않는다. 화면상 오더는 멀쩡해 보이고 청구만 조용히 빠진다.
// 실제로 그런 계정이 운영 DB에 있었다(2026-09-02 확인) — 오더를 한 건도 안 낸 덕에 사고가
// 안 났을 뿐이다.
//
// 이 스펙은 계정을 만들지 않는다. 만드는 쪽을 확인하려면 운영 DB에 실제 계정이 생기므로,
// "거부되는지"만 본다 — 막히는 것이 이 규칙의 전부이기도 하다.
const { test, expect } = require('@playwright/test');
const { loginWithRetry } = require('./helpers/auth');
// 계정·비밀번호는 한 곳에서 가져온다 — 값이 없으면 즉시 멈춘다(tests/e2e-credentials.js).
const { LOGIN_ID, PASSWORD } = require('../e2e-credentials');

// 화면은 Next(:3001), 검증은 Express(:3000)가 한다 — 폼이 POST하는 곳이 Express다.
const NEXT_BASE = process.env.E2E_NEXT_BASE_URL || 'http://localhost:3001';
const EXPRESS_BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';

test.describe('법인 고객 계정의 소속 법인 필수', () => {
  test.describe.configure({ timeout: 90000 });

  test('권한을 클라이언트로 고르면 소속 법인이 필수가 된다', async ({ page }) => {
    await loginWithRetry(page, { baseUrl: NEXT_BASE, loginId: LOGIN_ID, password: PASSWORD });
    await page.goto(`${NEXT_BASE}/users/new`, { waitUntil: 'domcontentloaded' });

    const roleSel = page.locator('select[name="role"]');
    const groupSel = page.locator('select[name="group_id"]');

    // 관리자·지사장에는 소속 법인이 없다 — 그 상태에서 required가 남아 있으면 숨은 칸 때문에
    // 저장이 조용히 막힌다(브라우저가 안 보이는 칸에 포커스를 못 준다).
    await roleSel.selectOption('admin');
    await expect(groupSel).not.toHaveAttribute('required', /.*/);

    await roleSel.selectOption('client');
    await expect(groupSel).toHaveAttribute('required', /.*/);
    // 고르지 않은 상태로는 폼이 유효하지 않다 — 브라우저가 여기서 먼저 막아준다.
    await expect(groupSel).toHaveValue('');
    expect(await groupSel.evaluate((el) => el.checkValidity())).toBe(false);
    await expect(page.getByText('소속 법인 *')).toBeVisible();
  });

  test('필수검사를 우회해 보내도 서버가 거부한다', async ({ page }) => {
    // 검증하는 쪽(Express)에 직접 로그인한다. Next(:3001)로 로그인하고 :3000으로 요청하면
    // 세션 쿠키가 다른 오리진이라 안 실려서, 거부(400)가 아니라 로그인 리다이렉트(302)를
    // 받는다 — 그걸 통과로 읽으면 검사가 아무것도 안 보게 된다.
    await loginWithRetry(page, { baseUrl: EXPRESS_BASE, loginId: LOGIN_ID, password: PASSWORD });

    // 세션이 실제로 실렸는지 먼저 확인한다(위 302 함정을 다시 만들지 않기 위함).
    const listed = await page.request.get(`${EXPRESS_BASE}/users/data.json`);
    expect(listed.ok(), '로그인 세션이 Express로 실려야 한다').toBe(true);

    // 화면의 required만으로는 부족하다 — 끄거나 요청을 직접 만들면 그대로 통과한다.
    const res = await page.request.post(`${EXPRESS_BASE}/users`, {
      form: { login_id: `zzq_group_guard_${Date.now()}`, name: 'zzq법인가드검사', role: 'client', group_id: '' },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain('소속 법인');

    // 0이나 숫자가 아닌 값도 "고르지 않음"과 같다 — 그대로 넣으면 정산이 못 찾는 값이 박힌다.
    for (const bad of ['0', 'abc', '-1']) {
      const r = await page.request.post(`${EXPRESS_BASE}/users`, {
        form: { login_id: `zzq_group_guard_${bad}_${Date.now()}`, name: 'zzq법인가드검사', role: 'client', group_id: bad },
        maxRedirects: 0,
      });
      expect(r.status(), `group_id=${bad}`).toBe(400);
    }

    // 권한을 나중에 client로 바꾸는 수정도 같이 막혀야 한다 — 등록만 막으면 "관리자로 만들고
    // 나중에 고객으로 바꾸기"로 그대로 새어 나간다. 존재하는 계정 id로 시도하되 법인을 비운다.
    const { users } = await listed.json();
    const target = users.find((u) => u.role === 'client');
    expect(target, '법인 고객 계정이 하나는 있어야 이 검사를 할 수 있다').toBeTruthy();
    const upd = await page.request.post(`${EXPRESS_BASE}/users/${target.id}`, {
      form: { name: target.name || 'x', role: 'client', group_id: '', status: target.status || 'active' },
      maxRedirects: 0,
    });
    expect(upd.status()).toBe(400);
    expect(await upd.text()).toContain('소속 법인');
  });
});
