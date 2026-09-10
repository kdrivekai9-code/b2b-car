// 기사 위치가 끊겼을 때 **마지막으로 확인된 위치**로 답하는지, 그리고 그것을 옛 위치라고
// 밝히는지.
//
// 왜 필요한가(실측 2026-09-09, OID2211): 콜마너 TrackingDriver가 배차 단계에서는 좌표를
// 주다가 운행시작 뒤에는 `rc="00"`(정상처리)로 응답하면서 `rs:{lat:"",lng:"",wk_name:""}`를
// 준다. 파라미터 문제가 아니다 — userHp를 지사대표·출발지연락처·기사 안심번호로 바꿔
// 세 번 호출해도 같았고, 같은 순간 OrderInfo는 baecha_status="2"로 정상이었다.
// 그래서 화면에서 위치가 통째로 사라지고 "신호가 아직 잡히지 않았습니다"만 남았다.
//
// 좌표는 그전까지 인메모리 30초 캐시에만 있었다. 서버리스라 인스턴스마다 따로 쌓이고
// 재시작에 사라져서, 신호가 끊기는 순간 마지막 위치까지 함께 잃었다.
//
// 두 가지를 함께 못 박는다:
//  1) 진짜 좌표가 오면 남긴다 → 안 올 때 그 값으로 답한다.
//  2) 그때는 **몇 분 전 기준인지** 화면에 밝힌다. 옛 점을 현재 위치로 보여주면 고객이
//     엉뚱한 곳에서 기다린다 — 이 기능의 값어치는 정직함에 달려 있다.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, ok, got) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : (got ? ` — ${got}` : '')}`);
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const lib = read('lib/driverLocation.js');

console.log('[마지막 좌표를 남기고 되쓴다]');
check('진짜 좌표가 오면 남긴다', /if \(real && liveXy\) rememberFix\(/.test(lib));
check('좌표가 없으면 마지막 좌표를 읽는다', /const lastFix = liveXy \? null : await loadLastFix\(/.test(lib));
check('출처를 last_known으로 표시한다', /'last_known'/.test(lib));
// 배차됐던 증거로도 쓴다 — MCP가 잠깐 답을 못 줘도 화면이 "배차 전"으로 되돌아가면 안 된다.
check('마지막 좌표도 배차 증거로 본다', /const matched = !!real \|\| !!d\.matched \|\| !!lastFix;/.test(lib));

console.log('\n[칸이 없어도 돌아간다]');
// 마이그레이션은 수동이다(이 저장소 관례) — 칸이 없는 DB에서 화면이 죽으면 안 된다.
check('42703을 삼킨다', /UNDEFINED_COLUMN = '42703'/.test(lib)
  && (lib.match(/e\.code !== UNDEFINED_COLUMN/g) || []).length >= 2);
check('마이그레이션 파일이 있다',
  fs.existsSync(path.join(__dirname, '../supabase/migrations/20260909020000_add_driver_last_fix.sql')));
check('IF NOT EXISTS로 더한다',
  /ADD COLUMN IF NOT EXISTS driver_last_lat[\s\S]*driver_last_lon[\s\S]*driver_last_fix_at/
    .test(read('supabase/migrations/20260909020000_add_driver_last_fix.sql')));

console.log('\n[시각을 KST로 읽는다]');
// 우리가 남기는 시각은 KST 문자열이고 Date.parse는 그걸 서버 지역시로 읽는다. 운영은 UTC라
// 9시간이 어긋나 늘 "540분 전"이 된다 — 기사 운행 단계에서 이미 밟은 함정이다(lib/tripSteps.js).
check('시간대 없는 값을 KST로 본다', /- 9 \* 3600 \* 1000/.test(lib));
check('시간대가 붙어 있으면 그대로 믿는다', /\[Zz\]\|\[\+-\]/.test(lib));

console.log('\n[화면과 무관하게 모아둔다]');
// 좌표는 예전엔 누가 화면을 열고 있을 때만 조회됐다. 그래서 "언제부터 위치가 안 오는지"를
// 아무도 몰랐고, 콜마너에 물을 근거가 우리한테 없었다(사용자 확인 2026-09-10: 기사 앱은
// 켜져 있었고 콜마너는 운행완료까지 수집한다 — 그렇다면 이 전문만 비는 것이다).
check('크론이 좌표를 모은다', /driverLocation\.collectFix\(branch, order\)/.test(read('routes/callmanerSync.js')));
// 상태가 안 바뀌면 아래에서 continue한다 — 그 앞이어야 매분 돈다.
const sync = read('routes/callmanerSync.js');
check('상태 비교 continue보다 앞이다',
  sync.indexOf('collectFix') < sync.indexOf("if (info.status === order.callmaner_status"));
check('끊기면 시각을 남긴다', /tracking_driver_empty/.test(lib));
// 매분 남기면 연동오류 목록이 이 한 건으로 덮인다.
check('끊김 기록은 창을 좁게 잡는다', /LOST_LOG_WINDOW_MS/.test(lib) && /age <= LOST_LOG_WINDOW_MS/.test(lib));

console.log('\n[옛 위치라고 밝힌다 — 화면 세 곳]');
// 오더상세(EJS/Next)와 고객 추적 링크. 한쪽만 고치면 채널에 따라 다르게 보인다.
for (const [label, file] of [
  ['오더상세 EJS', 'views/orders/detail.ejs'],
  ['오더상세 Next', 'src/app/orders/[id]/DriverLocationMap.js'],
  ['고객 추적', 'views/driver_track.ejs'],
]) {
  const src = read(file);
  check(`마지막 확인 위치라고 말한다(${label})`, /last_known/.test(src) && /마지막(으로)? 확인/.test(src));
  check(`몇 분 전인지 붙인다(${label})`, /ageMinutes/.test(src));
}

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
