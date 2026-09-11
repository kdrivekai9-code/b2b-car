// 요금 문의가 inquiries에 기록되는지 본다 — **어느 화면에서 물었든.**
//
// 무엇을 막나: 이 삽입은 `POST /inquiries` 라우트 안에만 있었고 EJS 챗봇이 그것을 불러
// 기록을 만들었다. Next 챗봇에는 그 호출이 없어서, 화면을 Next로 켜는 순간 **요금 문의
// 기록이 통째로 끊긴다** — 문의 관리 화면이 비고 통계도 멈춘다. 조용한 손실이라 켜고 한참
// 뒤에야 "문의가 왜 안 쌓이지"로 드러난다.
//
// 그래서 기록을 화면이 아니라 **요금을 계산한 서버 자리**에서 남긴다. 이 검사는 그 방향이
// 유지되는지 본다.
//
// 파일만 읽는다 — CI에서 돌 수 있다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return ''; }
};

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

console.log('[삽입이 한 곳에만 있다]');
const lib = read('lib/inquiryRecord.js');
check('lib/inquiryRecord.js가 있다', lib.length > 0);
check('거기서 INSERT 한다', /INSERT INTO inquiries/.test(lib));
// 기록은 곁가지다 — 실패가 고객에게 나갈 요금 안내를 막으면 안 된다.
check('실패해도 던지지 않는다', /catch \(e\)[\s\S]{0,200}return null;/.test(lib));

// 라우트에 사본이 남아 있으면 칸이 갈린다.
const routesInq = read('routes/inquiries.js');
check('라우트에 INSERT 사본이 없다', !/INSERT INTO inquiries/.test(routesInq),
  'lib/inquiryRecord.js의 recordInquiry를 쓸 것');
check('라우트가 그 함수를 쓴다', /recordInquiry\(/.test(routesInq));

console.log('\n[요금을 계산한 자리에서 남긴다]');
const orders = read('routes/orders.js');
const endpoint = orders.slice(orders.indexOf("router.post('/ai-intake/fare-inquiry'"), orders.indexOf("router.post('/ai-intake/activity'"));
check('요금 문의 엔드포인트가 기록한다', /recordInquiry\(/.test(endpoint));
check("category는 'fare'다", /category: 'fare'/.test(endpoint));
// 되묻는 답("8시간이요")까지 기록하면 한 문의가 두 건으로 쪼개진다.
check('되묻는 답에는 기록하지 않는다', /awaitingHours\)\) \{[\s\S]{0,80}recordInquiry\(/.test(endpoint)
  || /if \(!\(req\.body && req\.body\.awaitingHours\)\)/.test(endpoint));

console.log('\n[기록에 담을 값이 계산 결과에 들어 있다]');
// 화면이 값을 되돌려 보내는 왕복 없이 남기려면 계산 함수가 그 값을 함께 줘야 한다.
const assist = read('lib/agentAssist.js');
// **탁송 분기의 fare 객체를 콕 집어 본다.** 파일 전체에서 낱말만 찾으면 다른 상품 분기에
// 같은 이름이 있어 통과해버린다(음성 시험에서 실제로 그랬다). 도선·요금출처를 담을 수 있는
// 것은 경로로 계산하는 탁송 분기다.
const dispatchFareIdx = assist.indexOf("orderType: 'dispatch',");
const dispatchFare = dispatchFareIdx >= 0 ? assist.slice(Math.max(0, dispatchFareIdx - 400), dispatchFareIdx + 400) : '';
check('탁송 요금 결과를 찾았다', dispatchFare.length > 100);
for (const f of ['hasFerryLeg', 'ferryFare', 'fareSource']) {
  check(`탁송 요금 결과에 ${f}가 있다`, new RegExp(`${f}:`).test(dispatchFare),
    '기록에 그 칸이 비어 들어간다');
}
// 엔드포인트가 그 값을 그대로 옮기는지.
for (const [label, expr] of [['거리', 'estimatedDistanceKm: f.distanceKm'], ['금액', 'estimatedFare: f.total'],
  ['요금 출처', 'fareSource: f.fareSource'], ['도선 여부', 'hasFerryLeg: f.hasFerryLeg']]) {
  check(`${label}를 기록한다`, endpoint.includes(expr));
}
// 일일기사는 경로가 없다 — 거리를 0으로 채우면 "계산했는데 0km"로 읽힌다.
check('일일기사 결과에 거리를 지어내지 않는다',
  /orderType: 'daily_driver', fareSource/.test(assist) && !/orderType: 'daily_driver'[^}]*distanceKm/.test(assist));

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
