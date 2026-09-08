// AI 챗봇 화면이 "살아 있음"을 두 방향으로 다루는지 본다 — 세션 유지와 모델 연결.
//
// 무엇을 지키나(격차 목록 docs/ai-intake-next-gap.md의 필수 항목 둘):
//
//   1. **활동 핑.** 고객이 입력하는 동안 세션을 살려둔다. 없으면 답을 쓰는 중에 유휴로
//      판정돼 봇 응대로 돌아가고(routes/chat.js), 화면이 "N분 동안 대화가 없어…"로 바뀐다.
//      고객은 자기가 뭘 잘못했는지 모른다.
//
//   2. **모델 연결 상태.** Next는 SSE 연결 여부(streamOnline)를 "실시간 연결중"으로
//      보여주고 있었다. 그건 **모델이 닿는지와 뜻이 다르다** — 모델이 죽어 있어도 그 문구가
//      그대로 떠서 고객은 정상인 줄 알고 계속 입력한다. 조용히 잘못 알려주는 쪽이라
//      아예 표시가 없는 것보다 나쁘다.
//
// 두 문구·간격을 EJS와 같게 맞췄는지도 본다. 같은 상황에 화면마다 다른 말이 나오면 고객이
// 무엇이 문제인지 판단할 수 없다.
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

const next = read('src/app/orders/ai-intake/AiIntakeClient.js');
const ejs = read('public/js/ai-intake.js');
const ejsApi = read('public/js/ai-intake-api.js');
const ejsRender = read('public/js/ai-intake-render.js');

console.log('[활동 핑 — 입력 중 세션 유지]');
check('Next가 활동 핑을 부른다', /\/orders\/ai-intake\/activity/.test(next));
// 타이핑마다 부르면 글자 수만큼 요청이 나간다.
check('간격으로 묶는다', /AI_ACTIVITY_PING_INTERVAL_MS/.test(next));
check('간격이 EJS와 같다(15초)',
  /AI_ACTIVITY_PING_INTERVAL_MS = 15000/.test(next) && /AI_ACTIVITY_PING_INTERVAL_MS = 15000/.test(ejs));
// 입력 중에 불러야 의미가 있다 — 보낼 때만 부르면 되묻기에 답을 쓰는 동안 그대로 끊긴다.
check('입력할 때 부른다', /touchAiActivity\(false\)/.test(next));
// 보내는 순간은 가장 확실한 활동이라 간격을 무시한다.
check('보낼 때는 간격을 무시한다', /touchAiActivity\(true\)/.test(next));
check('실패해도 대화를 막지 않는다', /activity[\s\S]{0,200}\.catch\(\(\) => \{\}\)/.test(next));

console.log('\n[모델 연결 상태]');
check('Next가 health를 확인한다', /\/orders\/ai-intake\/health/.test(next));
// SSE 연결 여부와 **다른 값**으로 들고 있어야 한다. 하나로 합치면 다시 같은 착각이 생긴다.
check('SSE 상태와 따로 들고 있다',
  /useState\(\{ state: 'checking'/.test(next) && /streamOnline/.test(next));
check('주기 확인이 있다', /AI_HEALTH_POLL_INTERVAL_MS/.test(next));
check('주기가 EJS와 같다(60초)',
  /AI_HEALTH_POLL_INTERVAL_MS = 60000/.test(next) && /AI_HEALTH_POLL_INTERVAL_MS = 60000/.test(ejs));
// 탭이 안 보이면 물을 이유가 없다.
check('탭이 보일 때만 묻는다', /document\.hidden[\s\S]{0,80}checkAiHealth/.test(next));
// 실패한 직후가 가장 알아야 할 순간이다 — 60초를 기다리면 그동안 "정상"으로 남는다.
check('실패하면 즉시 다시 확인한다', /catch \(e\)[\s\S]{0,400}checkAiHealth\(\)/.test(next));

console.log('\n[문구가 EJS와 같다]');
// 같은 상황에 화면마다 다른 말이 나오면 고객이 무엇이 문제인지 판단할 수 없다.
for (const t of ['AI 연결 정상', 'AI 연결 실패', 'AI 연결 확인중']) {
  check(`"${t}"`, next.includes(t) && ejsRender.includes(t));
}
// 사유별 문장도 같은 것을 쓴다.
check('사유 문구 표를 갖고 있다', /AI_HEALTH_REASON_MESSAGES = \{/.test(next));
for (const r of ['session_missing', 'idle', 'absolute', 'replaced', 'ai_server', 'ai_unavailable']) {
  check(`사유 ${r}`, new RegExp(`${r}:`).test(next) && new RegExp(`${r}:`).test(ejs));
}

console.log('\n[EJS 쪽도 그대로다]');
// 이식하면서 EJS를 건드리지 않았는지. 한쪽만 바뀌면 채널에 따라 다르게 동작한다.
check('EJS가 활동 핑을 부른다', /\/orders\/ai-intake\/activity/.test(ejsApi));
check('EJS가 health를 확인한다', /\/orders\/ai-intake\/health/.test(ejsApi));

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
