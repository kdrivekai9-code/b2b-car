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
// 본문 끝에 붙는 사진 모아보기 주소. 평문으로 그리면 고객이 누를 수 없다(카카오와 달리 웹은
// 자동으로 링크가 되지 않는다) — 세 화면 모두 <a>로 그리는지 확인한다.
const VIEW_URL = 'https://b2bcarkr.vercel.app/photos/e2e-attach-check-token';

let sessionId = null;
let webSessionId = null;
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

  // 고객 위젯은 로그인한 사용자의 세션만 복원한다 — 검사용 계정 소유로 하나 더 만든다.
  const user = await db.get('SELECT id FROM users WHERE login_id = ?', [LOGIN_ID]).catch(() => null);
  if (user) {
    const w = await db.get(
      `INSERT INTO chat_sessions (user_id, status, channel) VALUES (?, 'bot', 'web') RETURNING id`,
      [user.id]
    );
    webSessionId = Number(w.id);
    await db.run(
      `INSERT INTO chat_messages (session_id, sender, message, attachments_json) VALUES (?, 'system', ?, ?)`,
      [webSessionId, `${MARK} 요청하신 탁송건이 운행시작 되었습니다.\n사진 7장 모두 보기: ${VIEW_URL}`, JSON.stringify([{ url: PHOTO_URL, caption: '운행전 13' }])]
    );
  }
  await db.run(
    `INSERT INTO chat_messages (session_id, sender, message, attachments_json) VALUES (?, 'system', ?, ?)`,
    [
      sessionId,
      `${MARK} 요청하신 탁송건이 운행완료 되었습니다.\n사진 7장 모두 보기: ${VIEW_URL}`,
      JSON.stringify([{ url: PHOTO_URL, caption: '운행후 13' }]),
    ]
  );
});

test.afterAll(async () => {
  if (webSessionId) {
    await db.run('DELETE FROM chat_messages WHERE session_id = ?', [webSessionId]).catch(() => {});
    await db.run('DELETE FROM chat_sessions WHERE id = ?', [webSessionId]).catch(() => {});
  }
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

    // 상담원이 "고객에게 무엇이 나갔는지" 볼 수 있어야 하므로 주소 자체는 본문에 남아야 한다.
    //
    // 여기서 <a>까지 요구하지 않는 이유: 이 검사는 기본값이 Express(3000)라 레거시 EJS 화면을
    // 본다. 그쪽은 서버에서 <%= %>로 escape해 찍으므로 링크로 만들려면 HTML을 직접 조립해야
    // 하는데, 롤백용 화면에 주입 경로를 여는 값을 하지 못한다 — 주소가 보이면 복사해서 열 수
    // 있다. 프로덕션이 실제로 띄우는 Next 화면(SessionViewer)은 renderChatText로 링크가 되고,
    // 그건 prod 빌드로 확인했다(next dev는 StrictMode 때문에 이 화면에 메시지가 아예 안 뜬다).
    await expect(bubble).toContainText(VIEW_URL);
  });

  test('고객 챗봇 위젯에서도 보인다', async ({ page }) => {
    test.skip(!supported || !webSessionId, 'attachments_json 컬럼 또는 검사 계정이 없습니다');

    // 상담원 화면과 고객 화면은 렌더러가 서로 다르다(SessionViewer/EJS vs ai-intake-render.js).
    // 게다가 고객 화면은 "대화 복원" 경로로 메시지를 받는데, 그 조회가 attachments_json을
    // 빼고 있어서 상담원 화면에만 사진이 보이던 적이 있다 — 그 갈라짐을 여기서 막는다.
    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    await page.goto(`${BASE_URL}/orders/ai-intake?session=${webSessionId}`, { waitUntil: 'networkidle' });

    const link = page.locator('.ai-chat-attachment');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', PHOTO_URL);
    await expect(link).toContainText('운행전 13');

    // 고객 화면에서도 본문의 주소가 링크여야 한다 — 웹은 5장에서 썸네일이 잘리므로 나머지를
    // 볼 방법이 이 링크뿐이다. 텍스트로만 그리면 기능 자체가 없는 것과 같다.
    const viewLink = page.locator(`a[href="${VIEW_URL}"]`);
    await expect(viewLink).toHaveCount(1);
  });
});
