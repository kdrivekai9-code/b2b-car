// EJS 챗봇에 있는데 Next 챗봇에 없는 것이 새로 생기지 않는지 본다.
//
// 왜 필요한가(2026-09-11): 플래그를 켠 뒤 실사용에서 넷이 연달아 나왔다 — 좌우 배치, 진단
// 줄, "즉시" 라디오, "새 채팅". 전부 **EJS에 있던 한 줄이 이식에서 빠진 것**이고, 화면은
// 멀쩡히 떠서 오류로 안 잡혔다. 제보 단위로 고치면 계속 나온다.
//
// 그래서 이름이 아니라 **서버와 주고받는 것**을 기준으로 본다. UI 구현이 달라도(React vs
// DOM id) 같은 일을 하면 같은 엔드포인트를 부른다. EJS만 부르는 엔드포인트가 늘어나면
// 그게 곧 이식 누락 후보다.
//
// 지금 남아 있는 차이는 아래 KNOWN에 이유와 함께 적어둔다. 목록에 없는 것이 생기면 실패한다
// — 통과시키려면 채우든지, 왜 안 채우는지를 여기 적든지 해야 한다.
//
// 파일만 읽는다 — CI에서 돌 수 있다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

const ejsFiles = fs.readdirSync(path.join(ROOT, 'public/js')).filter((f) => /^ai-intake.*\.js$/.test(f));
const nextFiles = fs.readdirSync(path.join(ROOT, 'src/app/orders/ai-intake')).filter((f) => f.endsWith('.js'));
const ejsSrc = ejsFiles.map((f) => read(`public/js/${f}`)).join('\n');
// 우측 접수 폼은 /orders/new의 OrderForm을 그대로 재사용한다 — 그 화면이 부르는 엔드포인트의
// 일부(등록 전 precheck 등)가 그 파일에 있으므로 같이 본다. 안 그러면 있는 기능이 없다고 나온다.
const nextSrc = nextFiles.map((f) => read(`src/app/orders/ai-intake/${f}`)).join('\n')
  + '\n' + read('src/app/orders/new/OrderForm.js');
const client = read('src/app/orders/ai-intake/AiIntakeClient.js');

// 두 채널이 부르는 엔드포인트를 같은 방식으로 뽑는다.
const endpoints = (src) => new Set(
  [...src.matchAll(/'(\/[a-z0-9/_.:-]+)'/g)].map((m) => m[1]).filter((u) => u.length > 2)
);

console.log('[엔드포인트 차집합]');
check('양쪽 파일을 찾았다', ejsFiles.length >= 4 && nextFiles.length >= 4,
  `EJS ${ejsFiles.length}개 / Next ${nextFiles.length}개`);

// 남아 있는 차이 — 각 줄의 이유가 docs/ai-intake-next-gap.md에 있다.
const KNOWN = new Map([
  ['/inquiries', '요금 문의 기록을 서버로 옮겼다 — EJS는 만들고(POST /inquiries) 다시 견적을 갱신하는 두 번인데, 서버는 lib/inquiryRecord.js가 한 번의 INSERT로 넣는다'],
  ['/inquiries/', '위와 같다 — 견적 갱신(/inquiries/:id/estimate) 경로다'],
  ['/estimate', '위와 같다'],
  ['/additional-request', '등록 직후 같은 대화로 온 요청사항을 방금 오더에 붙이는 기능. Next 챗봇은 오더를 직접 등록하지 않고 폼의 "오더 등록" 버튼으로 넘기므로 붙일 대상이 없다'],
]);

const ejsOnly = [...endpoints(ejsSrc)].filter((u) => !endpoints(nextSrc).has(u)).sort();
const unexplained = ejsOnly.filter((u) => !KNOWN.has(u));
check('설명 없는 차이가 없다', unexplained.length === 0,
  `${unexplained.join(', ')}\n       EJS만 부른다 — 이식 누락이거나, 이유를 KNOWN에 적어야 한다`);
// 목록이 낡는 것도 막는다. 채워 넣은 뒤 줄을 안 지우면 다음 사람이 헷갈린다.
const stale = [...KNOWN.keys()].filter((u) => !ejsOnly.includes(u));
check('KNOWN에 죽은 줄이 없다', stale.length === 0, `${stale.join(', ')} — 이미 차이가 아니다`);

console.log('\n[확인 요약은 서버 공용 모듈로 만든다]');
// lib/intakeSummary.js는 "세 곳이 각자 만들어 옵션이 갈렸다"는 사고 때문에 만든 모듈이다.
// Next가 자기 안에서 만들면 네 번째 사본이 된다.
check('summary.json을 부른다', /\/orders\/ai-intake\/summary\.json/.test(client));
check('즉시 여부를 같이 보낸다', /reservation_immediate: reservationBasisRef\.current === 'immediate'/.test(client));
// 실패해도 접수가 멈추면 안 된다 — 로컬 폴백이 남아 있어야 한다.
check('실패하면 로컬 계산으로 넘어간다', /return buildOrderSummary\(fields\);/.test(client));
check('시간 제한이 EJS와 같다(2초)',
  /SUMMARY_FETCH_TIMEOUT_MS = 2000/.test(client) && /SUMMARY_FETCH_TIMEOUT_MS = 2000/.test(ejsSrc));
// 확인 문구를 만드는 자리가 로컬 계산을 직접 부르면 그 경로만 갈린다.
const localCalls = (client.match(/buildOrderSummary\(/g) || []).length;
check('로컬 계산을 직접 부르는 곳이 정의·폴백뿐이다', localCalls <= 3, `${localCalls}곳`);

console.log('\n[필수 항목은 서버가 정한다]');
check('fields.json을 부른다', /\/orders\/ai-intake\/fields\.json/.test(client));
check('폴백 목록이 있다', /FALLBACK_REQUIRED_FIELDS = \[/.test(client));
check('빠진 항목을 찾는다', /function firstMissingField\(values\)/.test(client));
// 이게 없으면 필수값이 빈 채로 "등록할까요?"까지 간다(2026-09-11 실측).
check('확인 단계 전에 되묻는다',
  /const missing = firstMissingField\(mergedFields\);[\s\S]{0,600}?setPendingField\(missing\.id\)/.test(client));
check('서버가 준 질문 문구를 쓴다', /missing\.question \|\|/.test(client));
// 선택 항목까지 물으면 대화가 늘어진다.
check('선택 항목은 건너뛴다', /if \(field\.optional\) continue;/.test(client));

console.log('\n[빠른 응답 칩]');
check('칩을 그린다', /className="ai-quick-reply-chip"/.test(client));
check('EJS와 같은 클래스를 쓴다',
  /ai-quick-replies/.test(client) && /ai-quick-replies/.test(read('views/orders/ai_intake.ejs')));
// 되묻는 중에만 뜬다 — 아무 때나 뜨면 대화와 무관한 버튼이 된다.
check('되묻는 중에만 뜬다', /phase !== 'collecting' \|\| !pendingField\) return \[\]/.test(client));
for (const [id, why] of [['origin_contact', '요청자 본인'], ['destination_contact', '출발지와 동일']]) {
  check(`${why} 칩이 있다`, new RegExp(`pendingField === '${id}'`).test(client));
}

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
