// 목적: 챗봇이 원문에서 분리해둔 상세주소(건물명·상호명)가 지오코딩 뒤에도 살아남는지 본다.
//
// 왜 필요한가: 실사용 접수 건에서 "경기도 군포시 농심로59번길 4 KG모빌리티(KGM광역서비스센터)"의
// 상호명이 통째로 사라졌다. Gemini는 주소/상세주소로 제대로 나눠서 내려줬는데, 그 뒤 주소검색이
// 도로명주소 결과를 확정하면서 order-form.js의 applyResult가 상세주소 칸을 비웠기 때문이다
// (사람이 등록화면에서 주소를 다시 고를 때 옛 동/호수가 남지 않게 하려는 동작인데, AI 접수에서는
// 방금 파싱해 채워둔 값을 지운다). 검색어에는 상호명이 없어 상세주소 힌트 추출로도 되살릴 수
// 없었다 — 도착지 상세정보가 조용히 누락된다.
//
// 그래서 이 테스트는 __aiIntakeResolveAddress를 모킹하지 않는다(다른 접수 e2e는 대부분 모킹한다).
// 진짜 order-form.js를 태워야 이 회귀가 잡히므로, 바깥 경계인 /kakao/search만 고정한다.
const { test, expect } = require('@playwright/test');
const { openAiIntakeWithRetry } = require('./helpers/auth');

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
// 계정·비밀번호는 한 곳에서 가져온다 — 값이 없으면 즉시 멈춘다(tests/e2e-credentials.js).
const { LOGIN_ID, PASSWORD } = require('../e2e-credentials');

const DEST_ROAD = '경기 군포시 농심로59번길 4';
const DEST_JIBUN = '경기 군포시 당정동 230-13';
const DEST_DETAIL = 'KG모빌리티(KGM광역서비스센터)';
const ORIGIN_ROAD = '인천 연수구 앵고개로 82';
const ORIGIN_JIBUN = '인천 연수구 동춘동 1234';

// 사고가 난 실제 접수문과 같은 모양 — 도착지에만 상호명이 붙어 있다.
const FULL_PARSE = {
  intent: 'dispatch_order',
  reserved_date: '2026-08-20',
  reserved_time: '14:00',
  reservation_immediate: true,
  origin_address: ORIGIN_ROAD,
  origin_detail_address: null,
  origin_contact: '010-5635-8180',
  origin_vehicle_number: '83보1141',
  vehicle_type: '액티언스포츠',
  waypoints: [],
  destination_address: DEST_ROAD,
  destination_detail_address: DEST_DETAIL,
  destination_contact: '010-8996-4479',
  memo_customer: '올드카, 서류: 없음',
};

// 카카오가 도로명주소(type !== 'place')를 돌려주는 경우 — 상세주소를 지우는 분기가 여기다.
function addressResult(road, jibun, lat, lon) {
  return { type: 'address', place_name: null, road_address: road, jibun_address: jibun, lat: String(lat), lon: String(lon) };
}

// 두 번째 발화에서 도착지만 바꾸는 경우 — 상세주소는 딸려 오지 않는다.
const CHANGED_DEST_ROAD = '경기 성남시 분당구 판교역로 160';
const CHANGE_DEST_PARSE = {
  intent: 'dispatch_order',
  destination_address: CHANGED_DEST_ROAD,
  destination_detail_address: null,
  waypoints: [],
};

async function setupMocks(page, { parseQueue = null } = {}) {
  await page.addInitScript(() => {
    // 지도 SDK가 없는 환경이라 거리를 고정한다(다른 접수 e2e와 같은 방식).
    const FIXED_DISTANCE = '34.2 km';
    Object.defineProperty(window, '__aiIntakeRouteFinal', { get: () => true, set: () => {}, configurable: true });
    document.addEventListener('DOMContentLoaded', () => {
      const pin = () => {
        const el = document.getElementById('routeTotalDistance');
        if (el && el.textContent !== FIXED_DISTANCE) el.textContent = FIXED_DISTANCE;
      };
      pin();
      new MutationObserver(pin).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
  });

  // parseQueue를 주면 발화 순서대로 다른 응답을 돌려준다(마지막 것을 그 뒤로 계속 재사용).
  const queue = parseQueue ? parseQueue.slice() : null;
  await page.route('**/orders/ai-intake/parse', async (route) => {
    const body = queue ? (queue.length > 1 ? queue.shift() : queue[0]) : FULL_PARSE;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.route('**/kakao/search**', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') || '';
    let doc = addressResult(ORIGIN_ROAD, ORIGIN_JIBUN, 37.41, 126.67);
    if (q.indexOf('군포') >= 0) doc = addressResult(DEST_ROAD, DEST_JIBUN, 37.35, 126.94);
    else if (q.indexOf('판교') >= 0) doc = addressResult(CHANGED_DEST_ROAD, '경기 성남시 분당구 백현동 532', 37.39, 127.11);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documents: [doc] }) });
  });

  await page.route('**/kakao/region**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sido: '경기', sigugun: '군포시', dong: '당정동' }) });
  });

  await page.route('**/orders/fare-preview**', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ enabled: true, baseFare: 27000, ferryFare: 0, totalFare: 27000 }),
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

