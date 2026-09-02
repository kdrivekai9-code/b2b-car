// 고객 요청사항에서 부대비용 항목을 찾아낸다 — 접수 때 항목으로 선택되지 않은 것들.
//
// 왜 필요한가: 법인 고객에게는 접수 화면의 부대비용 입력이 아예 보이지 않는다
// (src/app/orders/new/OrderForm.js — 청구 금액 설정이라 요금 칸과 같은 규칙으로 가린다).
// 그래서 고객이 "주유 가득 채워주세요"를 전할 수 있는 곳은 **요청사항 본문뿐이다.**
// 챗봇·상담톡 접수도 마찬가지다. 그 본문을 아무도 읽지 않으면 두 가지가 동시에 새어 나간다.
//   · 기사는 무엇을 해야 하는지 모른 채 간다(차가 빈 채로 도착한다)
//   · 실비를 썼어도 청구할 줄이 없다(그 법인이 실비정산으로 설정해 두었는데도)
//
// 자동으로 줄을 만들지 않는다. 탁송 오더는 고객이 접수해도 콜마너에는 대기로 들어가고,
// 관리자가 확인해야 기사에게 가는 '접수'로 바뀐다(사용자 확정). 그 확인 자리에 후보를
// 올려놓고 사람이 고르게 한다 — LLM이 "세차 부탁"을 잘못 읽어 없는 청구가 생기면
// 되돌리기 어렵다. 놓친 것을 사람이 추가하는 비용보다 잘못 청구한 비용이 훨씬 크다.
const { generateJson } = require('./vertexAi');
const fareSurcharge = require('./fareSurcharge');

// 찾을 항목은 요금설정이 아는 것으로 한정한다 — 여기에 없는 말을 만들어내면 붙일 자리가 없다.
// 도선료·통행료는 뺀다. 기사가 쓰는 돈이 아니라 경로에서 자동으로 정해지는 값이라,
// 요청사항에서 읽어봐야 이미 계산된 값과 부딪히기만 한다.
const DETECTABLE_CODES = ['fuel', 'charge', 'wash', 'parking'];

function detectableItems() {
  return fareSurcharge.EXTRA_COST_ITEMS.filter((it) => DETECTABLE_CODES.includes(it.code));
}

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string', enum: DETECTABLE_CODES },
          // 원문 근거. 관리자가 "왜 이게 잡혔나"를 바로 볼 수 있어야 채택 여부를 판단한다.
          evidence: { type: 'string' },
          // 금액이 본문에 적혀 있으면 함께. "가득"처럼 금액을 모르면 0.
          amount: { type: 'integer' },
        },
        required: ['code', 'evidence'],
      },
    },
  },
  required: ['items'],
};

function buildInstruction() {
  const list = detectableItems().map((it) => `  ${it.code} — ${it.label}`).join('\n');
  return `당신은 탁송 접수의 고객 요청사항을 읽고, 기사가 **돈을 쓰게 되는 일**이 적혀 있는지 찾습니다.

찾을 항목:
${list}

규칙:
- 요청사항에 그 일을 해달라는 뜻이 분명할 때만 고르세요. 애매하면 고르지 마세요.
  잘못 고르면 고객에게 없는 돈이 청구됩니다. 놓치는 것보다 이쪽이 훨씬 나쁩니다.
- evidence에는 그렇게 판단한 **원문 조각을 그대로** 옮기세요. 요약하거나 바꿔 쓰지 마세요.
- 금액이 본문에 적혀 있으면 amount에 숫자만 넣으세요("3만원" → 30000). 없으면 0.
- 이미 끝난 일이나 하지 말라는 말은 고르지 마세요("주유는 하지 마세요", "세차 안 해도 됩니다").
- 기사가 돈을 쓰지 않는 요청(문 잠금, 키 위치, 서류, 연락 방법)은 아무것도 고르지 마세요.
- 해당 없으면 items를 빈 배열로 두세요.`;
}

// 이 법인·지사에서 그 항목이 어떻게 정산되는가.
//   billable  — '제외'(월정산·개별정산). 영수증을 받아 실비로 청구한다.
//   included  — '포함'. 청구하지 않는다. 그래도 **기사에게는 알려야 한다** — 지시가 안 닿으면
//               차가 빈 채로 간다. 청구 여부와 전달 여부는 별개다.
function classifyByFeeSettings(code, feeExtra) {
  const item = fareSurcharge.EXTRA_COST_ITEMS.find((it) => it.code === code);
  if (!item) return null;
  const mode = fareSurcharge.settleModeOf(feeExtra, item.chargeType);
  return {
    code,
    chargeType: item.chargeType,
    label: item.label,
    settleMode: mode,
    billable: mode !== 'included',
  };
}

