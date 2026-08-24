// 콜마너 전체상태조회(OrderAllStatus)가 실패해도 단건조회가 계속 도는지 확인한다.
//
// 실제로 멈췄다(2026-08-24 발견): 저장된 커서(callmaner_sync_state.last_up_date)가 하루를
// 넘기자 콜마너가 "NG 날짜는 최대 전날까지 가능합니다"로 거부했고, 던져진 예외가 같은 try를
// 빠져나가면서 뒤따르는 syncOrdersByConfSlip까지 건너뛰었다. 배차·운행시작·완료 감지와 고객
// 통보가 7일간 전부 멈춰 있었는데(마지막 성공 2026-08-17 11:59), 로그에는 매분 같은 오류 한
// 줄만 남았다.
//
// 이런 종류는 조용해서 위험하다 — 되살아난 걸 확인하는 검사를 남긴다.
require('dotenv').config();
const cm = require('../lib/callmaner');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

function kstStamp(msAgo) {
  return new Date(Date.now() + 9 * 60 * 60 * 1000 - msAgo).toISOString().slice(0, 19).replace(/[-:T]/g, '');
}

console.log('[커서를 콜마너가 받는 범위로 당긴다]');
// 하루를 넘긴 커서는 거부당한다 — 전날 안쪽으로 당겨야 한다.
const old7d = '20260817115909';
const clamped = cm.clampLastUpDate(old7d);
check('7일 전 커서는 당겨진다', clamped > old7d, true);
check('당긴 값이 하루 안쪽이다', clamped >= kstStamp(24 * 60 * 60 * 1000), true);
// 형식이 바뀌면 콜마너가 다르게 해석한다 — YYYYMMDDHHmmss 14자리를 유지해야 한다.
check('형식은 14자리 그대로', /^\d{14}$/.test(clamped), true);

console.log('[최근 커서는 건드리지 않는다]');
const recent = kstStamp(60 * 60 * 1000); // 1시간 전
check('1시간 전 커서는 그대로', cm.clampLastUpDate(recent), recent);

console.log('[처음 조회는 0을 그대로 보낸다]');
// 0은 콜마너가 받아준다(실측) — 첫 동기화에서 전체를 받아야 한다.
check("'0'은 그대로", cm.clampLastUpDate('0'), '0');
check('빈 값도 0으로', cm.clampLastUpDate(''), '0');
check('null도 0으로', cm.clampLastUpDate(null), '0');

console.log('[실제 콜마너가 당긴 값을 받아주는지]');
(async () => {
  const db = require('../db');
  try {
    const branch = await db.get('SELECT * FROM branches WHERE callmaner_enabled = true ORDER BY id LIMIT 1');
    if (!branch) {
      console.log('  (건너뜀 — 콜마너 연동 지사가 없습니다)');
    } else {
      // 거부당하던 그 값(7일 전)을 그대로 넘긴다 — clampLastUpDate가 안에서 당겨주므로
      // 호출은 성공해야 한다. 이게 실패하면 커서가 오래된 순간 다시 7일간 멈춘다.
      const ok = await cm.orderAllStatus(branch, old7d)
        .then(() => true)
        .catch((e) => { console.log('     콜마너 응답:', e.message.slice(0, 60)); return false; });
      check('오래된 커서로도 호출이 성공한다', ok, true);
    }
  } finally {
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
