// 목적: AI 접수의 마지막 관문인 "확인 단계"를 덮는다 — 요약 말풍선 → 등록 확인 질문 → 응답 처리.
//
// 왜 필요한가: 접수 요약을 만드는 코드가 브라우저와 서버 두 곳에 있고(lib/intakeSummary.js와
// public/js/ai-intake.js), 브라우저 쪽을 서버 호출로 바꾸려면 "요약 → 확인 질문" 말풍선의
// 순서와 내용이 그대로인지 확인할 수단이 있어야 한다. 지금은 그 구간을 덮는 자동 테스트가
// 없어서 손으로 눌러보는 수밖에 없다. 전환 전에 이 테스트를 먼저 둔다.
//
// 전환과 무관하게도 필요하다 — 여기서 잘못되면 고객이 확인한 내용과 실제 등록 내용이 달라진다.
//
// 외부 의존(Gemini 파싱·카카오 주소검색)은 모킹한다. 검증 대상은 "화면이 무엇을 언제 보여주는가"다.
const { test, expect } = require('@playwright/test');
const { loginWithRetry, openAiIntakeWithRetry } = require('./helpers/auth');

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const LOGIN_ID = process.env.E2E_LOGIN_ID || 'admin';
const PASSWORD = process.env.E2E_PASSWORD || 'Admin!2345';

// 한 번에 모든 필드가 채워지는 발화 — 확인 단계까지 최단 경로로 간다.
const FULL_PARSE = {
  intent: 'dispatch_order',
  reserved_date: '2026-08-20',
  reserved_time: '14:00',
  origin_address: '서울 강서구 양천로53길 30',
  origin_contact: '010-1111-2222',
  origin_vehicle_number: '12가3456',
  vehicle_type: '토레스',
  waypoints: [],
  destination_address: '경기 성남시 분당구 판교역로 160',
  destination_contact: '010-3333-4444',
  memo_customer: null,
};

function placeResult(placeName, roadAddress, lat, lon) {
  return { type: 'place', place_name: placeName, road_address: roadAddress, jibun_address: null, lat: String(lat), lon: String(lon) };
}

async function setupMocks(page) {
  // 주소 확정은 이 테스트의 관심사가 아니다 — 후보 하나로 바로 확정되게 해서 확인 단계까지 보낸다.
  await page.addInitScript(() => {
    window.__aiIntakeResolveAddress = function (mainId) {
      const input = document.getElementById(mainId);
      if (!input) return Promise.resolve({ success: false, resolvedText: null });
      return Promise.resolve({ success: true, resolvedText: String(input.value || '') });
    };
  });

  await page.route('**/orders/ai-intake/parse', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FULL_PARSE) });
  });

  await page.route('**/kakao/search**', async (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get('q') || '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ documents: [placeResult(q, q, 37.5, 127.0)] }),
    });
  });

  // 확인 단계에서 "네"를 자연어로 분류하는 경로 — 로컬 판정이 먼저 걸리면 호출되지 않는다.
  await page.route('**/orders/ai-intake/classify-reply', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ action: 'yes' }) });
  });
}

async function login(page) {
  await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
}

async function openAiIntake(page) {
  await openAiIntakeWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
}

async function sendChat(page, text, options = {}) {
  const { waitForParse = true } = options;
  const chatInput = page.locator('#aiIntakeText');
  const sendBtn = page.locator('#aiSendBtn');
  const parseReq = waitForParse ? page.waitForRequest('**/orders/ai-intake/parse') : null;
  await chatInput.fill(text);
  await expect(sendBtn).toBeEnabled();
  await sendBtn.click();
  if (parseReq) await parseReq;
}

// 봇 말풍선 텍스트를 순서대로 — 순서 자체가 검증 대상이라 배열로 본다.
async function botBubbles(page) {
  return page.locator('.ai-chat-item.ai-bot .ai-chat-bubble').allTextContents();
}

