// 영수증 판독과 금액 처리 규칙 검사.
//
// 이 판정이 **돈을 정한다.** 잘못 읽은 금액이 그대로 청구되는 것이 아무것도 안 읽는 것보다
// 나쁘고, 고객이 정한 금액과 다른 값을 자동으로 넣으면 고객이 동의한 적 없는 돈이 나간다.
// 둘 다 화면에는 오류로 드러나지 않는다.
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const ocr = require('../lib/receiptOcr');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const fake = (out) => async () => out;

(async () => {
  console.log('[읽은 값을 거르는 규칙]');
  let r = await ocr.readReceipt('x', { generate: fake({ amount: 45000, confidence: 0.9, imageIssue: 'none' }) });
  check('정상 영수증은 금액이 나온다', r.amount === 45000);
  // 흐릿한 사진을 추측해서 읽으면 그 숫자가 그대로 청구된다.
  r = await ocr.readReceipt('x', { generate: fake({ amount: 45000, confidence: 0.3, imageIssue: 'none' }) });
  check('확신이 낮으면 버린다', r.amount === null && r.reason === 'low_confidence');
  r = await ocr.readReceipt('x', { generate: fake({ amount: 45000, confidence: 0.9, imageIssue: 'not_receipt' }) });
  check('영수증이 아니면 버린다', r.amount === null && r.reason === 'not_receipt');
  // 사업자번호·카드번호를 금액으로 읽은 경우다.
  r = await ocr.readReceipt('x', { generate: fake({ amount: 9999999999, confidence: 0.9, imageIssue: 'none' }) });
  check('상식 밖 금액은 버린다', r.amount === null && r.reason === 'no_amount');
  r = await ocr.readReceipt('x', { generate: fake({ amount: -100, confidence: 0.9, imageIssue: 'none' }) });
  check('음수도 버린다', r.amount === null);
  r = await ocr.readReceipt('x', { generate: async () => { throw new Error('타임아웃'); } });
  check('모델이 죽어도 던지지 않는다', r.amount === null && r.reason === 'error');
  // "못 읽었다"와 "영수증이 아니다"는 상담원이 할 일이 다르다.
  check('이유를 구분해 돌려준다', r.reason !== undefined);

  console.log('\n[금액을 어떻게 쓸지]');
  // 고객이 금액을 안 정한 실비 — 영수증이 곧 금액이다.
  let d = ocr.decide({ amount: 0 }, { amount: 50000 });
  check('실비는 그대로 넣는다', d.action === 'apply' && d.amount === 50000);
  // 고객이 "3만원어치" 라고 정한 건.
  d = ocr.decide({ amount: 30000 }, { amount: 30000 });
  check('요청과 같으면 확정', d.action === 'match' && d.amount === 30000);
  d = ocr.decide({ amount: 30000 }, { amount: 30050 });
  check('몇 십 원 차이는 같은 것으로 본다', d.action === 'match',
    '부가세 반올림·리터 단가 끝자리로 갈린다');
  // 여기가 핵심이다 — 자동으로 넣으면 고객이 동의한 적 없는 돈이 청구된다.
  d = ocr.decide({ amount: 30000 }, { amount: 50000 });
  check('요청과 다르면 넣지 않는다', d.action === 'mismatch');
  check('차이를 함께 알려준다', d.expected === 30000 && d.amount === 50000 && d.gap === 20000);
  d = ocr.decide({ amount: 0 }, { amount: null, reason: 'too_blurry' });
  check('못 읽으면 사람이 넣는다', d.action === 'manual' && d.amount === null);
  check('허용 오차가 100원', ocr.AMOUNT_TOLERANCE_WON === 100);

  console.log('\n[업로드 경로]');
  const driver = read('routes/driverChat.js');
  // 화면이 보낸 id를 그대로 믿으면 남의 오더에 영수증을 붙이고 남의 청구액을 바꾼다.
  check('이 기사 오더인지 다시 확인한다',
    /WHERE e\.id = \? AND o\.callmaner_driver_sabun = \?/.test(driver));
  check('끝난 건에는 못 올린다', /o\.status NOT IN \('완료','취소'\)[\s\S]{0,80}chargeId/.test(driver));
  // 제한이 없으면 어떤 파일이든 올려 공개 URL로 호스팅된다.
  check('이미지만 받는다', /ALLOWED_MIME_TYPES\.includes\(file\.mimetype\)/.test(driver));
  check('불일치는 넣지 않고 알린다',
    /decision\.action === 'mismatch'[\s\S]{0,200}notifyAmountMismatch/.test(driver));
  // 알림에 무엇이 실리는지 — 이게 없으면 상담원이 어느 건인지 못 찾는다.
  ['oid', 'vehicle', 'chargeType', 'expected', 'receipt', 'gap'].forEach((k) => {
    check(`알림에 ${k}가 실린다`, new RegExp(`${k}:`).test(driver));
  });
  // 대화에 남겨야 상담원이 같은 자리에서 보고 나중에 근거를 되짚는다.
  check('대화에 사진을 남긴다', /attachments_json/.test(driver));
  check('실비 줄과 잇는다', /UPDATE order_extra_charges SET chat_message_id = \?/.test(driver));

  console.log('\n[기사 화면]');
  const view = read('views/driver/chat.ejs');
  check('항목마다 버튼', /data-charge="' \+ t\.chargeId/.test(view));
  // 올린 것을 또 올리라고 하면 기사가 같은 일을 두 번 한다.
  check('이미 올린 항목엔 버튼이 없다', /!t\.hasReceipt/.test(view));
  // 포함 항목은 청구하지 않으므로 영수증을 받을 이유가 없다.
  check('청구 대상에만 버튼', /t\.needsReceipt && t\.chargeId/.test(view));
  // 폰 사진은 3~8MB인데 Vercel 본문 상한이 4.5MB다. 원본을 보내면 함수에 닿기도 전에 막힌다.
  check('올리기 전에 줄인다', /function shrink\(/.test(view) && /toBlob/.test(view));
  check('못 읽는 형식은 원본을 보낸다', /img\.onerror[\s\S]{0,80}resolve\(file\)/.test(view));
  check('44px 탭 목표', /min-height:44px/.test(view));

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})();
