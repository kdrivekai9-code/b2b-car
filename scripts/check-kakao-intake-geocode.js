// 접수 폼에서 뽑은 주소가 실제로 좌표+행정구역까지 붙는지 확인한다.
// 이게 붙지 않으면 콜마너 오더접수(buildOrderPayload)가 출발지 좌표 없음으로 거부하므로,
// 자동 등록 가능 여부를 좌우하는 검사다.
//
//   node scripts/check-kakao-intake-geocode.js <msgs.json> [샘플수=30]
require('dotenv').config();
const fs = require('fs');
const { parseKakaoIntake } = require('../lib/kakaoIntakeParser');
const { geocodeAddress, isCallmanerReady } = require('../lib/geocode');

const inputPath = process.argv[2];
const sampleSize = Number(process.argv[3]) || 30;
if (!inputPath) {
  console.error('사용법: node scripts/check-kakao-intake-geocode.js <msgs.json> [샘플수]');
  process.exit(1);
}
if (!process.env.KAKAO_REST_API_KEY) {
  console.error('KAKAO_REST_API_KEY가 없습니다 (.env 확인).');
  process.exit(1);
}

const messages = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const forms = messages.filter((m) => m.role === '고객' && /(\[\s*출발지\s*\]|＊\s*출발지)/.test(m.text));

// 같은 거래처 폼이라 주소가 크게 반복된다 — 서로 다른 주소만 모아야 의미 있는 검사가 된다.
const uniqueAddresses = new Map();
for (const m of forms) {
  const p = parseKakaoIntake(m.text);
  if (!p.matched) continue;
  for (const addr of [p.origin.address, p.destination.address]) {
    if (addr && !uniqueAddresses.has(addr)) uniqueAddresses.set(addr, true);
  }
}
const all = [...uniqueAddresses.keys()];
// 앞쪽(자주 쓰는 거점)과 뒤쪽(일회성 지방 주소)을 섞어서 뽑는다.
const step = Math.max(1, Math.floor(all.length / sampleSize));
const sample = all.filter((_, i) => i % step === 0).slice(0, sampleSize);

(async () => {
  let ok = 0;
  let ready = 0;
  const failed = [];
  for (const addr of sample) {
    const geo = await geocodeAddress(addr);
    if (geo) {
      ok += 1;
      if (isCallmanerReady(geo)) ready += 1;
      const flag = isCallmanerReady(geo) ? '  ' : '△ ';
      console.log(`${flag}${addr.slice(0, 42).padEnd(44)} → ${geo.matchedBy.padEnd(7)} ${String(geo.sido || '-')} ${String(geo.sigugun || '-')} ${String(geo.dong || '-')}`);
    } else {
      failed.push(addr);
      console.log(`✗ ${addr.slice(0, 42).padEnd(44)} → 실패`);
    }
  }
  console.log(`\n서로 다른 주소 ${all.length}개 중 ${sample.length}개 표본`);
  console.log(`좌표 확보 ${ok}/${sample.length} (${((100 * ok) / sample.length).toFixed(1)}%)`);
  console.log(`콜마너 접수 가능(좌표+행정구역) ${ready}/${sample.length} (${((100 * ready) / sample.length).toFixed(1)}%)`);
  if (failed.length) {
    console.log('\n[실패 주소]');
    failed.forEach((f) => console.log('  ' + f));
  }
})();
