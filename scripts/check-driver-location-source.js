// 기사 위치 좌표를 어디서 가져오는가.
//
// 왜 필요한가(실측 2026-09-08, OID2075): 화면이 그리던 좌표는 실제 기사 위치가 아니었다.
// MCP(call.list.active)의 driver.xy를 쓰고 있었는데 그 응답에는 source='route_interpolated'가
// 붙어 있었고, 값은 출발지↔도착지의 **정확히 1/3 지점**(위도·경도 모두 33%)이었다.
// 같은 순간 콜마너 REST의 TrackingDriver가 준 실제 좌표와 **7.04km** 떨어져 있었다.
//
// "지금 어디쯤이에요?"에 답하려고 만든 화면이 7km 틀린 곳을 가리키는 것은, 없는 것보다 나쁘다 —
// 고객이 그 자리에서 기다린다. 그래서 좌표는 TrackingDriver를 먼저 믿고, MCP 좌표는 보간값이
// 아닐 때만 예비로 쓴다. 보간값뿐이면 "신호가 아직 안 잡혔다"로 답한다.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const dl = require('../lib/driverLocation');
const callmaner = require('../lib/callmaner');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`}`);
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

console.log('[만들어낸 좌표를 가린다]');
// 실제로 본 값.
check("route_interpolated는 가짜", dl.isSynthesizedSource('route_interpolated'), true);
// 이름이 무엇이든 gps가 아니면 실제 위치로 보지 않는다 — 새 값이 생겼을 때 조용히 신뢰하는
// 쪽으로 기울면 같은 사고가 반복된다.
check('모르는 출처도 가짜로 본다', dl.isSynthesizedSource('smoothed_path'), true);
check('gps는 진짜', dl.isSynthesizedSource('gps'), false);
check('device도 진짜', dl.isSynthesizedSource('device'), false);
// 출처를 안 주는 응답은 예전 그대로 다룬다(모르는 것을 가짜로 단정하지 않는다).
check('출처가 없으면 판정하지 않는다', dl.isSynthesizedSource(''), false);
check('null도 마찬가지', dl.isSynthesizedSource(null), false);

