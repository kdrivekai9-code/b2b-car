// 목적: 경로/요금 안내가 접수 요약을 막지 않으면서도, "위 내용으로 등록해 드릴까요?"가 항상
// 마지막 말풍선으로 남는지 확인한다. 그리고 법인 토글로 요금/경로를 끌 수 있는지도 본다.
//
// 왜 필요한가: 예전에는 announceFareGuideFromDb()(최대 20초 대기)가 끝나야 접수 확인 말풍선이
// 나갔다. 실사용 지적으로 요약을 먼저 내보내게 바꿨더니, 이번에는 요금 안내가 등록 확인 질문
// **아래**로 붙어서 대화의 마지막 줄이 질문이 아니게 됐다("등록확인 질문 다음에 경로/예상요금이
// 나온다"). 지금 규칙은 둘 다 지킨다 — 요약은 곧바로, 질문은 요금을 잠깐(CONFIRM_FARE_WAIT_MS)
// 기다렸다가 맨 뒤에. 그 한도를 넘겨 늦게 온 요금은 이미 뜬 질문 **위로** 끼워 넣는다.
//
// 진행중 안내("경로탐색중......")도 함께 본다 — 결과가 나온 뒤에도 남아 있어서 다 끝났는데
// 아직 찾고 있는 것처럼 보인다는 지적이 있었다. 이제 결과가 그 자리를 대신한다.
//
// 외부 의존(Gemini 파싱·카카오 주소검색·요금표)은 모킹한다. 검증 대상은 말풍선의 순서다.
const { test, expect } = require('@playwright/test');
const { openAiIntakeWithRetry } = require('./helpers/auth');

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
// 계정·비밀번호는 한 곳에서 가져온다 — 값이 없으면 즉시 멈춘다(tests/e2e-credentials.js).
const { LOGIN_ID, PASSWORD } = require('../e2e-credentials');

// 요금 조회가 느린 상황을 만든다 — 이 지연이 접수 요약을 막으면 안 된다.
const FARE_DELAY_MS = 4000;
// 확인 질문이 요금을 기다려주는 한도(ai-intake.js CONFIRM_FARE_WAIT_MS)를 넘기는 지연.
const FARE_DELAY_OVER_WAIT_MS = 9000;

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

async function setupMocks(page, { routeEnabled = true, fareEnabled = true, fareDelayMs = FARE_DELAY_MS } = {}) {
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
    await new Promise((r) => setTimeout(r, fareDelayMs));
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

// 필드가 다 채워져도 봇은 "추가 요청사항이 있으시면 알려주세요"를 한 번 묻고 기다린다 —
// 여기에 답해야 요약·등록 확인 질문으로 넘어간다(ai-intake-confirm 테스트와 같은 관문).
async function answerExtraRequest(page) {
  await expect
    .poll(async () => (await botTexts(page)).some((t) => /추가 요청사항|등록해 드릴까요/.test(t)), { timeout: 30000 })
    .toBe(true);
  if ((await botTexts(page)).some((t) => t.includes('등록해 드릴까요'))) return;
  await sendMessage(page, '없음');
}

test.describe('AI intake 경로/요금 안내 순서', () => {
  test.describe.configure({ timeout: 90000 });

  test('요금 조회가 느려도 접수 요약이 먼저 나가고, 진행중 안내 뒤에 요금이 따라온다', async ({ page }) => {
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

    // 그리고 진행중 안내는 사라진다 — 결과 바로 위에 "요금검색중......"이 남아 있으면 다
    // 끝났는데도 아직 찾고 있는 것처럼 보인다(실사용 지적).
    const all = await botTexts(page);
    expect(all.some((t) => /경로탐색중|요금검색중/.test(t))).toBe(false);
    expect(all.some((t) => /90,000/.test(t))).toBe(true);
  });

  // 대기 한도(6초) 안에 요금이 오는 흔한 경우 — 질문이 요금 뒤에, 그리고 맨 마지막에 온다.
  // 화면 순서뿐 아니라 저장 순서도 이래야 새로고침·상담관리 이력에서 같은 순서로 보인다.
  test('요금이 제때 오면 등록 확인 질문이 그 뒤 맨 마지막에 나온다', async ({ page }) => {
    await setupMocks(page, { routeEnabled: true, fareEnabled: true });
    await openAiIntakeWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });

    await sendMessage(page, '내일 오후 2시 서울 강서구 양천로53길 30에서 경기 성남시 분당구 판교역로 160으로 토레스 12가3456 탁송 부탁드립니다');
    await answerExtraRequest(page);

    await expect
      .poll(async () => (await botTexts(page)).some((t) => t.includes('등록해 드릴까요')), { timeout: 40000 })
      .toBe(true);

    const all = await botTexts(page);
    const fareIdx = all.findIndex((t) => /90,000/.test(t));
    const confirmIdx = all.findIndex((t) => t.includes('등록해 드릴까요'));
    expect(fareIdx).toBeGreaterThanOrEqual(0);
    expect(fareIdx).toBeLessThan(confirmIdx);
    expect(confirmIdx).toBe(all.length - 1);
    expect(all.some((t) => /경로탐색중|요금검색중/.test(t))).toBe(false);
  });

  // 한도를 넘겨 늦게 온 경우 — 질문을 붙잡아두지 않되, 도착한 요금을 그 질문 위로 끼워 넣는다.
  test('요금이 대기 한도보다 늦게 와도 질문 위로 끼워 넣어 질문이 마지막에 남는다', async ({ page }) => {
    await setupMocks(page, { routeEnabled: true, fareEnabled: true, fareDelayMs: FARE_DELAY_OVER_WAIT_MS });
    await openAiIntakeWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });

    await sendMessage(page, '내일 오후 2시 서울 강서구 양천로53길 30에서 경기 성남시 분당구 판교역로 160으로 토레스 12가3456 탁송 부탁드립니다');
    await answerExtraRequest(page);

    // 질문이 요금보다 먼저 뜬다 — 여기서 요금을 무한정 기다리지 않는다는 점이 확인된다.
    await expect
      .poll(async () => (await botTexts(page)).some((t) => t.includes('등록해 드릴까요')), { timeout: 40000 })
      .toBe(true);
    expect((await botTexts(page)).some((t) => /90,000/.test(t))).toBe(false);

    await expect.poll(async () => (await botTexts(page)).some((t) => /90,000/.test(t)), { timeout: 30000 }).toBe(true);

    const all = await botTexts(page);
    const fareIdx = all.findIndex((t) => /90,000/.test(t));
    const confirmIdx = all.findIndex((t) => t.includes('등록해 드릴까요'));
    // 나중에 온 요금이 이미 떠 있는 질문 위로 들어갔는지 — 화면상 마지막 줄은 여전히 질문이다.
    expect(fareIdx).toBeLessThan(confirmIdx);
    expect(confirmIdx).toBe(all.length - 1);
    expect(all.some((t) => /경로탐색중|요금검색중/.test(t))).toBe(false);
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
