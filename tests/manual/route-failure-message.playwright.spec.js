// 경로탐색이 실패했을 때 챗봇이 고객에게 무슨 말을 하는지.
//
// 2026-08-25 실사용 사고: 사당역→서귀포시청 요금문의에서 "거리 계산을 완료하지 못했습니다.
// 주소를 조금 더 상세히 입력해주세요"가 나갔다. 주소는 둘 다 정상 확정됐고 서버 경로탐색도
// 멀쩡했는데(571.8km) 그렇게 안내한 것이라, 고객은 고칠 것이 없는 주소를 고치려 들었다.
// 게다가 실패 사유가 브라우저에서도 서버에서도 어디에도 안 남아 원인을 찾을 수 없었다.
//
// 그래서 여기서는 경로탐색을 일부러 실패시키고 두 가지를 본다.
//   · 고객에게 나가는 말이 주소 탓으로 단정하지 않고 실제 사유를 밝히는가.
//   · 그 문장이 상담 로그에 남는가 — 화면을 열지 않고 원인을 보려면 남아야 한다.
//
// 실패를 만들어야 하므로 /kakao/directions를 가로채 500을 돌려준다. 실제 카카오 API를
// 건드리지 않고도 "응답이 ok가 아닐 때"를 그대로 재현할 수 있다.
const { test, expect } = require('@playwright/test');
const { openAiIntakeWithRetry } = require('./helpers/auth');

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
// 로그인 계정: 실사용 admin으로 로그인하면 단일 세션 강제(users.active_session_hash) 때문에
// 그 계정을 쓰던 사람이 로그아웃된다 — QA 전용 계정을 쓴다. 비밀번호는 .env(E2E_PASSWORD)에서
// 온다(저장소에 적지 않는다).
const LOGIN_ID = process.env.E2E_LOGIN_ID || 'qa_test_bot';
const PASSWORD = process.env.E2E_PASSWORD || '';

test.describe('경로탐색 실패 안내', () => {
  test.describe.configure({ timeout: 240000 });

  test('실패하면 사유를 밝히고, 주소 탓으로 단정하지 않는다', async ({ page }) => {
    await page.route('**/kakao/directions**', (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: '경로탐색 서버 오류', detail: '검사용 강제 실패' }),
    }));

    await openAiIntakeWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });

    // 화면 안에서 직접 확인한다 — 대화를 끝까지 태우면 Gemini 파싱·주소검색까지 걸려 이 검사가
    // 보려는 것(실패 안내 문구)과 무관한 이유로 흔들린다.
    const result = await page.evaluate(async () => {
      const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
      setVal('origin_address', '서울 동작구 남부순환로 지하 2089');
      setVal('destination_address', '제주특별자치도 서귀포시 중앙로 105');
      // 주소 후보를 확정시켜 마커를 찍는다 — 챗봇이 주소를 확정할 때 쓰는 그 통로 그대로다
      // (검사 전용 뒷문을 새로 만들지 않는다).
      const apply = window.__aiIntakeApplyCandidate;
      if (apply) {
        apply('origin_address', 'origin', {
          type: 'address', road_address: '서울 동작구 남부순환로 지하 2089',
          jibun_address: null, lat: '37.4766', lon: '126.9816',
        });
        apply('destination_address', 'destination', {
          type: 'address', road_address: '제주특별자치도 서귀포시 중앙로 105',
          jibun_address: null, lat: '33.2541', lon: '126.5596',
        });
      }
      await new Promise((r) => setTimeout(r, 4000));
      return {
        routeError: window.__aiIntakeRouteError,
        final: window.__aiIntakeRouteFinal,
        hasApply: !!apply,
        distanceText: (document.getElementById('routeTotalDistance') || {}).textContent,
      };
    });

    // 주소 확정 통로가 없으면 이 검사는 아무것도 확인하지 못한 채 통과한다 — 그건 막는다.
    expect(result.hasApply, '주소 확정 통로가 있어야 한다').toBe(true);
    // 직선거리 임시값은 그려져 있어야 한다 — 그래야 "거리는 있는데 확정이 안 된 상태"라는
    // 실제 사고 상황과 같아진다(챗봇은 확정 여부까지 함께 본다).
    expect(result.distanceText).toMatch(/km/);
    // 실패 사유가 남아야 챗봇이 맞는 말을 할 수 있다. 예전에는 여기가 통째로 비어 있었다.
    expect(result.routeError, '실패 사유가 남아야 한다').toBeTruthy();
    expect(result.routeError.detail).toContain('500');
    expect(result.routeError.detail).toContain('경로탐색 서버 오류');
    // 실패했으므로 "최종 거리 확정"으로 넘어가면 안 된다.
    expect(result.final).toBeFalsy();

    // 고객에게 나가는 문장 — 주소 탓으로 단정하지 않고 사유를 밝혀야 한다.
    const text = await page.evaluate(() => window.__aiIntakeRouteFailureText('거리 계산'));
    expect(text).toContain('경로탐색 서버 오류');
    expect(text).not.toContain('상세히 입력해주시면');
  });
});
