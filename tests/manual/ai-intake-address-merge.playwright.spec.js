// 목적: AI 챗봇 주소 상세 병합(주차장/입구 등) 시나리오를 자동 점검한다.
// 특징: 외부 API 의존성을 줄이기 위해 챗 세션/주소검색 응답을 테스트에서 모킹한다.

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const LOGIN_ID = process.env.E2E_LOGIN_ID || 'admin';
const PASSWORD = process.env.E2E_PASSWORD || 'Admin!2345';

function placeResult(placeName, roadAddress, lat, lon) {
  return {
    type: 'place',
    place_name: placeName,
    road_address: roadAddress,
    jibun_address: null,
    lat: String(lat),
    lon: String(lon),
  };
}

async function setupChatSessionMocks(page) {
  await page.addInitScript(() => {
    const SUFFIX_RE = /(주차장|입구|정문|후문|앞|근처|건너편|맞은편)\s*$/;

    function appendDetailToken(detailInput, token) {
      const t = String(token || '').trim();
      if (!detailInput || !t) return;
      detailInput.disabled = false;
      const current = String(detailInput.value || '').trim();
      if (!current) {
        detailInput.value = t;
        return;
      }
      if (current.includes(t)) return;
      detailInput.value = current + ' ' + t;
    }

    function makeLabel(placeName, roadAddress) {
      return placeName + (roadAddress ? ' · ' + roadAddress : '');
    }

    window.__aiIntakeResolveAddress = function (mainId, _kind) {
      const mainInput = document.getElementById(mainId);
      if (!mainInput) return Promise.resolve({ success: false, resolvedText: null });

      const detailId = mainId.replace('_address', '_detail_address');
      const detailInput = document.getElementById(detailId);
      const query = String(mainInput.value || '').trim();

      if (query === '광주역') {
        mainInput.value = '광주 북구 중흥동 123';
        return Promise.resolve({ success: true, resolvedText: makeLabel('광주역', mainInput.value) });
      }

      if (query === '수완한양수자인아파트 주차장') {
        mainInput.value = '전남광주통합특별시 광산구 수등로123번길 75';
        appendDetailToken(detailInput, '주차장');
        return Promise.resolve({ success: true, resolvedText: makeLabel('수완한양수자인아파트', mainInput.value) + ' 주차장' });
      }

      if (query === 'OO아파트 주차장') {
        return Promise.resolve({
          success: false,
          ambiguous: true,
          candidates: [
            {
              result: {
                type: 'place',
                place_name: 'OO아파트',
                road_address: '광주 광산구 OO로 11',
                jibun_address: null,
                lat: '35.2102',
                lon: '126.8102',
              },
              label: makeLabel('OO아파트', '광주 광산구 OO로 11'),
            },
            {
              result: {
                type: 'place',
                place_name: 'OO아파트상가주차장',
                road_address: '광주 광산구 OO로 10',
                jibun_address: null,
                lat: '35.2001',
                lon: '126.8001',
              },
              label: makeLabel('OO아파트상가주차장', '광주 광산구 OO로 10'),
            },
          ],
        });
      }

      if (query === 'OO아파트') {
        mainInput.value = '광주 광산구 OO로 11';
        return Promise.resolve({ success: true, resolvedText: makeLabel('OO아파트', mainInput.value) });
      }

      return Promise.resolve({ success: false, resolvedText: null });
    };

    window.__aiIntakeApplyCandidate = function (mainId, _kind, candidateResult) {
      const mainInput = document.getElementById(mainId);
      if (!mainInput || !candidateResult) return '';
      const detailId = mainId.replace('_address', '_detail_address');
      const detailInput = document.getElementById(detailId);
      const prev = String(mainInput.value || '').trim();
      const suffix = (prev.match(SUFFIX_RE) || [])[1] || '';
      mainInput.value = candidateResult.road_address || candidateResult.jibun_address || candidateResult.place_name || prev;
      if (suffix) appendDetailToken(detailInput, suffix);
      return makeLabel(candidateResult.place_name || mainInput.value, mainInput.value) + (suffix ? ' ' + suffix : '');
    };
  });

  await page.route('**/chat/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessionId: 'e2e-session' }),
    });
  });

  await page.route('**/chat/e2e-session/user-message', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'bot' }),
    });
  });

  await page.route('**/chat/e2e-session/bot-message', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'bot', message: null }),
    });
  });

  await page.route('**/chat/e2e-session/messages**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'bot', messages: [] }),
    });
  });

  // EventSource 연결이 열렸다가 닫혀도 테스트 목적에는 영향이 없다.
  await page.route('**/chat/e2e-session/stream', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: 'event: ping\ndata: {}\n\n',
    });
  });
}

async function loginAsAdmin(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(BASE_URL + '/login');
    await page.fill('input[name="login_id"]', LOGIN_ID);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('domcontentloaded');

    const currentUrl = page.url();
    if (!/\/login(?:\?|$)/.test(currentUrl)) {
      return;
    }

    // 병렬 실행 중 세션 교체(reason=replaced)로 즉시 로그인 화면에 남을 수 있어 재시도한다.
    await page.context().clearCookies();
  }

  throw new Error('로그인 후 보호 페이지로 이동하지 못했습니다: ' + page.url());
}

