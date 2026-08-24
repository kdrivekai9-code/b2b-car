// 접수 확인과 경로/요금 안내를 합쳐 보내는지 확인한다.
//
// 실사용 지적(2026-08-24): "접수했습니다. 주문번호는…"이 먼저 나가고 경로·요금이 1초 뒤에 따로
// 도착해서, 결과가 접수 확인 뒤에 덧붙는 것처럼 보여 혼란스러웠다(실측 20:15:37 → 20:15:38).
// 그래서 빨리 끝나면 한 통으로 합치고, 늦을 때만 나눠 보낸다.
//
// 이 판정은 타이밍이 전부라 눈으로 볼 수가 없다 — 조회 지연을 마음대로 만들어 확인한다.
// 카카오로 실제 발신하지 않도록 발신 계층과 조회 계층을 require.cache로 바꿔 끼운다.
process.env.NODE_ENV = 'development';

const path = require('path');
function stub(relPath, exports) {
  const full = require.resolve(relPath);
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
  return exports;
}

// ---- 발신 계층: 실제로 카카오로 보내지 않고 무엇을 보냈는지만 모은다 ----
const sent = [];
const realKakao = require('../lib/kakaoConsult');
stub('../lib/kakaoConsult', {
  ...realKakao,
  isConfigured: () => true,
  sendMessage: async (session, text) => { sent.push(text); return { ok: true }; },
});

// ---- 조회 계층: 지연과 결과를 검사가 정한다 ----
let routeFareBehavior = null;
stub('../lib/routeFareSearch', {
  getRouteFareSettings: async () => routeFareBehavior.settings,
  searchRouteAndFare: async ({ onRoute }) => {
    const b = routeFareBehavior;
    if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
    if (b.settings.route && onRoute) {
      await onRoute({ distanceKm: 5.8, durationSec: 17 * 60, tollFare: 0, hasFerryLeg: false });
    }
    return { enabled: true, ok: true, routeEnabled: b.settings.route, fareEnabled: b.settings.fare,
      distanceKm: 5.8, durationSec: 17 * 60, tollFare: 0, hasFerryLeg: false,
      fare: b.settings.fare ? 20000 : null };
  },
});

const db = require('../db');
const consult = require('../routes/kakaoConsult');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

const RECEIPT = '접수했습니다. 주문번호는 (OID9999)이며 기사님 배정시 알려드리겠습니다.';

async function run(behavior, session) {
  sent.length = 0;
  routeFareBehavior = behavior;
  await consult.announceOrderReceiptWithRouteFare(
    session,
    { branch_id: 1, requester_group_id: null },
    {
      message: RECEIPT,
      geo: { origin: { lat: 37.47, lon: 126.98 }, destination: { lat: 37.49, lon: 127.02 } },
      created: [{ vehicle: { vehicleType: '그랜저' } }],
    }
  );
  return sent.slice();
}

(async () => {
  const s = await db.get(
    `INSERT INTO chat_sessions (user_id, status, channel) VALUES (NULL, 'bot', 'kakao') RETURNING id`
  );
  const session = { id: Number(s.id) };

  try {
    console.log('[빨리 끝나면 한 통으로 합친다]');
    let out = await run({ settings: { route: true, fare: true }, delayMs: 100 }, session);
    check('말풍선 1개', out.length, 1);
    check('접수 확인이 들어 있다', out[0].includes('주문번호는 (OID9999)'), true);
    check('거리·소요시간이 같이 있다', /5\.8km/.test(out[0]) && /17분/.test(out[0]), true);
    check('예상 요금도 같이 있다', /20,000원/.test(out[0]), true);
    // 합칠 때는 "경로탐색 결과입니다" 같은 머리말을 붙이지 않는다 — 접수 확인 밑에 오면 어색하다.
    check('결과 머리말은 붙이지 않는다', /경로탐색 결과입니다/.test(out[0]), false);

    console.log('[늦으면 접수 확인을 먼저 보내고 이어 붙인다]');
    out = await run({ settings: { route: true, fare: true }, delayMs: 1900 }, session);
    check('말풍선 3개(접수 → 경로 → 요금)', out.length, 3);
    check('첫 통에 접수 확인', out[0].includes('주문번호는 (OID9999)'), true);
    // 예고가 없으면 뒤에 오는 결과가 갑작스럽다 — 이번 지적의 핵심이다.
    check('이어진다고 예고한다', /이어서 알려드릴게요/.test(out[0]), true);
    check('첫 통에는 결과가 없다', /5\.8km|20,000원/.test(out[0]), false);
    check('두 번째가 경로', /경로탐색 결과입니다/.test(out[1]), true);
    check('세 번째가 요금', /예상 요금은 약 20,000원/.test(out[2]), true);

    console.log('[요금만 켠 법인은 요금만 안내한다]');
    out = await run({ settings: { route: false, fare: true }, delayMs: 100 }, session);
    check('말풍선 1개', out.length, 1);
    check('요금은 있다', /20,000원/.test(out[0]), true);
    check('거리는 없다', /5\.8km/.test(out[0]), false);

    console.log('[둘 다 끈 법인은 접수 확인만 보낸다]');
    out = await run({ settings: { route: false, fare: false }, delayMs: 100 }, session);
    check('말풍선 1개', out.length, 1);
    // 실제 발신에는 "AI 상담사" 라벨이 앞에 붙는다(withBotLabel) — 포함 여부로 본다.
    check('접수 확인만 있고 결과는 없다', out[0].includes(RECEIPT) && !/5\.8km|20,000원/.test(out[0]), true);

    console.log('[좌표가 없으면 접수 확인만 보낸다]');
    sent.length = 0;
    routeFareBehavior = { settings: { route: true, fare: true }, delayMs: 0 };
    await consult.announceOrderReceiptWithRouteFare(
      session, { branch_id: 1, requester_group_id: null }, { message: RECEIPT, geo: {}, created: [] }
    );
    check('말풍선 1개', sent.length, 1);
    check('접수 확인만 있고 결과는 없다', sent[0].includes(RECEIPT) && !/5\.8km|20,000원/.test(sent[0]), true);
  } finally {
    await db.run('DELETE FROM chat_messages WHERE session_id = ?', [session.id]).catch(() => {});
    await db.run('DELETE FROM chat_sessions WHERE id = ?', [session.id]).catch(() => {});
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