// 요청사항에서 후보를 뽑는다. 이미 항목으로 선택된 것은 뺀다 — 같은 돈이 두 줄이 되면
// 두 번 청구된다.
//
// options.generate는 검사에서 LLM을 바꿔 끼우려고 연다(lib/plateOcr.js와 같은 방식).
async function detectFromMemo(memo, feeExtra, options = {}) {
  const text = String(memo || '').trim();
  if (!text) return [];

  const already = new Set(
    (options.existingChargeTypes || []).map((t) => String(t || '').trim()).filter(Boolean)
  );

  const generate = options.generate || generateJson;
  const out = await generate(buildInstruction(), text, SCHEMA, { thinking: false, op: 'memo_extra_costs' })
    .catch((e) => {
      // 접수를 막지 않는다. 못 찾은 것은 지금까지와 같은 상태이고, 잘못 만드는 것보다 낫다.
      console.error('요청사항 부대비용 분석 실패(무시):', e.message);
      return null;
    });
  if (!out || !Array.isArray(out.items)) return [];

  const seen = new Set();
  const rows = [];
  out.items.forEach((raw) => {
    const code = raw && raw.code;
    // 스키마 enum이 이미 막지만 한 겹 더 둔다. 모델이 'ferry'를 돌려주면
    // classifyByFeeSettings는 그걸 아는 항목으로 받아들인다 — 도선료는 줄이 아니라
    // orders.ferry_fare_amount에 저장되는 값이라, 줄이 생기면 같은 돈이 두 군데서
    // 집계돼 두 번 청구된다. 스키마를 믿고 넘겼더니 검사가 이걸 잡았다.
    if (!DETECTABLE_CODES.includes(code)) return;
    const info = classifyByFeeSettings(code, feeExtra);
    if (!info) return;
    if (seen.has(info.code)) return; // 같은 항목이 두 번 나오면 한 번만
    if (already.has(info.chargeType)) return; // 이미 선택된 항목은 후보가 아니다
    seen.add(info.code);
    rows.push({
      ...info,
      evidence: String((raw && raw.evidence) || '').trim().slice(0, 200),
      amount: Math.max(0, Math.round(Number(raw && raw.amount) || 0)),
    });
  });
  return rows;
}

// 화면·기사 안내에 쓸 한 줄. 청구 여부에 따라 말이 다르다.
function describe(candidate) {
  if (!candidate) return '';
  const money = candidate.amount ? ` ${candidate.amount.toLocaleString('ko-KR')}원` : '';
  if (!candidate.billable) return `${candidate.label}${money} · 요금 포함(별도 청구 없음)`;
  const mode = candidate.settleMode === 'individual' ? '개별정산' : '월정산';
  return `${candidate.label}${money} · 실비 ${mode} · 영수증 필요`;
}

// 분석해서 오더에 저장한다. 접수 응답을 붙잡지 않도록 호출부가 응답 뒤에 돌린다
// (실측 1.2~5.3초로 들쭉날쭉해서 접수를 기다리게 할 수 없다).
//
// 실패해도 던지지 않는다 — 못 찾은 것은 지금까지와 같은 상태다. 여기서 예외가 새어나가
// 접수가 실패하면 주객이 전도된다.
async function analyzeAndStore(orderId, memo, feeExtra, options = {}) {
  const db = require('../db');
  if (!orderId) return [];
  const candidates = await detectFromMemo(memo, feeExtra, options).catch(() => []);
  try {
    await db.run(
      `UPDATE orders SET memo_extra_json = ?,
        memo_extra_checked_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
       WHERE id = ?`,
      [JSON.stringify(candidates), orderId]
    );
  } catch (e) {
    // 마이그레이션 전이면 컬럼이 없다 — 분석만 못 남길 뿐 접수는 이미 끝났다.
    console.error('요청사항 부대비용 후보 저장 실패(무시):', e.message);
  }
  return candidates;
}

// 저장된 값을 읽는다. 형식이 깨졌거나 컬럼이 없으면 빈 배열 — 화면이 죽으면 안 된다.
function loadFromOrder(order) {
  if (!order || !order.memo_extra_json) return [];
  try {
    const rows = JSON.parse(order.memo_extra_json);
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    return [];
  }
}

// 아직 판단하지 않은 후보만. 채택/기각을 마친 것은 화면에서 사라져야 한다 — 안 그러면
// 다음 사람이 같은 판단을 또 하게 된다. 기록은 남기고 배너에서만 빠진다.
function pendingFromOrder(order) {
  return loadFromOrder(order).filter((c) => !c || !c.decision);
}

module.exports = {
  analyzeAndStore,
  loadFromOrder,
  pendingFromOrder,
  detectFromMemo,
  classifyByFeeSettings,
  describe,
  detectableItems,
  DETECTABLE_CODES,
};
