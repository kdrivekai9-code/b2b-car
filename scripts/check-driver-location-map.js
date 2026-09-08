// 오더상세 기사 위치 — 두 화면이 같은 것을 싣는가.
//
// 왜 필요한가(실측 2026-09-08, OID2075): 서버는 좌표를 정상으로 돌려주는데
// (available:true, 37.452043/126.909493) 지도가 안 떴다. Next 상세화면이 **카카오 지도
// SDK를 아예 싣지 않았기 때문**이다. 그 컴포넌트 주석은 "오더 폼(RouteMap)이 이미 싣고
// 있다"고 적혀 있었는데, RouteMap은 /orders/new 화면의 것이고 상세화면에는 없다 —
// window.kakao가 영원히 없어 지도를 한 번도 그리지 않았다. EJS 상세화면은 자기 화면에서
// SDK를 싣고 있어 잘 나왔다. 두 화면이 갈려 있었고, 플래그로 갈아 신는 구조라 아무도 몰랐다.
//
// 함께 못 박는 것: 첫 값은 **서버가** 내려준다. 클라이언트가 붙기 전(또는 못 붙을 때)
// "위치를 확인하는 중입니다…"만 남으면, 그게 곧 "위치가 안 나온다"로 보인다.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`}`);
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const ejs = read('views/orders/detail.ejs');
const next = read('src/app/orders/[id]/DriverLocationMap.js');
const page = read('src/app/orders/[id]/page.js');
const routes = read('routes/orders.js');
const lib = read('lib/driverLocation.js');

console.log('[두 화면이 지도 SDK를 각자 싣는다]');
// 한쪽만 싣고 있으면 플래그를 뒤집는 순간 지도가 사라진다 — 실제로 Next 쪽이 그랬다.
check('EJS 상세화면이 SDK를 싣는다', /dapi\.kakao\.com\/v2\/maps\/sdk\.js/.test(ejs), true);
check('Next 상세화면이 SDK를 싣는다', /dapi\.kakao\.com\/v2\/maps\/sdk\.js/.test(next), true);
// autoload=false로 실으면 maps.load 콜백을 받아야 Map을 만들 수 있다. 콜백 없이 쓰면
// window.kakao.maps는 있는데 Map이 없어 조용히 아무것도 안 그린다.
check('Next은 maps.load 콜백을 기다린다', /autoload=false/.test(next) && /kakao\.maps\.load\(/.test(next), true);
// "오더 폼이 싣고 있다"는 옛 가정이 남아 있으면 같은 사고가 돌아온다.
check('옛 가정(RouteMap이 싣는다)이 남아 있지 않다',
  /RouteMap\)이 이미 싣고 있고/.test(next), false);

console.log('\n[첫 값은 서버가 내려준다]');
check('data.json이 위치를 싣는다', /driverLocation: await \(async \(\) => \{/.test(routes), true);
check('페이지가 그 값을 넘긴다', /initial=\{data\.driverLocation \|\| null\}/.test(page), true);
check('컴포넌트가 initial을 첫 상태로 쓴다', /useState\(initial\)/.test(next), true);
// 갱신은 여전히 클라이언트가 30초마다 받는다 — 서버 값만 쓰면 화면이 멈춘다.
check('갱신 폴링은 그대로', /driver-location\.json/.test(next) && /POLL_MS/.test(next), true);

console.log('\n[볼 수 있는 상태의 정의가 한 곳이다]');
// 화면과 서버가 다른 목록을 쓰면 한쪽은 묻고 한쪽은 안 그리는 상태가 생긴다.
check('서버 목록', /TRACKABLE_STATUSES = new Set\(\['기사배정', '운행시작'\]\)/.test(lib), true);
check('Next 목록', /TRACKABLE = new Set\(\['기사배정', '운행시작'\]\)/.test(next), true);
check('EJS 목록', /\['기사배정', '운행시작'\]\.indexOf\(order\.status\)/.test(ejs), true);

console.log('\n[로컬 dev에서 화면이 굳지 않게]');
// Next dev는 자기가 뜬 호스트가 아닌 오리진의 /_next/* 요청을 403으로 막는다. 127.0.0.1로
// 열면 클라이언트 청크가 전부 막혀 서버 렌더 그대로 굳는다(빈 403이라 원인이 안 드러난다).
check('두 주소를 모두 허용한다',
  /allowedDevOrigins: \['127\.0\.0\.1', 'localhost'\]/.test(read('next.config.js')), true);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