async function botTexts(page) {
  return page.locator('.ai-chat-bubble.ai-bot').allTextContents();
}

// 봇 말풍선은 한 글자씩 흘려 쓴다(ai-intake-render.js의 streamPlainText) — 보이자마자 읽으면
// "도착지 주소는 '경기 군포시 농"처럼 중간까지만 잡힌다. 길이가 더 늘지 않을 때까지 기다린다.
async function settledBubble(page, needle) {
  let previous = null;
  await expect
    .poll(
      async () => {
        const current = (await botTexts(page)).find((t) => t.includes(needle)) || null;
        const settled = current !== null && current === previous;
        previous = current;
        return settled;
      },
      { timeout: 20000, intervals: [300] },
    )
    .toBe(true);
  return (await botTexts(page)).find((t) => t.includes(needle)) || '';
}

test.describe('AI intake 상세주소 보존', () => {
  test.describe.configure({ timeout: 90000 });

  test('도로명주소로 확정돼도 챗봇이 뽑아둔 상호명이 상세주소에 남는다', async ({ page }) => {
    await setupMocks(page);
    await openAiIntakeWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });

    await sendMessage(page, '탁송 신청합니다. 출발지 인천 연수구 앵고개로 82, 도착지 경기도 군포시 농심로59번길 4 KG모빌리티(KGM광역서비스센터)');

    // 주소 확정 말풍선이 뜰 때까지.
    await expect
      .poll(async () => (await botTexts(page)).some((t) => t.includes('도착지 주소는')), { timeout: 30000 })
      .toBe(true);

    // 폼의 상세주소 칸이 비면 요약·등록 모두에서 빠진다 — 사고의 뿌리라 여기서 먼저 본다.
    await expect
      .poll(async () => page.inputValue('#destination_detail_address'), { timeout: 10000 })
      .toBe(DEST_DETAIL);

    // 확인 말풍선에도 상호명이 보여야 한다 — 고객이 "내가 말한 그 센터"임을 알 수 있어야 한다.
    const destBubble = await settledBubble(page, '도착지 주소는');
    expect(destBubble).toContain(DEST_ROAD);
    expect(destBubble).toContain(DEST_DETAIL);
  });

  // 위 보존의 뒷면 — 상세주소는 그 주소에 딸린 값이라, 도착지가 바뀌면 같이 사라져야 한다.
  // 예전에는 지오코딩이 매번 상세주소를 비워서 이 문제가 없었다. 보존을 넣은 이상 여기서 막는다.
  test('도착지를 다른 곳으로 바꾸면 앞 주소의 상호명이 따라가지 않는다', async ({ page }) => {
    await setupMocks(page, { parseQueue: [FULL_PARSE, CHANGE_DEST_PARSE] });
    await openAiIntakeWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });

    await sendMessage(page, '탁송 신청합니다. 출발지 인천 연수구 앵고개로 82, 도착지 경기도 군포시 농심로59번길 4 KG모빌리티(KGM광역서비스센터)');
    await expect
      .poll(async () => page.inputValue('#destination_detail_address'), { timeout: 30000 })
      .toBe(DEST_DETAIL);

    // 확인 단계에서 바꿔달라고 하면 봇이 "어느 부분을 수정해드릴까요?"를 먼저 묻는다 —
    // 거기에 도착지를 답해야 실제 재수집(pendingField=destination_address)으로 들어간다.
    await sendMessage(page, '도착지를 경기 성남시 분당구 판교역로 160으로 바꿔주세요');
    await expect
      .poll(async () => (await botTexts(page)).some((t) => /어느 부분|도착지 주소/.test(t)), { timeout: 30000 })
      .toBe(true);
    await sendMessage(page, '도착지 주소를 경기 성남시 분당구 판교역로 160으로 바꿔주세요');

    await expect
      .poll(async () => page.inputValue('#destination_address'), { timeout: 30000 })
      .toContain('판교역로 160');
    expect(await page.inputValue('#destination_detail_address')).toBe('');
  });
});