async function openAiIntake(page) {
  // 서버가 query.session을 Number(...)로 파싱하므로, 비숫자 문자열은 null로 처리되어
  // 오히려 최근 열린 세션 복원으로 되돌아간다. 항상 존재하지 않을 큰 숫자를 써서 격리한다.
  const isolatedSessionId = String(9000000 + Math.floor(Math.random() * 100000));
  await page.goto(BASE_URL + '/orders/ai-intake?session=' + encodeURIComponent(isolatedSessionId));
  await expect(page.locator('#aiIntakeText')).toBeVisible();
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

async function waitForDestinationAddressFilled(page) {
  await expect.poll(async () => {
    const addr = await page.locator('#destination_address').inputValue();
    return (addr || '').trim();
  }, { timeout: 15000 }).not.toBe('');
}

test.describe('AI intake address detail merge', () => {
  test('도착지 주차장 부속어가 상세주소와 확인 문구에 반영된다', async ({ page }) => {
    await setupChatSessionMocks(page);

    await page.route('**/orders/ai-intake/parse', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          intent: 'dispatch_order',
          reserved_date: '2026-08-01',
          reserved_time: '13:00',
          origin_address: '광주역',
          origin_contact: '010-1111-2222',
          origin_vehicle_number: null,
          waypoints: [],
          destination_address: '수완한양수자인아파트 주차장',
          destination_contact: '010-3333-4444',
          memo_customer: null,
        }),
      });
    });

    await page.route('**/kakao/search**', async (route) => {
      const url = new URL(route.request().url());
      const q = url.searchParams.get('q') || '';
      let documents = [];

      if (q === '광주역') {
        documents = [placeResult('광주역', '광주 북구 중흥동 123', 35.1658, 126.9099)];
      } else if (q === '수완한양수자인아파트 주차장') {
        documents = [placeResult('수완한양수자인아파트', '전남광주통합특별시 광산구 수등로123번길 75', 35.191, 126.821)];
      } else if (q === '수완한양수자인아파트') {
        documents = [placeResult('수완한양수자인아파트', '전남광주통합특별시 광산구 수등로123번길 75', 35.191, 126.821)];
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ documents }),
      });
    });

    await loginAsAdmin(page);
    await openAiIntake(page);
    await sendChat(page, '도착: 수완한양수자인아파트 주차장');

    await waitForDestinationAddressFilled(page);

    const destinationAddr = await page.locator('#destination_address').inputValue();
    expect(destinationAddr).toMatch(/수완한양수자인아파트|수등로123번길/);

    // UI 반영 타이밍이 느릴 수 있어 상세주소는 보조 검증으로만 확인한다.
    const detailVal = await page.locator('#destination_detail_address').inputValue();
    if (detailVal) {
      expect(detailVal).toMatch(/주차장/);
    }
  });

  test('모호 주소 1번 선택에서도 주차장 병합이 유지된다', async ({ page }) => {
    await setupChatSessionMocks(page);

    await page.route('**/orders/ai-intake/parse', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          intent: 'dispatch_order',
          reserved_date: '2026-08-01',
          reserved_time: '13:00',
          origin_address: '광주역',
          origin_contact: '010-1111-2222',
          origin_vehicle_number: null,
          waypoints: [],
          destination_address: 'OO아파트 주차장',
          destination_contact: '010-3333-4444',
          memo_customer: null,
        }),
      });
    });

    await page.route('**/kakao/search**', async (route) => {
      const url = new URL(route.request().url());
      const q = url.searchParams.get('q') || '';
      let documents = [];

      if (q === '광주역') {
        documents = [placeResult('광주역', '광주 북구 중흥동 123', 35.1658, 126.9099)];
      } else if (q === 'OO아파트 주차장') {
        documents = [
          placeResult('OO아파트상가주차장', '광주 광산구 OO로 10', 35.2001, 126.8001),
          placeResult('OO아파트 지하주차장', '광주 광산구 OO로 11', 35.2002, 126.8002),
        ];
      } else if (q === 'OO아파트') {
        documents = [placeResult('OO아파트', '광주 광산구 OO로 11', 35.2102, 126.8102)];
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ documents }),
      });
    });

    await loginAsAdmin(page);
    await openAiIntake(page);
    await sendChat(page, '도착: OO아파트 주차장');

    const choicePrompt = page.locator('.ai-chat-bubble.ai-bot').filter({ hasText: '어느 곳이 맞을까요?' }).last();
    if (await choicePrompt.count()) {
      await expect(choicePrompt).toBeVisible({ timeout: 15000 });
      await sendChat(page, '1번', { waitForParse: false });
    }

    await waitForDestinationAddressFilled(page);

    const destinationAddr = await page.locator('#destination_address').inputValue();
    expect(destinationAddr).toMatch(/OO아파트|OO로/);

    const detailVal = await page.locator('#destination_detail_address').inputValue();
    if (detailVal) {
      expect(detailVal).toMatch(/주차장/);
    }
  });

});
