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

console.log('\n[배치 — 왼쪽 위치, 오른쪽 업로드 사진]');
// 사용자 지정 2026-09-08. 지도는 가로로 길고 세로가 짧아 폭을 다 쓰고도 허전했고, 사진은
// 그 위에서 따로 한 칸을 먹어 화면이 길어졌다.
check('EJS가 두 섹션을 한 줄에 둔다', /class="detail-pair"/.test(ejs), true);
check('Next가 두 섹션을 한 줄에 둔다', /className="detail-pair"/.test(page), true);
// 순서가 뒤집히면 요청과 반대가 된다(왼쪽이 사진, 오른쪽이 지도).
check('EJS 순서 — 위치가 먼저',
  ejs.indexOf('기사님 위치</h2>') < ejs.indexOf('기사 업로드 사진</h2>'), true);
check('Next 순서 — 위치가 먼저',
  page.indexOf('<DriverLocationMap orderId') < page.indexOf('<h2>📷 기사 업로드 사진</h2>'), true);
// 격자(.detail-grid) 안에 두면 왼쪽 칸이 화면 절반이라 좌우로 못 서고 위아래로 접힌다.
check('EJS는 격자 밖에 둔다', ejs.indexOf('class="detail-pair"') > ejs.lastIndexOf('class="detail-grid"'), true);
// 한쪽만 있을 때 남은 하나가 전체 폭을 쓰려면 grid가 아니라 flex여야 한다.
const css = read('public/css/style.css');
check('flex+wrap으로 접힌다', /\.detail-pair\{display:flex;flex-wrap:wrap/.test(css), true);
check('안쪽 갤러리가 칸을 밀지 못한다', /\.detail-pair > \*\{flex:1 1 320px;min-width:0;\}/.test(css), true);

// 세로 1.5배(280 → 420). 두 화면이 같은 값이어야 한다 — 한쪽만 고치면 플래그에 따라 높이가 다르다.
check('EJS 지도 높이 420', /id="driverLocMap"[^>]*height:420px/.test(ejs), true);
check('Next 지도 높이 420', /ref=\{boxRef\}[\s\S]{0,90}height: 420/.test(next), true);

console.log('\n[기사 위치는 사진 권한과 무관하다]');
// 예전에는 위치 블록이 canViewPhotos 안에 중첩돼 있어, 사진 열람이 막힌 고객은 지도도 못 봤다.
// 주석에는 "고객도 본다"고 적혀 있었는데 실제로는 아니었다.
// 위치 칸이 열리는 조건과, 그 칸에 이르는 길에 사진 권한 검사가 끼어 있지 않은지를 본다.
const toMap = ejs.slice(ejs.indexOf('class="detail-pair"'), ejs.indexOf('id="driverLocMap"'));
check('위치 칸은 상태로만 열린다', /<% if \(showDriverLoc\) \{ %>/.test(toMap), true);
check('가는 길에 사진 권한 검사가 없다', /canViewPhotos/.test(toMap), false);
// 사진 칸은 여전히 권한을 본다(청구·증빙 사진이라 권한이 있어야 한다).
check('사진 칸은 권한을 본다',
  /<% if \(canViewPhotos\) \{ %>[\s\S]{0,200}기사 업로드 사진/.test(ejs), true);

console.log('\n[로컬 dev에서 화면이 굳지 않게]');
// Next dev는 자기가 뜬 호스트가 아닌 오리진의 /_next/* 요청을 403으로 막는다. 127.0.0.1로
// 열면 클라이언트 청크가 전부 막혀 서버 렌더 그대로 굳는다(빈 403이라 원인이 안 드러난다).
check('두 주소를 모두 허용한다',
  /allowedDevOrigins: \['127\.0\.0\.1', 'localhost'\]/.test(read('next.config.js')), true);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
