// 목적: 경로/요금 안내가 접수 확인을 막지 않는지, 그리고 법인 토글로 끌 수 있는지 확인한다.
//
// 왜 필요한가: 예전에는 announceFareGuideFromDb()(최대 20초 대기)가 끝나야 접수 확인 말풍선이
// 나갔다. 실사용 지적 — 안 쓰는 법인 때문에 결과를 기다릴 이유가 없고, 쓰더라도 사용자가 입력한
// 주문서 확인이 먼저 나와야 한다. 순서가 다시 뒤집히면 여기서 잡힌다.
//
// 외부 의존(Gemini 파싱·카카오 주소검색·요금표)은 모킹한다. 검증 대상은 말풍선의 순서다.
const { test, expect } = require('@playwright/test');
const { openAiIntakeWithRetry } = require('./helpers/auth');

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const LOGIN_ID = process.env.E2E_LOGIN_ID || 'admin';
const PASSWORD = process.env.E2E_PASSWORD || 'Admin!2345';

// 요금 조회가 느린 상황을 만든다 — 이 지연이 접수 확인을 막으면 안 된다.
const FARE_DELAY_MS = 4000;

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

async function setupMocks(page, { routeEnabled = true, fareEnabled = true } = {}) {
  await page.addInitScript(({ route, fare }) => {
    // ai_intake.ejs의 인라인 스크립트가 서버 값으로 이 전역을 덮어쓰므로, 단순 대입으로는
    // 테스트 값이 살아남지 않는다 — getter로 고정한다(아래 __aiIntakeRouteFinal과 같은 방식).
    Object.defineProperty(window, '__routeSearchEnabled', {
      get: () => route, set: () => {}, configurable: true,
    });
    Object.defineProperty(window, '__fareSearchEnabled', {
      get: () => fare, set: () => {}, configurable: true,
    });
    window.__aiIntakeResolveAddress = function (mainId) {
      const input = document.getElementById(mainId);
      if (!input) return Promise.resolve({ success: false, resolvedText: null });
      return Promise.resolve({ success: true, resolvedText: String(input.value || '') });
    };
    // 지도 SDK가 없는 환경이라 거리를 고정한다(ai-intake-confirm 테스트와 같은 방식).
    const FIXED_DISTANCE = '32.5 km';
    Object.defineProperty(window, '__aiIntakeRouteFinal', {
      get: () => true, set: () => {}, configurable: true,
    });
    document.addEventListener('DOMContentLoaded', () => {
      const pin = () => {
        const el = document.getElementById('routeTotalDistance');
        if (el && el.textContent !== FIXED_DISTANCE) el.textContent = FIXED_DISTANCE;
      };
      pin();
      new MutationObserver(pin).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
  }, { route: routeEnabled, fare: fareEnabled });

  await page.route('**/orders/ai-intake/parse', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FULL_PARSE) });
  });

  await page.route('**/kakao/search**', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') || '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ documents: [{ type: 'place', place_name: q, road_address: q, jibun_address: null, lat: '37.5', lon: '127.0' }] }),
    });
  });

  await page.route('**/orders/fare-preview**', async (route) => {
    await new Promise((r) => setTimeout(r, FARE_DELAY_MS));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabled: true, baseFare: 90000, ferryFare: 0, totalFare: 90000 }),
    });
  });
}

async function sendMessage(page, text) {
  const chatInput = page.locator('#aiIntakeText');
  const sendBtn = page.locator('#aiSendBtn');
  await chatInput.fill(text);
  await expect(sendBtn).toBeEnabled();
  await sendBtn.click();
}

// 화면에 그려진 봇 말풍선 텍스트를 순서대로 읽는다(순서 자체가 검증 대상이라 배열로 본다).
async function botTexts(page) {
  return page.locator('.ai-chat-bubble.ai-bot').allTextContents();
}