console.log('\n[좌표의 진실은 콜마너 REST다]');
check('TrackingDriver가 구현돼 있다', typeof callmaner.trackingDriver, 'function');
const cm = read('lib/callmaner.js');
// conf_slip으로 찾는다 — 사번만 보내면 콜마너가 거절한다(실측).
check('conf_slip으로 조회한다', /cmd: 'TrackingDriver'|'TrackingDriver', rq|callCallmaner\('order', 'TrackingDriver'/.test(cm), true);
check('lat/lng를 읽는다', /Number\(rs\.lat\)/.test(cm) && /Number\(rs\.lng\)/.test(cm), true);
// 좌표가 없을 때 0,0을 만들면 지도에 아프리카 앞바다가 찍힌다.
check('좌표가 없으면 null', /if \(!lat && !lon\) return null;/.test(cm), true);

const src = read('lib/driverLocation.js');
// 변수 이름이 liveXy로 바뀌었다(마지막 확인 위치 폴백이 붙어 xy와 갈라졌다,
// scripts/check-driver-last-fix.js). 규칙은 그대로다 — REST 좌표가 있으면 그것부터.
check('REST를 먼저 쓴다', /const liveXy = parseXy\(real \? /.test(src), true);
check('보간값이면 좌표를 버린다', /\(synthesized \? null : mcpXy\)/.test(src), true);
// 가짜 위치로 낸 "5분 뒤 도착"이 가장 나쁘다.
check('보간값이면 ETA·거리도 버린다',
  /etaMinutes: !synthesized &&/.test(src) && /distanceKm: !synthesized &&/.test(src), true);
// 한쪽이 죽어도 다른 쪽으로 답해야 한다.
check('두 경로를 각각 잡는다', /fetchFromCallmaner\(order\)\.catch/.test(src) && /fetchFromMcp\(order\)\.catch/.test(src), true);
// 배차 전 NG는 오류가 아니다 — 로그를 어지럽히면 진짜 오류가 묻힌다.
check('배차 전 거절은 조용히', /배차된 정보가 없습니다/.test(src), true);
// 어디서 온 좌표인지 남겨야 "왜 이 위치인가"를 되짚을 수 있다. 출처는 셋이다 —
// callmaner(REST 실시간) / mcp(보간 아닌 예비) / last_known(우리가 남긴 마지막 좌표).
check('출처를 함께 돌려준다', /const source = real && liveXy \? 'callmaner' :/.test(src), true);
check('세 출처를 구분한다', /'mcp'/.test(src) && /'last_known'/.test(src), true);
// TrackingDriver는 시각을 주지 않는다 — **지금** 그 좌표를 받았으면 나이를 말하지 않는다.
// 반대로 마지막 좌표로 답할 때는 반드시 나이를 붙인다(scripts/check-driver-last-fix.js).
check('REST 실시간 좌표에는 나이를 붙이지 않는다',
  /stale: \(!real \|\| !liveXy\) &&/.test(src) && /ageMinutes: \(!real \|\| !liveXy\) &&/.test(src), true);

console.log('\n[네 갈래가 모두 같은 좌표를 본다]');
// 같은 질문에 채널마다 다른 답을 하면, 어느 쪽이 맞는지 아무도 모른다.
const consumers = {
  '오더상세 API(routes/orders.js)': read('routes/orders.js'),
  '공개 추적 페이지(routes/driverTracking.js)': read('routes/driverTracking.js'),
  '고객 통보(lib/kakaoOrderNotify.js)': read('lib/kakaoOrderNotify.js'),
  '상담 챗봇(lib/mcpDispatchAgent.js)': read('lib/mcpDispatchAgent.js'),
};
Object.entries(consumers).forEach(([label, code]) => {
  check(`${label}가 공용 모듈을 쓴다`, /driverLocation'\)|driverLocationLib\(\)/.test(code) && /loadForOrder\(/.test(code), true);
});
// 챗봇이 MCP의 xy를 그대로 역지오코딩하던 자리 — 그 값이 7km 틀린 곳이었다.
const agent = consumers['상담 챗봇(lib/mcpDispatchAgent.js)'];
check('챗봇이 우리 오더를 찾아 위치를 묻는다', /const loc = ourOrder \? await driverLocationLib\(\)\.loadForOrder\(ourOrder\)/.test(agent), true);
check('챗봇도 보간값이면 위치를 말하지 않는다', /\(synthesized \? null : driver\.xy\)/.test(agent), true);
check('챗봇도 보간값이면 ETA·거리를 버린다',
  /synthesized \? null : formatEtaMinutes/.test(agent) && /synthesized \? NaN : Number\(driver\.distanceKmToPickup\)/.test(agent), true);
// MCP 좌표를 쓸 때만 "기준 시각"을 붙인다(REST는 시각을 주지 않는다).
check('챗봇의 기준 시각은 MCP 좌표에만', /if \(!\(loc && loc\.available\) && driver\.lastFixAt\)/.test(agent), true);

console.log('\n[MCP에는 위치 전용 도구가 없다]');
// 도구 카탈로그에 위치 도구가 생기면 이 주석과 판단을 다시 봐야 한다. 지금은 없다 —
// 위치는 call.list.active 응답에 얹혀 오는 보간값뿐이다(실측 2026-09-08, 도구 12개).
check('위치 도구를 부르지 않는다(없으므로)', /callTool\('(driver|tracking)[^']*'/.test(agent), false);

console.log('\n[옛 설명이 남아 있지 않다]');
// "위치는 MCP 경로에만 있다"가 남아 있으면 다음 사람이 다시 MCP만 본다.
check('MCP 전용이라는 설명이 없다', /위치는 \*\*MCP 경로에만 있다/.test(src), false);
check('정의서 메모에 구현 표시', /TrackingDriver` \| order\.do\. \*\*구현됨\*\*/.test(read('docs/callmaner-external-api-notes.md')), true);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
