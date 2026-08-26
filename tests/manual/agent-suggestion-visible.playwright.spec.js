// 상담원 응대 중 만들어진 답변 초안이 상담원 화면에 실제로 뜨는지.
//
// 왜 필요한가: 초안 생성이 16일간 0건이었다가 오늘 되살아났다(동기 함수에 .catch를 붙여
// 매번 예외가 나던 것 — routes/kakaoConsult.js·routes/chat.js). 생성이 고쳐졌다고 상담원이
// 볼 수 있다는 뜻은 아니다 — 생성·조회·표시가 각각 다른 코드다. "채택 대기"가 화면에 뜨고
// 승인하면 고객에게 나가는 데까지가 이 기능의 값이다.
//
// 상담 상세는 프로덕션에서 Next가 그린다(NEXT_STAGE3_CHAT_DETAIL_ENABLED). 다만 next dev는
// StrictMode 때문에 이 화면에 메시지가 아예 안 뜨므로(2026-08-16 확인), 기본값은 Express로
// 두고 Next 확인은 prod 빌드로 돌린다.
const { test, expect } = require('@playwright/test');
const db = require('../../db');
const { loginWithRetry } = require('./helpers/auth');

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
// 계정·비밀번호는 한 곳에서 가져온다 — 값이 없으면 즉시 멈춘다(tests/e2e-credentials.js).
const { LOGIN_ID, PASSWORD } = require('../e2e-credentials');

const MARK = 'e2e-suggestion';
let sessionId = null;

test.beforeAll(async () => {
  const s = await db.get(
    `INSERT INTO chat_sessions (user_id, status, channel) VALUES (NULL, 'agent_active', 'kakao') RETURNING id`
  );
  sessionId = Number(s.id);
  const m = await db.get(
    `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'user', ?) RETURNING id`,
    [sessionId, `${MARK} 방금 탁송예약했는데 접수확인좀`]
  );
  // 실제 생성 경로가 만드는 것과 같은 모양으로 넣는다(kind/status).
  await db.run(
    `INSERT INTO chat_suggestions (session_id, user_message_id, kind, suggested_text, status)
     VALUES (?, ?, 'faq', ?, 'pending')`,
    [sessionId, m.id, `${MARK} 접수번호로 언제든 상태를 조회하실 수 있습니다.`]
  );
});

test.afterAll(async () => {
  if (sessionId) {
    await db.run('DELETE FROM chat_suggestions WHERE session_id = ?', [sessionId]).catch(() => {});
    await db.run('DELETE FROM chat_messages WHERE session_id = ?', [sessionId]).catch(() => {});
    await db.run('DELETE FROM chat_sessions WHERE id = ?', [sessionId]).catch(() => {});
  }
  await db.pool.end().catch(() => {});
});

test.describe('상담원 화면 · 답변 초안', () => {
  test.describe.configure({ timeout: 120000 });

  test('대기 중인 초안이 조회된다', async ({ page }) => {
    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });

    // 화면이 초안을 가져오는 그 경로를 그대로 부른다 — 여기서 null이면 화면에도 안 뜬다.
    const data = await page.evaluate(async (id) => {
      const r = await fetch(`/chat/sessions/${id}/suggestion`, { headers: { 'X-Requested-With': 'fetch' } });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, sessionId);

    expect(data.status).toBe(200);
    expect(data.body && data.body.suggestion, '초안이 조회되지 않으면 상담원은 존재 자체를 모른다').toBeTruthy();
    expect(data.body.suggestion.text).toContain('접수번호로 언제든');
    expect(data.body.suggestion.kind).toBe('faq');
  });

  test('상담 상세 화면에 초안이 보인다', async ({ page }) => {
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));

    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    const res = await page.goto(`${BASE_URL}/chat/sessions/${sessionId}`, { waitUntil: 'domcontentloaded' });
    expect(res.status()).toBe(200);

    // "채택 대기" 딱지가 떠야 상담원이 초안의 존재를 안다.
    await expect(page.getByText('채택 대기', { exact: false }).first()).toBeVisible({ timeout: 20000 });

    // 초안 본문은 수정 가능한 textarea의 "값"으로 들어간다 — getByText로는 안 잡힌다
    // (처음에 그렇게 썼다가 "화면에 안 뜬다"고 잘못 읽었다). 값으로 확인한다.
    const draft = page.getByLabel('AI 답변 초안 (수정 가능)');
    await expect(draft).toBeVisible();
    await expect(draft).toHaveValue(/접수번호로 언제든/);

    // 상담원이 판단할 수 있어야 기능이 완결된다 — 채택/버림 버튼이 함께 있어야 한다.
    await expect(page.getByRole('button', { name: /채택|보내기|승인/ }).first()).toBeVisible();

    expect(problems, `페이지 오류: ${problems.join(' | ')}`).toEqual([]);
  });
});