test.describe('AI intake 경로/요금 안내 순서', () => {
  test.describe.configure({ timeout: 90000 });

  test('요금 조회가 느려도 접수 확인이 먼저 나가고, 진행중 안내 뒤에 요금이 따라온다', async ({ page }) => {
    await setupMocks(page, { routeEnabled: true, fareEnabled: true });
    await openAiIntakeWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });

    await sendMessage(page, '내일 오후 2시 서울 강서구 양천로53길 30에서 경기 성남시 분당구 판교역로 160으로 토레스 12가3456 탁송 부탁드립니다');

    // 요금 응답(4초)을 기다리지 않고, 그 전에 접수 확인/다음 안내가 이미 떠 있어야 한다.
    await expect.poll(async () => (await botTexts(page)).length, { timeout: 3000 }).toBeGreaterThan(0);
    expect((await botTexts(page)).some((t) => /90,000/.test(t))).toBe(false);

    // 1.5초 넘게 걸리면 진행중 안내가 뜬다 — 요금 응답(4초)보다 먼저여야 한다.
    await expect
      .poll(async () => (await botTexts(page)).some((t) => /경로탐색중|요금검색중/.test(t)), { timeout: 3500 })
      .toBe(true);
    expect((await botTexts(page)).some((t) => /90,000/.test(t))).toBe(false);

    // 요금 결과는 그 뒤에 따라온다.
    await expect.poll(async () => (await botTexts(page)).some((t) => /90,000/.test(t)), { timeout: 15000 }).toBe(true);

    const all = await botTexts(page);
    const noticeIdx = all.findIndex((t) => /경로탐색중|요금검색중/.test(t));
    const fareIdx = all.findIndex((t) => /90,000/.test(t));
    expect(noticeIdx).toBeLessThan(fareIdx);
  });

  test('둘 다 꺼져 있으면 요금 조회 자체를 하지 않는다', async ({ page }) => {
    await setupMocks(page, { routeEnabled: false, fareEnabled: false });

    let farePreviewCalls = 0;
    page.on('request', (req) => {
      if (req.url().includes('/orders/fare-preview')) farePreviewCalls += 1;
    });

    await openAiIntakeWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    await sendMessage(page, '내일 오후 2시 서울 강서구 양천로53길 30에서 경기 성남시 분당구 판교역로 160으로 토레스 12가3456 탁송 부탁드립니다');

    await expect.poll(async () => (await botTexts(page)).length, { timeout: 5000 }).toBeGreaterThan(0);
    await page.waitForTimeout(FARE_DELAY_MS + 1000);

    const all = await botTexts(page);
    expect(all.some((t) => /경로탐색중|요금검색중|예상요금|구간요금/.test(t))).toBe(false);
    expect(farePreviewCalls).toBe(0);
  });
  test('요금검색만 끄면 요금 안내가 사라진다(경로탐색은 그대로)', async ({ page }) => {
    await setupMocks(page, { routeEnabled: true, fareEnabled: false });

    let farePreviewCalls = 0;
    page.on('request', (req) => {
      if (req.url().includes('/orders/fare-preview')) farePreviewCalls += 1;
    });

    await openAiIntakeWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    await sendMessage(page, '내일 오후 2시 서울 강서구 양천로53길 30에서 경기 성남시 분당구 판교역로 160으로 토레스 12가3456 탁송 부탁드립니다');

    await expect.poll(async () => (await botTexts(page)).length, { timeout: 5000 }).toBeGreaterThan(0);
    await page.waitForTimeout(FARE_DELAY_MS + 1000);

    const all = await botTexts(page);
    expect(all.some((t) => /90,000|예상요금|구간요금/.test(t))).toBe(false);
    expect(farePreviewCalls).toBe(0);
  });

  test('경로탐색만 끄면 요금은 안내하되 거리·소요시간을 빼고 말한다', async ({ page }) => {
    await setupMocks(page, { routeEnabled: false, fareEnabled: true });
    await openAiIntakeWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    await sendMessage(page, '내일 오후 2시 서울 강서구 양천로53길 30에서 경기 성남시 분당구 판교역로 160으로 토레스 12가3456 탁송 부탁드립니다');

    await expect.poll(async () => (await botTexts(page)).some((t) => /90,000/.test(t)), { timeout: 20000 }).toBe(true);

    const fareText = (await botTexts(page)).find((t) => /90,000/.test(t)) || '';
    expect(fareText).not.toMatch(/거리 /);
    expect(fareText).not.toMatch(/예상소요시간/);
  });
});
