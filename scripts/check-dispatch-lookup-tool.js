// 조회 질문에 답할 때 반드시 도구를 거치는지, 그리고 대기 안내가 모델 이력을 어지럽히지
// 않는지 본다.
//
// 무엇을 지키나(실사용 2026-09-08): 카카오에서 "내일 예약건 보여줘"가 0건으로 나왔다. 같은
// 시각 웹에서는 같은 질문에 1건(OID2150)이 나왔다. 도구 호출 기록을 시간순으로 맞춰 보니
// 원인이 분명했다 —
//
//   11:56:30 카카오 "내일" → 도구 호출 **없음**, 2초 만에 "없습니다"
//   11:57:49 웹     "내일" → 조회일=2026-09-09로 3회 호출, "1건입니다"
//   12:00:35 카카오 "오늘" → 조회일=2026-09-08로 3회 호출, "1건입니다"
//   12:04:30 카카오 "내일" → 도구 호출 **없음**, 3초 만에 "없습니다"
//
// 카카오 세션은 2026-08-10부터 한 달째 살아 있어서, 모델이 보는 이력에 "내일 예약된 주문은
// 없습니다"라는 자기 옛 답이 반복해 들어 있었다. 모델은 그것을 베끼고 도구를 부르지 않았다.
// 웹은 방문마다 세션이 새로 열려 그런 선례가 없었다.
//
// 그 이력의 절반은 "요청하신 내용을 확인하고 있습니다"라는 대기 안내였다 — 카카오는 말풍선을
// 고칠 수 없어 웹의 점 깜빡임 대신 문장을 보내는데, 그게 chat_messages에 남아 10개 창을
// 채웠다.
//
// 모델도 DB도 부르지 않는다. 판정기와 연결만 본다 — CI에서 돌릴 수 있어야 한다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { isOrderLookupQuestion } = require(path.join(ROOT, 'lib/mcpDispatchAgent'));

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

console.log('[조회 질문으로 본다 — 도구를 강제할 것들]');
[
  '내일 예약건 보여줘',      // 사고 당사자
  '내일 예약건 조회해줘',
  '오늘예약건 보여줘',
  '오늘 접수한 건 조회해줘',
  '진행중인 주문 목록 알려줘',
  '내 오더 현황 확인해줘',
  '예약건 몇 건 있나요',
].forEach((t) => check(`"${t}"`, isOrderLookupQuestion(t) === true));

console.log('\n[조회가 아니다 — 막으면 안 되는 것들]');
// 여기서 잘못 잡으면 멀쩡한 답변이 통째로 막힌다. 못 잡는 것(false negative)은 예전 동작일
// 뿐이지만, 잘못 잡는 것(false positive)은 기능을 죽인다.
[
  '이거 얼마예요?',
  '탁송 접수 어떻게 해요?',
  '접수 방법 알려줘',
  '2번 취소해줘',
  // 변경 요청이 섞인 문장. 여기서 도구를 강제하면 취소 확인 절차가 막힌다 —
  // 그래서 LOOKUP_EXCLUDE_RE에 변경 동사가 들어 있다.
  '주문 취소하고 목록 보여줘',
  '예약시간 변경해줘',
  '기사님 어디쯤 오셨어요?',
  '요금 알려줘',
  '안녕하세요',
].forEach((t) => check(`"${t}"`, isOrderLookupQuestion(t) === false));

console.log('\n[도구 없이 낸 답은 내보내지 않는다]');
{
  const src = fs.readFileSync(path.join(ROOT, 'lib/mcpDispatchAgent.js'), 'utf8');
  // 도구를 한 번도 안 부른 상태에서만 건다 — 도구를 부른 뒤의 답변은 정상이다.
  check('도구 호출이 0건일 때만 본다', /!usedTools\.length && isOrderLookupQuestion\(text\)/.test(src));
  // 한 번은 되돌려 기회를 준다.
  check('한 번 되돌린다', /nudgedForTool = true/.test(src) && /TOOL_REQUIRED_NUDGE/.test(src));
  // 두 번은 안 된다 — 무한 왕복이 된다.
  check('두 번 되돌리지 않는다', /if \(!nudgedForTool\)/.test(src));
  // 그래도 안 부르면 답하지 않는다. 틀린 답을 자신 있게 내보내는 것보다 낫다.
  check('끝내 안 부르면 물러난다', /reason: 'lookup_without_tool'/.test(src));
  check('무슨 일이 있었는지 기록한다', /console\.warn\([^)]*도구를 부르지 않아/.test(src));
  // 재촉 문구는 "이력에서 가져오지 마라"를 분명히 말해야 한다 — 그게 실제 실패 원인이다.
  check('이력 복사를 금지한다', /이전 대화에서 가져오지 마세요/.test(src));
}

console.log('\n[대기 안내가 모델 이력에 안 들어간다]');
{
  const src = fs.readFileSync(path.join(ROOT, 'routes/kakaoConsult.js'), 'utf8');
  check('안내가 상수로 있다', /const DISPATCH_WAIT_NOTICE = /.test(src));
  check('보낼 때 그 상수를 쓴다', /botSay\(session, DISPATCH_WAIT_NOTICE/.test(src));
  check('이력에서 떼어낸다', /while \(body\.startsWith\(DISPATCH_WAIT_NOTICE\)\)/.test(src));
  check('안내만 있는 메시지는 통째로 뺀다', /if \(!body\) continue;/.test(src));

  // 실제로 걸러지는지 — 사고 당시 이력 모양 그대로.
  const NOTICE = '요청하신 내용을 확인하고 있습니다. 잠시만 기다려주세요.';
  const history = [
    { sender: 'user', message: '내일 예약건 보여줘' },
    { sender: 'bot', message: NOTICE },
    { sender: 'bot', message: NOTICE + NOTICE + '내일 예약된 주문은 없습니다.' },
    { sender: 'user', message: '오늘예약건 보여줘' },
    { sender: 'bot', message: '오늘 예약된 주문은 총 1건입니다.' },
  ];
  const cleaned = [];
  for (const row of history) {
    if (row.sender !== 'bot') { cleaned.push(row); continue; }
    let body = String(row.message || '');
    while (body.startsWith(NOTICE)) body = body.slice(NOTICE.length);
    body = body.trim();
    if (!body) continue;
    cleaned.push({ ...row, message: body });
  }
  check('안내만 있는 줄이 사라진다', cleaned.length === 4, `${cleaned.length}개`);
  check('붙어 있던 안내를 떼어낸다',
    cleaned.some((r) => r.message === '내일 예약된 주문은 없습니다.'),
    JSON.stringify(cleaned.map((r) => r.message)));
  check('사용자 발화는 건드리지 않는다',
    cleaned.filter((r) => r.sender === 'user').length === 2);
}

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
