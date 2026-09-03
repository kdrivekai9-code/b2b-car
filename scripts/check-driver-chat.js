// 기사 챗봇 라우트 규칙 검사.
//
// 이 화면은 **로그인이 없다.** 콜마너 앱이 서명한 토큰 하나로 신원이 정해지므로, 가드가
// 한 곳만 헐거워도 아무나 남의 오더와 고객 연락처를 본다. 그리고 그건 화면에 오류로
// 드러나지 않는다 — 더 보이는 실패는 아무도 신고하지 않는다.
require('dotenv').config();

const fs = require('fs');
const path = require('path');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const src = read('routes/driverChat.js');
const server = read('server.js');
const view = read('views/driver/chat.ejs');

console.log('[마운트 위치]');
// requireAuth보다 뒤에 두면 기사가 로그인 화면으로 튕긴다. 실제로 경보 크론에서 겪은 사고다.
const driverAt = server.indexOf("app.use('/driver'");
const authAt = server.indexOf("app.use('/', authRoutes)");
check('로그인 라우터보다 먼저 마운트한다', driverAt > 0 && driverAt < authAt,
  '뒤에 있으면 기사가 로그인 화면으로 302된다');

console.log('\n[세션 격리]');
// 기사 세션이 req.session.user에 들어가면 그 순간 관리자 화면이 열린다.
check('기사는 session.driver에 넣는다', /req\.session\.driver\s*=/.test(src));
check('session.user는 건드리지 않는다', !/req\.session\.user\s*=/.test(src),
  '기사가 관리자 세션을 얻으면 안 된다');
check('requireDriver가 session.driver만 본다', /req\.session\.driver && req\.session\.driver\.id/.test(src));

console.log('\n[남의 오더를 못 본다]');
// 사번으로만 조회한다. 화면이 보낸 order id를 그대로 믿으면 주소창으로 남의 오더가 열린다.
check('오더 조회를 사번으로 건다', /callmaner_driver_sabun = \?/.test(src));
check('지목한 오더도 본인 목록에서만 고른다', /orders\.find\(\(o\) => o\.id === wanted\)/.test(src),
  '목록 밖 id를 그대로 쓰면 남의 오더가 열린다');
// 메시지는 더 위험하다 — 남의 오더에 글이 남는다.
check('메시지도 사번으로 다시 확인한다',
  /INSERT INTO chat_messages[\s\S]{0,600}/.test(src)
    && /WHERE id = \? AND callmaner_driver_sabun = \?/.test(src));

console.log('\n[끝난 건은 보이지 않는다]');
// 완료·취소된 오더의 고객 연락처를 언제까지고 볼 이유가 없다.
check('조회에서 완료·취소를 뺀다', (src.match(/status NOT IN \('완료', ?'취소'\)/g) || []).length >= 2,
  '목록과 메시지 양쪽 모두에서 빼야 한다');

console.log('\n[대화는 오더에 매인다]');
check("channel이 'driver'다", /channel = 'driver'/.test(src) && /'driver', 'bot'/.test(src));
check('오더·기사 쌍으로 찾는다', /order_id = \? AND driver_id = \?/.test(src));
// 유니크 인덱스 충돌은 오류가 아니라 정상이다 — 동시에 두 번 들어온 것뿐이다.
check('동시 진입 충돌을 다시 읽어서 넘긴다', /const again = await find\(\)/.test(src));

const mig = read('supabase/migrations/20260903010000_add_driver_chat.sql');
check('마이그레이션이 유니크 인덱스를 건다',
  /unique index[\s\S]{0,120}chat_sessions\(order_id, driver_id\)[\s\S]{0,60}channel = 'driver'/.test(mig),
  '둘이 생기면 전달사항이 갈린다');
check('사번에도 유니크', /unique index[\s\S]{0,80}drivers\(callmaner_sabun\)/.test(mig));

console.log('\n[기사에게 무엇을 보여주나]');
// 청구 여부와 전달 여부는 별개다 — 요금에 포함이어도 지시가 안 닿으면 차가 빈 채로 간다.
check('할 일에 청구 대상이 아닌 것도 넣는다', /needsReceipt: r\.settle_mode !== 'included'/.test(src));
// 확정되지 않은 지시를 흘리면 채택되지 않았을 때 기사가 헛돈을 쓴다.
check('요청사항 후보는 채택된 것만 보낸다', /decision === 'accepted'/.test(src));
check('요금·청구액은 안 보낸다', !/fare_amount|total_fare/.test(src),
  '기사에게 청구액을 보여줄 이유가 없다');

