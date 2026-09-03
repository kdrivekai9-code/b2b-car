// 실비 영수증 사진에서 금액을 읽는다.
//
// 왜 필요한가: 기사가 주유·세차·주차에 쓴 돈은 접수 때 알 수 없다. "주유 가득"은 금액이
// 아니라 지시라서, 영수증이 올라와야 얼마인지 정해진다. 그 숫자를 사람이 손으로 옮겨 적으면
// 오더 수만큼 일이 늘고 오타가 청구로 나간다.
//
// 잘못 읽은 금액이 그대로 청구되는 것이 아무것도 안 읽는 것보다 나쁘다. 그래서
//   - 확신도가 낮으면 버린다(사람이 넣게 남겨둔다),
//   - 상식 밖 금액은 버린다,
//   - 고객이 금액을 정해둔 건은 **일치할 때만** 자동으로 넣고, 다르면 상담원에게 알린다.
//     "3만원어치 주유"라고 했는데 5만원 영수증이 오면 그건 판단이 필요한 일이지
//     자동으로 넘길 일이 아니다.
const { generateJsonWithImages } = require('./vertexAi');

// 실비 영수증의 현실적인 상한. 이보다 크면 사업자번호·카드번호 같은 다른 숫자를 읽은 것이다.
const MAX_PLAUSIBLE_AMOUNT = 3000000;
const MIN_CONFIDENCE = 0.6;
const FETCH_TIMEOUT_MS = 15000;

// 고객이 정한 금액과 영수증이 이만큼까지 차이 나면 같은 것으로 본다.
// 부가세 반올림이나 리터당 단가 끝자리로 몇 십 원이 갈리는 일이 있어 딱 맞기를 요구하지 않는다.
// 그보다 크면 사람이 봐야 한다.
const AMOUNT_TOLERANCE_WON = 100;

const RECEIPT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    // 실제로 결제한 총액(원). 공급가액이 아니라 합계다.
    amount: { type: 'NUMBER' },
    // 무엇을 산 영수증인지 — 주유·세차·주차 중 무엇으로 보이는지.
    kind: { type: 'STRING', enum: ['fuel', 'charge', 'wash', 'parking', 'other'] },
    // 상호명. 상담원이 눈으로 확인할 때 쓴다.
    merchant: { type: 'STRING' },
    // 영수증에 찍힌 날짜(YYYY-MM-DD). 못 읽으면 비운다.
    paidOn: { type: 'STRING' },
    confidence: { type: 'NUMBER' },
    // 사진이 영수증이 아니거나 읽을 수 없는 상태면 그 이유.
    imageIssue: { type: 'STRING', enum: ['none', 'not_receipt', 'too_blurry', 'cropped', 'too_dark'] },
    note: { type: 'STRING' },
  },
  required: ['confidence', 'imageIssue'],
};

const RECEIPT_INSTRUCTION = `당신은 영수증 사진에서 결제 총액을 읽는 도구입니다.

규칙:
- **실제 결제한 합계 금액**만 읽습니다. 공급가액, 부가세, 할인 전 금액, 포인트 적립액,
  잔액, 단가(리터당 가격), 수량은 절대 읽지 마세요.
- "합계", "총액", "결제금액", "받은금액" 같은 항목을 우선합니다.
- 숫자만 주세요. 쉼표와 "원"은 빼고 정수로 주세요.
- 사업자등록번호, 카드번호, 승인번호, 전화번호는 금액이 아닙니다.
- 영수증이 아니거나(차량 사진, 화면 캡처 등) 글자를 읽을 수 없으면
  amount를 비우고 confidence를 0으로, imageIssue를 알맞게 채우세요.
- 흐릿하거나 잘려서 합계가 안 보이면 추측하지 마세요. 못 읽었다고 하는 편이 낫습니다 —
  틀린 금액은 그대로 고객에게 청구됩니다.
- kind는 영수증 내용으로 판단합니다: 주유소/충전소는 fuel 또는 charge, 세차장은 wash,
  주차장은 parking, 판단이 안 되면 other.`;

function normalizeAmount(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n <= 0 || n > MAX_PLAUSIBLE_AMOUNT) return null;
  return n;
}

// 사진 한 장에서 금액을 읽는다. 읽지 못하면 amount가 null이고, 이유가 reason에 담긴다 —
// "못 읽었다"와 "영수증이 아니다"는 상담원이 할 일이 다르다.
//
// options.generate는 검사에서 모델을 바꿔 끼우려고 연다(lib/plateOcr.js와 같은 방식).
async function readReceipt(imageUrl, options = {}) {
  const generate = options.generate || generateJsonWithImages;
  const out = await generate(
    RECEIPT_INSTRUCTION,
    '이 영수증의 결제 총액을 읽어주세요.',
    RECEIPT_SCHEMA,
    { images: [imageUrl], timeoutMs: options.timeoutMs || FETCH_TIMEOUT_MS, op: 'receipt_ocr' }
  ).catch((e) => {
    console.error('영수증 판독 실패:', e.message);
    return null;
  });
  if (!out) return { amount: null, reason: 'error', confidence: 0 };

  const issue = String(out.imageIssue || 'none');
  if (issue !== 'none') {
    return { amount: null, reason: issue, confidence: Number(out.confidence) || 0, note: out.note || null };
  }
  const confidence = Number(out.confidence) || 0;
  if (confidence < MIN_CONFIDENCE) {
    return { amount: null, reason: 'low_confidence', confidence, note: out.note || null };
  }
  const amount = normalizeAmount(out.amount);
  if (amount === null) {
    return { amount: null, reason: 'no_amount', confidence, note: out.note || null };
  }
  return {
    amount,
    confidence,
    kind: out.kind || null,
    merchant: String(out.merchant || '').trim() || null,
    paidOn: String(out.paidOn || '').trim() || null,
    note: out.note || null,
    reason: null,
  };
}

// 읽은 금액을 어떻게 처리할지 정한다. 판단을 한 곳에 모으는 이유는, 이 규칙이 돈을 정하기
// 때문이다 — 화면·업로드·알림이 각자 판단하면 어긋난 채로 청구가 나간다.
//
//   'apply'   금액을 그대로 넣는다. 실비정산이고 고객이 정해둔 금액이 없다.
//   'match'   고객이 정한 금액과 같다. 그대로 확정한다.
//   'mismatch' 고객이 정한 금액과 다르다. **넣지 않고** 상담원에게 알린다.
//   'manual'  못 읽었다. 사람이 넣는다.
function decide(charge, ocr) {
  if (!ocr || ocr.amount === null) {
    return { action: 'manual', reason: (ocr && ocr.reason) || 'error', amount: null };
  }
  // 고객이 접수 때 금액을 정해둔 건(주유 "3만원어치"). 그 약속과 다른 금액을 자동으로 넣으면
  // 고객이 동의한 적 없는 돈이 청구된다.
  const expected = Math.round(Number(charge && charge.amount) || 0);
  if (expected > 0) {
    const gap = Math.abs(expected - ocr.amount);
    if (gap <= AMOUNT_TOLERANCE_WON) {
      return { action: 'match', amount: ocr.amount, expected, gap };
    }
    return { action: 'mismatch', amount: ocr.amount, expected, gap };
  }
  return { action: 'apply', amount: ocr.amount, expected: 0, gap: 0 };
}

module.exports = {
  readReceipt, decide,
  MAX_PLAUSIBLE_AMOUNT, MIN_CONFIDENCE, AMOUNT_TOLERANCE_WON,
  RECEIPT_SCHEMA, RECEIPT_INSTRUCTION,
};
