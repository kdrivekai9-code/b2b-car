// 시스템 상태판이 실제 값을 읽는지 확인한다.
//
// 왜 필요한가: 이 화면 자체가 "조용한 실패"를 막으려고 만든 것인데, 만들면서 똑같은 함정에
// 두 번 빠졌다 — 시각 컬럼 타입이 표마다 달라서(text vs timestamptz) 비교가 던졌고, .catch가
// 그걸 삼켜 "연동 오류 0건"으로 보였다(실제로는 7,942건). 상태판이 조용히 0을 보여주면
// 없는 것보다 나쁘다. 그래서 "던지지 않는가"가 아니라 "실제 수치를 읽는가"를 본다.
require('dotenv').config();
const db = require('../db');
const { collectSystemHealth, minutesSince, describeAge } = require('../lib/systemHealth');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

(async () => {
  try {
    console.log('[시각 계산 — 두 형태를 모두 받는다]');
    // KST 문자열(text 컬럼)과 Date(timestamptz 컬럼)가 섞여 들어온다. 문자열을 그냥 파싱하면
    // 서버 시간대(UTC)로 읽혀 9시간이 어긋난다.
    const kstNow = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    check('KST 문자열은 "방금"으로 읽힌다', Math.abs(minutesSince(kstNow)) <= 1, true);
    check('Date도 읽는다', Math.abs(minutesSince(new Date())) <= 1, true);
    check('빈 값은 null', minutesSince(null), null);
    check('형식이 깨지면 null', minutesSince('어제쯤'), null);
    check('표시 문구', describeAge(null), '기록 없음');

    console.log('[네 항목을 모두 읽는다 — 오류를 0으로 감추지 않는다]');
    const health = await collectSystemHealth();
    check('항목 4개', health.items.length, 4);
    const keys = health.items.map((i) => i.key);
    check('항목 구성', keys, ['callmaner_sync', 'order_notify', 'agent_suggestion', 'integration_errors']);

    // 실제 DB 수치와 대조한다 — 쿼리가 던져서 0으로 떨어지면 여기서 갈린다.
    const real = await db.get(`
      SELECT COUNT(*) AS total FROM integration_errors
       WHERE created_at > to_char(now() at time zone 'Asia/Seoul' - interval '24 hours', 'YYYY-MM-DD HH24:MI:SS')
    `);
    const shown = Number(String(health.items[3].value).replace(/[^\d]/g, ''));
    check('연동 오류 건수가 DB와 일치', shown, Number(real.total));

    const realNotify = await db.get(`
      SELECT COUNT(*) FILTER (WHERE status = 'sent') AS sent
        FROM kakao_order_notifications WHERE created_at > now() - interval '24 hours'
    `);
    check('통보 발송 건수가 DB와 일치',
      /발송 (\d+)건/.exec(health.items[1].value)[1], String(Number(realNotify.sent)));

    console.log('[동기화가 멈추면 경고한다]');
    // 이 판정이 이 화면의 핵심이다 — 매분 도는 것이 10분째 안 돌면 배차·통보가 함께 멈춘 것이다.
    const syncItem = health.items[0];
    check('상태 값이 있다', ['ok', 'warn', 'bad'].includes(syncItem.level), true);
    check('멈췄을 때 무엇이 함께 멈추는지 알린다',
      syncItem.level === 'ok' || /통보/.test(syncItem.hint), true);
  } finally {
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
