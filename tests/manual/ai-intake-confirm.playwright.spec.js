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

    // 경로 거리를 고정한다. 요약은 announceFareGuideFromDb → waitForFinalRouteDistance(20초)를
    // 거쳐야 나오는데, 그 값은 카카오 지도 SDK가 채우는 #routeTotalDistance를 읽는다. 테스트에는
    // SDK가 없어 order-form.js가 "0.0km"을 써두고, 거리가 0이라 20초를 꽉 기다린 뒤 요약 없이
    // 끝난다. 한 번만 넣어두는 것으로는 부족했다 — 주소가 바뀔 때마다 order-form.js가 다시
    // 0.0km으로 덮어쓴다. 그래서 감시하며 되돌린다. 거리 계산 자체는 다른 테스트의 관심사다.
    const FIXED_DISTANCE = '32.5 km';
    Object.defineProperty(window, '__aiIntakeRouteFinal', {
      get: () => true,
      set: () => {},
      configurable: true,
    });
    document.addEventListener('DOMContentLoaded', () => {
      const pin = () => {
        const el = document.getElementById('routeTotalDistance');
        // 값이 이미 같으면 손대지 않는다 — 안 그러면 이 관찰자가 자기 변경에 다시 반응한다.
        if (el && el.textContent !== FIXED_DISTANCE) el.textContent = FIXED_DISTANCE;
      };
      pin();
      new MutationObserver(pin).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
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

  // 요금은 지사 요금표에 따라 달라져 검증에 쓸 수 없다 — 고정값을 준다. 요금표가 비어 있으면
  // "구간요금이 없어 안내가 어렵습니다"로 흐름이 갈라지는데, 그것도 이 테스트가 볼 대상이 아니다.
  await page.route('**/orders/fare-preview**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabled: true, baseFare: 90000, ferryFare: 0, totalFare: 90000 }),
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
// 접수 화면은 말풍선 div에 직접 클래스를 준다(ai-intake-render.js의 addBubble). 질문 말풍선은
// 여기에 ai-bot-question이 더 붙을 뿐이라 같이 잡힌다. 상담관리 카드 쪽의 .ai-chat-item 래퍼는
// 이 화면에 없다 — 그걸 셀렉터에 넣었다가 말풍선을 하나도 못 잡고 헤맸다.
async function botBubbles(page) {
  return page.locator('.ai-chat-bubble.ai-bot').allTextContents();
}

function findSummary(bubbles) {
  return bubbles.find((t) => t.includes('▪ 출발지:')) || null;
}

// 요약 말풍선이 "다 그려질 때까지" 기다린다.
//
// 봇 말풍선은 한 글자씩 흘려 쓴다(ai-intake-render.js의 streamPlainText). "▪ 출발지:"가 보이자마자
// 텍스트를 읽으면 "▪ 출발지: 서울 강서구"처럼 중간까지만 잡혀서, 뒤쪽 항목을 검사하는 테스트가
// 내용이 멀쩡한데도 실패한다. 길이가 더 늘지 않는 걸 확인하고 나서 넘어간다.
async function waitForSummary(page) {
  await expect.poll(async () => findSummary(await botBubbles(page)) !== null, { timeout: 20000 }).toBe(true);

  let previous = null;
  await expect
    .poll(
      async () => {
        const current = findSummary(await botBubbles(page));
        const settled = current !== null && current === previous;
        previous = current;
        return settled;
      },
      { timeout: 20000, intervals: [300] },
    )
    .toBe(true);
}

// 첫 발화 → 요금 안내 → 추가 요청사항 답변 → 요약. 확인 단계에 닿기까지의 공통 경로다.
// 필드가 다 채워져도 봇은 "추가 요청사항이 있으시면 알려주세요"를 한 번 묻고 기다린다 —
// 여기에 답해야 요약으로 넘어간다. 세 테스트 모두 같은 자리에서 시작해야 해서 묶어둔다.
async function reachConfirmStep(page) {
  await sendChat(page, '8월 20일 2시 서울 강서구 양천로53길 30에서 판교역로 160까지 토레스 12가3456 탁송');
  await expect
    .poll(async () => (await botBubbles(page)).some((t) => t.includes('추가 요청사항')), { timeout: 30000 })
    .toBe(true);
  await sendChat(page, '없음', { waitForParse: false });
  await waitForSummary(page);
}

test.describe('AI intake 확인 단계', () => {
  // 로그인 → 화면 진입 → 발화 두 번 → 주소 확정·요금 안내를 거쳐야 확인 단계에 닿는다.
  // 기본 30초로는 흐름이 끝나기 전에 끊긴다(다른 접수 e2e도 같은 이유로 90초를 쓴다).
  test.describe.configure({ timeout: 90000 });

  test('요약 말풍선이 등록 확인 질문보다 먼저, 서로 다른 말풍선으로 나온다', async ({ page }) => {
    await setupMocks(page);
    await login(page);
    await openAiIntake(page);

    await reachConfirmStep(page);

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

    await reachConfirmStep(page);

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

    await reachConfirmStep(page);

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

  // 아래 두 가지는 "요약을 누가 만드는가"를 본다. 위 테스트들만으로는 구분이 안 된다 —
  // 폴백이 서버와 같은 문구를 내도록 맞춰져 있어서, 서버 호출이 아예 안 나가도 통과한다.
  test('요약은 서버가 만든 문구를 그대로 쓴다', async ({ page }) => {
    await setupMocks(page);
    await login(page);
    await openAiIntake(page);

    // 폴백이 절대 만들 수 없는 문구를 서버 응답으로 준다 — 화면에 이게 뜨면 서버 응답을 쓴 것이다.
    const serverText = '▪ 예약: 서버가-만든-요약\n▪ 출발지: 서버 응답 표식';
    let summaryRequested = false;
    await page.route('**/orders/ai-intake/summary.json', async (route) => {
      summaryRequested = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: serverText }) });
    });

    await reachConfirmStep(page);

    expect(summaryRequested).toBe(true);
    const summary = (await botBubbles(page)).find((t) => t.includes('▪ 출발지:')) || '';
    expect(summary).toContain('서버가-만든-요약');
    expect(summary).toContain('서버 응답 표식');
  });

  test('요약 요청이 실패해도 접수가 멈추지 않는다', async ({ page }) => {
    await setupMocks(page);
    await login(page);
    await openAiIntake(page);

    // 고객이 확인하는 문구라, 서버가 죽었다고 확인 단계가 사라지면 안 된다.
    await page.route('**/orders/ai-intake/summary.json', async (route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
    });

    await reachConfirmStep(page);

    const bubbles = await botBubbles(page);
    const summary = bubbles.find((t) => t.includes('▪ 출발지:')) || '';
    // 폴백이 그린 요약이라도 항목은 그대로여야 한다.
    expect(summary).toContain('010-1111-2222');
    expect(summary).toContain('12가3456');
    expect(bubbles.some((t) => t.includes('등록해 드릴까요'))).toBe(true);
  });
});
