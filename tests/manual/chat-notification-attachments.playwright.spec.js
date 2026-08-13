// 능동 통보에 딸린 사진이 상담원 화면에도 보이는지 확인한다.
//
// 왜 필요한가: 고객 화면(챗봇 위젯)에는 썸네일+링크로 나가는데 상담원 화면에서만 안 보이면,
// 상담원은 "무엇이 이미 고객에게 안내됐는지"를 알 수 없다. 실제로 이 렌더링을 고객 위젯에만
// 넣고 상담원 화면 두 곳(EJS/Next)을 빠뜨린 적이 있어 여기서 못박는다.
//
// 링크는 콜마너 CDN을 가리키고 만료될 수 있다 — 썸네일이 깨져도 캡션 글자와 링크는 남아야
// 한다. 이 테스트가 쓰는 URL도 실제로 열리지 않으므로 그 폴백까지 함께 확인된다.
const { test, expect } = require('@playwright/test');
const db = require('../../db');
const { loginWithRetry } = require('./helpers/auth');

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const LOGIN_ID = process.env.E2E_LOGIN_ID || 'admin';
const PASSWORD = process.env.E2E_PASSWORD || 'Admin!2345';

const MARK = 'e2e-attach-check';
const PHOTO_URL = 'https://web-api-pic-vault.callmaner.com/image/e2e-attach-check_1_13.jpg';

let sessionId = null;
let supported = false;

test.beforeAll(async () => {
  const col = await db.get(
    "SELECT 1 AS ok FROM information_schema.columns WHERE table_name = 'chat_messages' AND column_name = 'attachments_json'"
  ).catch(() => null);
  supported = !!col;
  if (!supported) return;

  const s = await db.get(
    `INSERT INTO chat_sessions (user_id, status, channel) VALUES (NULL, 'bot', 'web') RETURNING id`
  );
  sessionId = Number(s.id);
  await db.run(
    `INSERT INTO chat_messages (session_id, sender, message, attachments_json) VALUES (?, 'system', ?, ?)`,
    [
      sessionId,
      `${MARK} 요청하신 탁송건이 운행완료 되었습니다.`,
      JSON.stringify([{ url: PHOTO_URL, caption: '운행후 13' }]),
    ]
  );
});

test.afterAll(async () => {
  if (sessionId) {
    await db.run('DELETE FROM chat_messages WHERE session_id = ?', [sessionId]).catch(() => {});
    await db.run('DELETE FROM chat_sessions WHERE id = ?', [sessionId]).catch(() => {});
  }
  await db.pool.end().catch(() => {});
});

test.describe('상담원 화면 · 통보 사진 첨부', () => {
  test.describe.configure({ timeout: 90000 });

  test('통보에 딸린 사진이 썸네일+링크로 보인다', async ({ page }) => {
    test.skip(!supported, 'attachments_json 컬럼이 아직 없습니다');

    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    await page.goto(`${BASE_URL}/chat/sessions/${sessionId}`, { waitUntil: 'domcontentloaded' });

    const bubble = page.locator('.ai-chat-bubble', { hasText: MARK });
    await expect(bubble).toBeVisible();

    const link = bubble.locator('.ai-chat-attachment');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', PHOTO_URL);
    // 새 탭으로 열되 opener를 넘기지 않는다(외부 링크).
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    // 썸네일이 깨져도 캡션은 남아야 한다 — 이 URL은 실제로 열리지 않는다.
    await expect(link).toContainText('운행후 13');
  });
});
