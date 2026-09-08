// 로그인 없이 여는 공개 링크가 **우리 도메인**을 가리키는가.
//
// 왜 필요한가(실측 2026-09-08): 같은 기본 주소가 세 곳에 흩어져 있었고 그중 하나가 틀려 있었다.
// lib/driverLocation.js가 'https://b2b-car.vercel.app'을 쓰고 있었는데 그 도메인은 우리 것이
// 아니다 — 같은 시각 확인에서 /login이 404이고 우리 앱과 무관한 페이지가 응답했다.
// 운영 주소는 'https://b2bcarkr.vercel.app'이다(/login 200, 우리 CSS·JS 그대로).
//
// 그 값으로 만들어지는 것이 **고객에게 보내는 링크**다 — 기사 위치 추적(/track/:token),
// 영수증 업로드(/r/:token), 사진 모아보기(/photos/:token). 환경변수(PUBLIC_BASE_URL)가 비어
// 있는 곳에서는 고객이 남의 페이지를 받는다. 다행히 추적 링크가 나간 이력은 0건이었다.
//
// 그래서 기본값을 한 곳(lib/publicUrl.js)에만 두고, 다른 곳에 다시 적히지 않는지 여기서 본다.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`}`);
}

const { publicBaseUrl, DEFAULT_PUBLIC_BASE_URL } = require('../lib/publicUrl');

console.log('[기본 주소는 한 곳에서만 온다]');
check('기본값이 운영 주소', DEFAULT_PUBLIC_BASE_URL, 'https://b2bcarkr.vercel.app');
// 환경변수가 있으면 그것을 쓴다(미리보기 배포·자체 도메인).
const saved = process.env.PUBLIC_BASE_URL;
process.env.PUBLIC_BASE_URL = 'https://example.test/';
check('환경변수가 우선', publicBaseUrl(), 'https://example.test');
process.env.PUBLIC_BASE_URL = '   ';
check('빈 값이면 기본값', publicBaseUrl(), DEFAULT_PUBLIC_BASE_URL);
if (saved === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = saved;

console.log('\n[다른 곳에 도메인을 다시 적지 않는다]');
// 코드에 도메인을 직접 적으면 한 곳만 고쳐지고 나머지는 조용히 남는다 — 그게 이 사고였다.
const DIRS = ['lib', 'routes', 'src', 'views', 'public/js'];
const offenders = [];
function walk(dir) {
  const abs = path.join(__dirname, '..', dir);
  if (!fs.existsSync(abs)) return;
  for (const name of fs.readdirSync(abs)) {
    const rel = path.join(dir, name);
    const full = path.join(__dirname, '..', rel);
    if (fs.statSync(full).isDirectory()) { walk(rel); continue; }
    if (!/\.(js|ejs)$/.test(name)) continue;
    if (rel === path.join('lib', 'publicUrl.js')) continue; // 기본값의 집
    const src = fs.readFileSync(full, 'utf8');
    src.split('\n').forEach((line, i) => {
      // **문자열 안에 적힌 도메인만** 잡는다. 주석에는 사고 경위를 적어둬야 하고(여러 줄
      // 주석의 이어지는 줄은 접두사가 없어 주석인지 구분할 수 없다), 코드가 링크를 만들 때는
      // 반드시 따옴표 안에 들어간다 — 그것만 문제다.
      if (/['"`]https?:\/\/[^'"`]*vercel\.app/.test(line)) {
        offenders.push(`${rel}:${i + 1} ${line.trim().slice(0, 70)}`);
      }
    });
  }
}
DIRS.forEach(walk);
if (offenders.length) offenders.forEach((o) => console.log('       ' + o));
check('코드에 박힌 배포 도메인', offenders.length, 0);

console.log('\n[공개 링크가 그 주소를 쓴다]');
const dl = require('../lib/driverLocation');
const pr = require('../lib/postalReceipt');
check('기사 위치 추적 링크', dl.trackingLink({ tracking_token: 'tok' }), `${DEFAULT_PUBLIC_BASE_URL}/track/tok`);
check('영수증 업로드 링크', pr.receiptUploadUrl('tok'), `${DEFAULT_PUBLIC_BASE_URL}/r/tok`);
// 통보 모듈도 같은 함수를 쓴다(사진 모아보기 링크).
const notifySrc = fs.readFileSync(path.join(__dirname, '../lib/kakaoOrderNotify.js'), 'utf8');
check('통보 모듈이 공용 함수를 쓴다', /require\('\.\/publicUrl'\)/.test(notifySrc), true);
check('통보 모듈에 자체 기본값이 없다', /DEFAULT_PUBLIC_BASE_URL = '/.test(notifySrc), false);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
