// 콜마너 탁송사진이 저장된 뒤 실제로 열리기까지 얼마나 걸리는지 본다.
//
// 이 값을 알아야 사진 통보 방식을 정할 수 있다(lib/photoAvailability.js 주석 참고):
//   몇 분   → 통보를 그만큼 늦추면 끝
//   몇 시간 → 사진이 준비됐을 때 따로 알리는 편이 맞다
//   반나절+ → 알려도 고객이 이미 관심이 없다. 링크만 주는 지금 방식이 맞다
//
//   node scripts/check-photo-availability.js          지금까지 측정된 분포
//   node scripts/check-photo-availability.js --probe  대기 중인 것을 지금 한 번 확인(크론과 같은 동작)
require('dotenv').config();
const db = require('../db');
const photoAvailability = require('../lib/photoAvailability');

function fmtGap(savedAt, availableAt) {
  const ms = new Date(availableAt) - new Date(savedAt);
  if (!Number.isFinite(ms)) return '-';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}분`;
  return `${(min / 60).toFixed(1)}시간`;
}

async function main() {
  const doProbe = process.argv.includes('--probe');

  if (doProbe) {
    console.log('[지금 확인 — 크론과 같은 동작]');
    const r = await photoAvailability.checkPhotoAvailability();
    if (r.skipped) {
      console.log(`  건너뜀: ${r.skipped} (마이그레이션 20260816010000 필요)`);
    } else {
      console.log(`  확인 ${r.checked}묶음 / 열림 ${r.available} / 아직 ${r.stillPending}`);
      (r.results || []).forEach((x) => console.log(`   ${x.oid} ${x.phase} seq=${x.seq} → HTTP ${x.status}`));
    }
    console.log('');
  }

  const rows = await db.all(
    `SELECT o.oid, p.phase, p.seq, p.created_at, p.available_at
       FROM order_callmaner_photos p JOIN orders o ON o.id = p.order_id
      WHERE p.available_at IS NOT NULL
      ORDER BY p.available_at DESC LIMIT 30`
  ).catch((e) => {
    if (e && e.code === '42703') { console.log('available_at 컬럼이 없습니다 — 마이그레이션 20260816010000을 먼저 실행하세요.'); return null; }
    throw e;
  });
  if (rows === null) return;

  console.log('[측정된 지연 — 링크 저장 → 실제로 열림]');
  if (!rows.length) {
    console.log('  아직 없음. 크론이 30분마다 확인하므로 완료된 오더가 생기면 쌓입니다.');
  } else {
    rows.forEach((r) => console.log(`  ${r.oid} ${(r.phase + '   ').slice(0, 5)} 저장 ${String(r.created_at).slice(0, 19)} → ${fmtGap(r.created_at, r.available_at)} 뒤 열림`));
    const gaps = rows.map((r) => (new Date(r.available_at) - new Date(r.created_at)) / 60000).filter(Number.isFinite).sort((a, b) => a - b);
    const mid = gaps[Math.floor(gaps.length / 2)];
    console.log(`\n  표본 ${gaps.length}건 | 최소 ${Math.round(gaps[0])}분 | 중앙값 ${Math.round(mid)}분 | 최대 ${Math.round(gaps[gaps.length - 1])}분`);
  }

  const pending = await db.all(
    `SELECT DISTINCT ON (p.order_id, p.phase) o.oid, p.phase, p.created_at
       FROM order_callmaner_photos p JOIN orders o ON o.id = p.order_id
      WHERE p.available_at IS NULL
      ORDER BY p.order_id, p.phase, p.seq ASC`
  ).catch(() => []);
  console.log(`\n[아직 열리지 않은 묶음] ${pending.length}건`);
  pending.slice(0, 10).forEach((r) => console.log(`  ${r.oid} ${r.phase} (저장 ${String(r.created_at).slice(0, 19)})`));
  if (pending.length) {
    console.log(`  ※ 저장 후 ${photoAvailability.MAX_TRACK_HOURS}시간이 지나면 추적을 멈춘다 — 그 뒤 열려도 기록되지 않는다.`);
  }
  process.exit(0);
}

main().catch((e) => { console.error('오류:', e.message); process.exit(1); });
