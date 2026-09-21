// 카카오 상담톡 발신이 일시적으로 거부당하면 다시 보내는지 본다.
//
// 왜 필요한가(실사용 지적 2026-09-21): "한동안 대화를 안 하다가 오랜만에 말을 걸면 첫
// 메시지에 아무 반응이 없고, 두 번째부터 답이 온다."
//
// 세션 문제가 아니었다. 세션은 정상으로 찾아 쓰고 봇도 답을 만들어 저장했는데, **고객에게
// 내보내는 발신만** 중계서버가 502로 거부했다. 우리 대화창에는 봇 답변이 그대로 남아 있어
// 관리자 화면은 멀쩡해 보인다 — 그래서 아무도 못 알아챈다.
//
// 기록으로 확인한 것(세션 735, integration_errors):
//   09-17  마지막 대화로부터 4,489분(3.1일) 만의 첫 발신이 502 → 4초 뒤 두 번째는 성공
//   09-14  첫 질문에 대한 발신 두 번이 모두 502 → 고객은 아무것도 못 봄
//
// 중계서버가 돌려준 문구가 "카카오 API 네트워크 오류"라 저쪽의 일시적 실패다. 한 번 보내고
// 포기하면 그 답은 영영 닿지 않는다.
//
// 이 검사가 지키는 것:
//   · 일시적(5xx·네트워크·타임아웃)일 때만 다시 보낸다 — 4xx는 다시 보내도 같고 지연만 는다
//   · 실패는 DB에 남는다 — 콘솔만 남기면 운영에서 "봇이 답을 안 한다"의 원인을 못 찾는다
//   · 발신은 응답 뒤에 돈다 — 재시도 지연이 웹훅 응답을 늦추면 중계서버가 같은 걸 재전송한다
//
// 파일만 읽는다 — DB도 카카오도 안 부르므로 CI에서 돌 수 있다.
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

const lib = read('lib/kakaoConsult.js');
const route = read('routes/kakaoConsult.js');

console.log('[일시적 실패는 다시 보낸다]');
check('재시도 간격이 정해져 있다', /const SEND_RETRY_DELAYS_MS = \[/.test(lib));
// 한 번만 두면 사실상 재시도가 없는 것과 같고, 너무 많으면 같은 말풍선이 여러 번 갈 위험이 는다.
const delays = (lib.match(/const SEND_RETRY_DELAYS_MS = \[([^\]]*)\]/) || [])[1];
const delayList = String(delays || '').split(',').map((x) => Number(x.trim())).filter((n) => n > 0);
check('간격이 2회다', delayList.length === 2, `${delayList.length}회 — ${delays}`);
// 전부 더해도 웹훅 응답에는 영향이 없지만(응답 뒤에 돈다), 상담원 화면에 답이 늦게 뜨는 값이라
// 무한정 늘리면 안 된다.
check('총 대기가 5초를 넘지 않는다', delayList.reduce((a, b) => a + b, 0) <= 5000,
  `${delayList.reduce((a, b) => a + b, 0)}ms`);
check('보내는 자리가 그 값을 쓴다', /for \(let attempt = 0; attempt <= SEND_RETRY_DELAYS_MS\.length/.test(lib));

console.log('\n[일시적인 것만 다시 보낸다]');
check('판정 함수가 있다', /function isTransientSendFailure\(/.test(lib));
check('5xx를 일시적으로 본다', /if \(status >= 500\) return true;/.test(lib));
// 중계서버는 HTTP 200으로 받고 본문 code에 실패를 담아 보내기도 한다 — 그 502가 실제 사례다.
check('본문 code의 5xx도 본다', /code=\(\\d\{3\}\)/.test(lib) && /Number\(m\[1\]\) >= 500/.test(lib));
// 네트워크·타임아웃은 저쪽이 받았는지조차 알 수 없다.
check('네트워크·타임아웃도 다시 보낸다', /catch \(e\) \{[\s\S]{0,260}?transient = true;/.test(lib));
// 4xx(인증·형식)를 다시 보내면 결과는 같고 답만 늦어진다.
check('일시적이지 않으면 즉시 멈춘다', /if \(!transient\) break;/.test(lib));

console.log('\n[실패를 운영이 볼 수 있다]');
// 콘솔만 남기면 "봇이 답을 안 한다"는 문의가 왔을 때 원인을 찾을 길이 없다.
check('발신 실패를 DB에 남긴다',
  /logIntegrationErrorAsync\(\{ source: 'kakao', operation: 'send'/.test(route));
check('그 기록이 세션을 가리킨다', /refType: 'chat_session', refId: session\.id/.test(route));

console.log('\n[재시도가 웹훅 응답을 늦추지 않는다]');
// 응답이 늦으면 중계서버가 같은 이벤트를 재전송하고, 봇이 두 번 답한다(그래서 중복 판정이 있다).
// 발신은 반드시 응답을 보낸 뒤에 돌아야 한다.
//
// **수신 핸들러 안에서** 순서를 본다. 파일 전체에서 두 낱말의 앞뒤만 보면, 뒤에 있는 다른
// 핸들러(/receive/reference)의 짝에 걸려 그대로 통과한다(되돌림 시험에서 샜다).
const recvIdx = route.indexOf("router.post(['/receive', '/receive/message'");
const recvEnd = route.indexOf('\n}));', recvIdx);
const recv = recvIdx >= 0 && recvEnd > recvIdx ? route.slice(recvIdx, recvEnd) : '';
check('수신 핸들러를 찾았다', recv.length > 500, `${recv.length}자`);
const ackAt = recv.indexOf("res.json({ code: 200, message: 'SUCCESS' });\n\n  runAfterResponse");
check('200을 먼저 돌려주고 나서 후처리한다', ackAt > 0,
  '후처리가 응답보다 앞이면 중계서버가 같은 이벤트를 재전송하고 봇이 두 번 답한다');
check('후처리를 waitUntil로 살려둔다', /vercelWaitUntil\(guarded\)/.test(route));

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