async function waitForSummary(page) {
  await expect.poll(async () => (await botBubbles(page)).some((t) => t.includes('▪ 출발지:')), { timeout: 20000 }).toBe(true);
}

test.describe('AI intake 확인 단계', () => {
  test('요약 말풍선이 등록 확인 질문보다 먼저, 서로 다른 말풍선으로 나온다', async ({ page }) => {
    await setupMocks(page);
    await login(page);
    await openAiIntake(page);

    await sendChat(page, '8월 20일 2시 서울 강서구 양천로53길 30에서 판교역로 160까지 토레스 12가3456 탁송');
    await waitForSummary(page);

    const bubbles = await botBubbles(page);
    const summaryIdx = bubbles.findIndex((t) => t.includes('▪ 출발지:'));
    const confirmIdx = bubbles.findIndex((t) => t.includes('등록해 드릴까요'));

    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    expect(confirmIdx).toBeGreaterThanOrEqual(0);
    // 순서가 뒤집히면 고객이 무엇을 확인하는지 모른 채 "네"를 누르게 된다.
    expect(summaryIdx).toBeLessThan(confirmIdx);
    // 하나로 합쳐지면 질문 말풍선의 강조가 사라지고, 상담관리에서 다시 볼 때도 뭉쳐 보인다.
    expect(summaryIdx).not.toBe(confirmIdx);
  });

  test('요약에 수집한 항목이 빠짐없이 들어간다', async ({ page }) => {
    await setupMocks(page);
    await login(page);
    await openAiIntake(page);

    await sendChat(page, '8월 20일 2시 서울 강서구 양천로53길 30에서 판교역로 160까지 토레스 12가3456 탁송');
    await waitForSummary(page);

    const summary = (await botBubbles(page)).find((t) => t.includes('▪ 출발지:')) || '';

    // 서버 요약(lib/intakeSummary.js)과 같은 항목·같은 순서여야 한다.
    // 항목이 하나라도 빠지면 고객이 확인하지 못한 값으로 오더가 등록된다.
    expect(summary).toContain('▪ 예약:');
    expect(summary).toContain('2026-08-20');
    expect(summary).toContain('▪ 출발지:');
    expect(summary).toContain('010-1111-2222');
    expect(summary).toContain('▪ 차량번호:');
    expect(summary).toContain('12가3456');
    expect(summary).toContain('▪ 도착지:');
    expect(summary).toContain('010-3333-4444');

    // 순서 — 예약 → 출발지 → 차량 → 도착지. 서버 모듈의 buildSummaryLines와 같은 차례다.
    expect(summary.indexOf('▪ 예약:')).toBeLessThan(summary.indexOf('▪ 출발지:'));
    expect(summary.indexOf('▪ 출발지:')).toBeLessThan(summary.indexOf('▪ 차량번호:'));
    expect(summary.indexOf('▪ 차량번호:')).toBeLessThan(summary.indexOf('▪ 도착지:'));
  });

  test('확인 질문에 "수정"이라고 답하면 등록하지 않고 수정 흐름으로 간다', async ({ page }) => {
    await setupMocks(page);
    await login(page);
    await openAiIntake(page);

    await sendChat(page, '8월 20일 2시 서울 강서구 양천로53길 30에서 판교역로 160까지 토레스 12가3456 탁송');
    await waitForSummary(page);

    // 등록이 나가면 안 된다 — 오더 등록 요청을 감시한다.
    let orderSubmitted = false;
    await page.route('**/orders', async (route) => {
      if (route.request().method() === 'POST') orderSubmitted = true;
      await route.continue();
    });

    await sendChat(page, '수정', { waitForParse: false });

    await expect.poll(async () => (await botBubbles(page)).some((t) => /어느 부분을 수정/.test(t)), { timeout: 20000 }).toBe(true);
    expect(orderSubmitted).toBe(false);
  });
});