console.log('\n[모바일 화면]');
check('viewport에 safe-area', /viewport-fit=cover/.test(view));
check('입력칸이 16px 이상', /font:16px|font-size:16px|font:inherit/.test(view),
  'iOS는 16px 미만 입력칸에 자동 확대를 건다');
check('탭 목표가 44px 이상', /min-height:44px/.test(view));
check('홈 인디케이터를 피한다', /safe-area-inset-bottom/.test(view));
check('다크 모드를 그린다', /prefers-color-scheme: ?dark/.test(view));
// 사용자가 넣은 글자가 그대로 HTML이 되면 안 된다.
check('출력을 이스케이프한다', /function esc\(/.test(view) && /&lt;/.test(view));
// SSE는 서버리스 함수 시간 제한에 걸린다 — 설계도의 「한계」 그대로다.
check('SSE를 쓰지 않는다', !/EventSource/.test(view));
check('화면이 숨으면 폴링을 쉰다', /document\.hidden/.test(view));

console.log('\n[링크 만들기 화면]');
// 이 라우터는 requireAuth 앞에 마운트돼 있다(로그인 없는 기사 화면 때문에). 그래서 여기서
// 직접 관리자인지 봐야 한다 — 안 그러면 누구나 아무 사번의 링크를 만들어 남의 오더를 연다.
check('링크 화면에 관리자 가드가 있다', /router\.get\('\/link', requireAdmin/.test(src));
// 이 라우터는 requireAuth 앞에 있어 로그인 리다이렉트가 자동으로 안 걸린다. 로그아웃 상태와
// 역할 부족을 같은 403으로 뭉치면 관리자에게 막다른 길이 된다 — 로그인하라는 말도 없고
// 로그인 화면으로 가지도 않는다. 실제로 그렇게 막혔다(2026-09-03).
check('로그아웃이면 로그인 화면으로 보낸다', /if \(!u\) return res\.redirect\('\/login\?next=/.test(src));
check('역할이 모자라면 어느 계정인지 알려준다', /지금 로그인한 계정은/.test(src));

const auth = read('routes/auth.js');
// 외부 주소를 그대로 쓰면 로그인 직후 남의 사이트로 보내는 통로가 된다.
check('로그인 복귀 주소가 우리 경로로 제한된다', /function safeNext/.test(auth));
check("'//'로 시작하는 것도 막는다", /startsWith\('\/\/'\)/.test(auth),
  '브라우저가 프로토콜 생략 절대주소로 읽어 //evil.com이 외부로 나간다');
check('로그인 후 그 주소로 돌아간다', /safeNext\(req\.body\.next\)/.test(auth));
// 두 로그인 화면이 같이 있어야 한다 — 한쪽만 고치면 플래그에 따라 복귀가 사라진다.
['views/login.ejs', 'src/app/login/page.js'].forEach((f) => {
  check(`${f} — next 칸이 있다`, /name="next"/.test(read(f)));
});
// 주소를 손으로 쳐야만 열리면 아무도 안 쓴다.
['views/partials/header.ejs', 'src/app/_components/AppShell.js'].forEach((f) => {
  check(`${f} — 메뉴에 링크가 있다`, /\/driver\/link/.test(read(f)));
});
check('가드가 admin·지사장만 통과시킨다',
  /role === 'admin' \|\| u\.role === 'branch_manager'/.test(src));
check('비밀키가 없으면 링크를 안 만든다', /driverToken\.isConfigured\(\) \? rows\.map/.test(src),
  '빈 키로 만든 링크는 아무나 위조할 수 있다');
// 문자로 보내는 링크라 앱이 그때그때 만드는 1~5분짜리보다 길어야 하지만, 무한은 아니다.
check('유효기간에 상한이 있다', /Math\.min\(Math\.max\(Number\(req\.query\.ttl\)/.test(src));
check('끝난 건은 목록에 없다', /status NOT IN \('완료', '취소'\)[\s\S]{0,80}ORDER BY o\.id DESC/.test(src));

console.log('\n[토큰]');
const token = read('lib/driverToken.js');
check('HMAC 비교가 상수시간', /timingSafeEqual/.test(token));
check('비밀키가 짧으면 거부', /secret\(\)\.length >= 16/.test(token));

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
