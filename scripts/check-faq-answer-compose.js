// FAQ 문의 화면이 찾은 지식 항목을 "정리해서" 답하는지, 그리고 **지어내지 않는지** 본다.
//
// 왜 필요한가(사용자 지적 2026-09-14): 이 화면은 검색 결과를 그대로 뿌렸다 — `[카테고리] 원문`이
// 최대 3개, 각각 따로. 고객이 그 중 어느 줄이 자기 질문의 답인지 직접 골라 읽어야 했다.
//
// 정리를 붙이면서 생기는 위험은 하나다: **모델이 없는 사실을 지어내는 것.** 고객에게 그대로
// 나가는 안내라, 지어낸 문장은 원문을 보여주는 것보다 나쁘다. 그래서 이 검사는 "정리가 되나"
// 보다 **"근거가 없을 때 입을 다무나"**를 더 많이 본다:
//
//   · 검색 결과가 없으면 모델을 아예 부르지 않는다(부르면 빈손으로 답을 만든다)
//   · 모델이 grounded:false라고 하면 정리본을 버린다
//   · 모델이 죽거나 늦으면 원문으로 되돌아간다 — FAQ가 통째로 먹통이 되면 안 된다
//
// 모델 호출은 주입해서(generate) 확인한다 — 네트워크도 DB도 안 쓰므로 CI에서 돌고, 회차마다
// 답이 갈리지도 않는다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { composeKnowledgeAnswer, SYSTEM_INSTRUCTION } = require('../lib/knowledgeAnswer');

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

const MATCHES = [
  { category: '결제', question: '후불 결제 되나요?', answer: '법인 고객은 월 단위 후불 정산이 가능합니다.' },
  { category: '운영시간', question: '주말에도 접수되나요?', answer: '주말·공휴일에도 24시간 접수됩니다.' },
];

// 모델을 대신하는 가짜. 몇 번 불렸는지, 무엇을 받았는지 남긴다.
function stub(result) {
  const calls = [];
  const fn = async (system, userText) => { calls.push({ system, userText }); return result; };
  fn.calls = calls;
  return fn;
}

async function main() {
  console.log('[근거가 없으면 모델을 부르지 않는다]');
  for (const [label, matches] of [['검색 결과가 없을 때', []], ['빈 답변만 있을 때', [{ category: '결제', answer: '   ' }]]]) {
    const gen = stub({ answer: '지어낸 답', grounded: true });
    const got = await composeKnowledgeAnswer('후불 되나요?', matches, { generate: gen });
    check(`${label} — null을 돌려준다`, got === null);
    check(`${label} — 모델을 안 부른다`, gen.calls.length === 0, `호출 ${gen.calls.length}회`);
  }
  {
    const gen = stub({ answer: '답', grounded: true });
    check('질문이 비면 안 부른다', (await composeKnowledgeAnswer('  ', MATCHES, { generate: gen })) === null
      && gen.calls.length === 0);
  }

  console.log('\n[근거가 있으면 정리한다]');
  {
    const gen = stub({ answer: '법인 고객은 월 단위 후불 정산이 가능합니다.', grounded: true });
    const got = await composeKnowledgeAnswer('후불 되나요?', MATCHES, { generate: gen });
    check('정리본을 돌려준다', !!got && got.answer === '법인 고객은 월 단위 후불 정산이 가능합니다.');
    // 고객이 근거를 볼 수 있어야 하고, 잘못된 안내가 나갔을 때 고칠 항목을 찾을 수 있어야 한다.
    check('근거 항목을 함께 준다', !!got && JSON.stringify(got.sources) === JSON.stringify(['결제', '운영시간']));
    check('질문과 항목을 모델에 넘긴다', gen.calls.length === 1
      && /후불 되나요\?/.test(gen.calls[0].userText)
      && /월 단위 후불 정산/.test(gen.calls[0].userText));
  }

  console.log('\n[지어낸 답은 버린다]');
  {
    const gen = stub({ answer: '아마 가능할 겁니다.', grounded: false });
    check('grounded가 false면 버린다', (await composeKnowledgeAnswer('후불 되나요?', MATCHES, { generate: gen })) === null);
  }
  {
    const gen = stub({ answer: '   ', grounded: true });
    check('빈 답변이면 버린다', (await composeKnowledgeAnswer('후불 되나요?', MATCHES, { generate: gen })) === null);
  }
  {
    const gen = stub({ answer: 'ㄱ'.repeat(1201), grounded: true });
    check('원문보다 길어지면 버린다', (await composeKnowledgeAnswer('후불 되나요?', MATCHES, { generate: gen })) === null);
  }
  {
    const boom = async () => { throw new Error('모델 장애'); };
    check('모델이 죽어도 터지지 않는다', (await composeKnowledgeAnswer('후불 되나요?', MATCHES, { generate: boom })) === null);
  }
  {
    const slow = async () => new Promise((r) => setTimeout(() => r({ answer: '늦은 답', grounded: true }), 300));
    check('늦으면 포기한다', (await composeKnowledgeAnswer('후불 되나요?', MATCHES, { generate: slow, timeoutMs: 50 })) === null);
  }

  console.log('\n[지시문이 울타리를 친다]');
  check('준 항목만 쓰라고 못박는다', /지식 항목에 없는 내용은 절대 만들어 쓰지 않는다/.test(SYSTEM_INSTRUCTION));
  check('답할 수 없으면 grounded=false로 말하게 한다', /답할 수 없으면 grounded를 false/.test(SYSTEM_INSTRUCTION));
  check('숫자를 바꾸지 말라고 한다', /그대로 옮긴다/.test(SYSTEM_INSTRUCTION));

  console.log('\n[화면까지 이어진다]');
  const route = read('routes/faq.js');
  check('라우트가 정리본을 부른다', /composeKnowledgeAnswer\(question, matches\)/.test(route));
  // 정리본만 보내면 모델이 죽는 순간 FAQ가 통째로 먹통이 된다.
  check('원문도 함께 내려준다', /res\.json\(\{ matches, answer:/.test(route));
  const client = read('public/js/faq-chat.js');
  check('정리본이 있으면 그걸 보여준다', /if \(data\.answer\)/.test(client));
  check('근거 항목을 함께 보여준다', /참고한 항목/.test(client));
  check('없으면 원문으로 되돌아간다', /data\.matches\.forEach/.test(client));
  // FAQ 화면은 EJS와 Next가 같은 스크립트를 쓴다 — 한쪽만 고치는 사고를 막는다.
  check('두 화면이 같은 스크립트를 쓴다', /\/js\/faq-chat\.js/.test(read('src/app/faq/page.js'))
    && /\/js\/faq-chat\.js/.test(read('views/knowledge_base/faq_chat.ejs')));

  console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('검사 실패:', e.message); process.exit(1); });
