// 카카오 접수 폼 파서 재생 테스트 — 실사용 상담톡 로그를 그대로 통과시켜 추출률을 잰다.
// 기획서(docs/kakao-chatbot-upgrade-plan.html) Phase 1 완료 기준이 "실사용 폼 100건 재생
// 테스트에서 필수 4종 추출 95% 이상"이라 그 기준을 여기서 확인한다.
//
//   node scripts/check-kakao-intake-parser.js <msgs.json 경로> [--fails 20]
//
// msgs.json은 docs/kakao-log-analysis/parse_log.py가 만든다. 원본 로그에는 실명·연락처가
// 들어 있어 저장소에 두지 않으므로 경로를 인자로 받는다.
const fs = require('fs');
const { parseKakaoIntake } = require('../lib/kakaoIntakeParser');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('사용법: node scripts/check-kakao-intake-parser.js <msgs.json> [--fails N]');
  process.exit(1);
}
const failLimitArg = process.argv.indexOf('--fails');
const failLimit = failLimitArg > -1 ? Number(process.argv[failLimitArg + 1]) || 10 : 10;

const messages = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const forms = messages.filter((m) => m.role === '고객' && /(\[\s*출발지\s*\]|＊\s*출발지)/.test(m.text));

const stat = {
  total: forms.length,
  matched: 0,
  complete: 0,
  originAddress: 0,
  destAddress: 0,
  vehicle: 0,
  when: 0,
  originContact: 0,
  destContact: 0,
  bothContacts: 0,
  multiVehicle: 0,
  vehicleTotal: 0,
  insurance: 0,
  refuel: 0,
  documents: 0,
  fuelGauge: 0,
  releaseDate: 0,
  immediate: 0,
  memo: 0,
};
const missingCount = {};
const failures = [];

for (const m of forms) {
  const parsed = parseKakaoIntake(m.text);
  if (!parsed.matched) {
    failures.push({ reason: parsed.reason, text: m.text });
    continue;
  }
  stat.matched += 1;
  if (parsed.complete) stat.complete += 1;
  else {
    parsed.missing.forEach((k) => { missingCount[k] = (missingCount[k] || 0) + 1; });
    if (failures.length < 500) failures.push({ reason: parsed.missing.join(','), text: m.text });
  }
  if (parsed.origin.address) stat.originAddress += 1;
  if (parsed.destination.address) stat.destAddress += 1;
  if (parsed.vehicles.length) stat.vehicle += 1;
  if (parsed.vehicles.length > 1) stat.multiVehicle += 1;
  stat.vehicleTotal += parsed.vehicles.length;
  if (parsed.when && (parsed.when.immediate || parsed.when.date || parsed.when.time)) stat.when += 1;
  if (parsed.when && parsed.when.immediate) stat.immediate += 1;
  if (parsed.origin.contact) stat.originContact += 1;
  if (parsed.destination.contact) stat.destContact += 1;
  if (parsed.origin.contact && parsed.destination.contact) stat.bothContacts += 1;
  if (parsed.options.insurance) stat.insurance += 1;
  if (parsed.options.refuel) stat.refuel += 1;
  if (parsed.options.documents) stat.documents += 1;
  if (parsed.options.fuelGauge) stat.fuelGauge += 1;
  if (parsed.options.releaseDate) stat.releaseDate += 1;
  if (parsed.memo) stat.memo += 1;
}

const pct = (n) => (stat.total ? ((100 * n) / stat.total).toFixed(1) + '%' : '-');
const row = (label, n) => console.log('  ' + label.padEnd(22) + String(n).padStart(6) + '  ' + pct(n).padStart(7));

console.log(`\n접수 폼 ${stat.total}건 재생\n`);
console.log('[필수 4종]');
row('폼으로 인식', stat.matched);
row('출발지 주소', stat.originAddress);
row('도착지 주소', stat.destAddress);
row('차량번호', stat.vehicle);
row('일시', stat.when);
row('4종 모두 충족', stat.complete);

console.log('\n[준필수 · 구조]');
row('출발지 연락처', stat.originContact);
row('도착지 연락처', stat.destContact);
row('양쪽 연락처', stat.bothContacts);
row('복수 차량', stat.multiVehicle);
console.log('  차량 총 대수'.padEnd(24) + String(stat.vehicleTotal).padStart(6));

console.log('\n[옵션]');
row('즉시 출발', stat.immediate);
row('서류', stat.documents);
row('주유', stat.refuel);
row('연료 잔량', stat.fuelGauge);
row('출고일', stat.releaseDate);
row('책임보험', stat.insurance);
row('전달 메모', stat.memo);

if (Object.keys(missingCount).length) {
  console.log('\n[미충족 항목별 건수]');
  Object.entries(missingCount)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log('  ' + k.padEnd(22) + String(v).padStart(6)));
}

if (failures.length) {
  console.log(`\n[되묻기로 넘어가는 사례 ${failures.length}건 중 상위 ${Math.min(failLimit, failures.length)}건]`);
  failures.slice(0, failLimit).forEach((f, i) => {
    console.log(`\n--- ${i + 1}. 부족: ${f.reason} ---`);
    console.log(f.text.split('\n').slice(0, 12).join('\n'));
  });
}

const passRate = stat.total ? (100 * stat.complete) / stat.total : 0;
console.log(`\n필수 4종 추출률 ${passRate.toFixed(1)}% ${passRate >= 95 ? '— 기준(95%) 충족' : '— 기준(95%) 미달'}`);
process.exitCode = passRate >= 95 ? 0 : 1;
