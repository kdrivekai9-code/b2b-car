// 접수 요청사항을 "기사에게 갈 말"과 "업체가 볼 말"로 나눈다.
//
// 왜 나누나: 콜마너 적요1(memo)은 기사 앱의 `기사메모`로 그대로 노출되고, 적요2(memo2)는
// 기사에게 보이지 않는다. 지금까지는 요청사항을 통째로 적요1에 실어서, 기사가 볼 이유가 없는
// 정산·배차 요청까지 기사메모를 채우고 있었다. 적요1은 100Byte라 그만큼 정작 필요한
// 키 위치·서류 안내가 밀려 잘려나간다.
//
// 실측(핸들모빌리티 상담 로그 1,412건 재생): 기사 메모의 24.4%가 100Byte 예산을 넘긴다.
// 잘림은 예외가 아니라 상시 상황이라, 자르는 대신 요약해서 싣는다.
//
// 나누는 방식이 둘인 이유:
//   · 구조화된 옵션(주유·서류·책임보험·출고일·연료잔량)은 이미 뜻이 확정된 값이라 규칙으로
//     나눈다. 여기에 LLM을 쓰면 같은 입력에 다른 답이 나올 수 있어 손해만 크다.
//   · 자유 문장은 "성능장앞 주차, 차키 차안"(기사)과 "고령자셔서 기능설명 가능한 기사님으로
//     배정 부탁"(업체)이 한 덩어리로 섞여 들어온다. 이건 읽어야 갈린다.
const { generateJson } = require('./vertexAi');

// 적요1 전체 예산(정의서: 최대 100Byte, 후불접수시 더 짤릴 수 있음).
const MEMO1_MAX_BYTES = 100;
// 차량번호가 맨 앞에 붙는다(lib/callmaner.js memoWithVehicle) — 그만큼 빼고 남는 자리가 요약 예산이다.
const PLATE_SEPARATOR_BYTES = 3; // " / "

function byteLength(s) {
  return Buffer.byteLength(String(s || ''), 'utf8');
}

// 요약이 들어갈 수 있는 자리. 번호판을 모르면 넉넉히 잡은 기본값(11바이트)으로 계산한다.
function briefBudgetBytes(plate) {
  const plateBytes = plate ? byteLength(plate) : 11;
  return Math.max(20, MEMO1_MAX_BYTES - plateBytes - PLATE_SEPARATOR_BYTES);
}

// 구조화된 옵션을 누가 볼 것인지. 기준은 "그 일을 누가 하는가"다.
//   · refuel/fuelGauge — 기사가 직접 주유한다. 연료 잔량은 그 판단 근거다.
//   · documents — 기사가 현장에서 받아온다.
//   · insurance — 우리가 가입 처리한다. 기사가 할 일이 없다.
//   · releaseDate — 관리·정산 정보다.
const OPTION_TARGET = {
  refuel: 'driver',
  fuelGauge: 'driver',
  documents: 'driver',
  insurance: 'company',
  releaseDate: 'company',
};

// 옵션을 사람이 읽는 짧은 문구로. lib/intakeSummary.js의 describeOptions와 문구가 다른 이유는
// 여기는 100Byte 안에 들어가야 해서다("경유 2만원 주유 부탁드립니다" → "주유 2만원").
function describeOption(key, options) {
  const o = options || {};
  if (key === 'insurance') return o.insurance ? '책임보험 가입' : null;
  if (key === 'releaseDate') return o.releaseDate ? `출고일 ${o.releaseDate}` : null;
  if (key === 'fuelGauge') return o.fuelGauge ? `연료 ${o.fuelGauge}칸` : null;
  if (key === 'documents') return o.documents ? String(o.documents) : null;
  if (key === 'refuel') {
    if (!o.refuel) return null;
    if (typeof o.refuel === 'string') return o.refuel;
    const amount = o.refuel.amount ? `${o.refuel.amount / 10000}만원` : '';
    const label = [o.refuel.fuel, amount].filter(Boolean).join(' ');
    return label ? `주유 ${label}` : (o.refuel.raw || '주유 요청');
  }
  return null;
}

function splitOptions(options) {
  const driver = [];
  const company = [];
  for (const [key, target] of Object.entries(OPTION_TARGET)) {
    const text = describeOption(key, options);
    if (!text) continue;
    (target === 'driver' ? driver : company).push(text);
  }
  return { driver, company };
}

const SPLIT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    driver: { type: 'STRING' },
    company: { type: 'STRING' },
    driverBrief: { type: 'STRING' },
  },
  required: ['driver', 'company', 'driverBrief'],
};

function buildInstruction(briefChars) {
  return `당신은 탁송 접수 요청사항을 분류하는 도구입니다. 고객이 적은 요청사항을 읽고 두 갈래로 나누세요.

driver — 탁송 기사가 현장에서 알아야 하는 것. 예: 차키 위치, 주차 위치, 경비실 전달, 담당자 연락 요청, 받아올 서류, 주유, 차량 상태 확인 요청, 도착 후 연락 방법.
company — 배차·정산 담당자가 볼 것이고 기사에게는 필요 없는 것. 예: 어떤 기사를 배정해달라는 요청, 요금·정산·세금계산서·매입/판매 구분, 사내 처리 방식 요구, 접수 자체에 대한 문의.

규칙:
- 원문의 표현을 최대한 그대로 옮기세요. 없는 말을 지어내지 마세요.
- 어느 쪽인지 애매하면 driver에 넣으세요. 기사가 못 보는 것이 더 위험합니다.
- 해당 내용이 없으면 빈 문자열로 두세요.
- 여러 항목은 " / "로 이어 붙이세요.

driverBrief — driver에 넣은 내용을 기사가 한눈에 보도록 줄인 것.
- 한글 ${briefChars}자 이내로 쓰세요. 이 칸은 글자 수 제한이 빡빡해서 넘치면 잘려 나갑니다.
- 없어지면 안 되는 것부터 남기세요: ① 차키 위치 ② 주차 위치 ③ 서류 ④ 주유 ⑤ 연락 방법.
- 인사말·감사말·중복은 버리고, 조사와 서술어를 줄여 명사구로 쓰세요.
  예) "군포광역센터에 도착하셔서 아래 연락처로 연락주시면 됩니다. 이외 시간은 경비실에 키 맡겨주세요"
      → "도착 후 연락, 시간외 경비실 키 맡김"
- driver가 비어 있으면 driverBrief도 빈 문자열로 두세요.`;
}

// 자유 문장을 나누고 요약한다. 실패하면 null — 호출부가 예전 동작(전부 기사 쪽)으로 떨어진다.
async function classifyFreeText(memo, briefChars) {
  const text = String(memo || '').trim();
  if (!text) return { driver: '', company: '', driverBrief: '' };
  const out = await generateJson(buildInstruction(briefChars), text, SPLIT_SCHEMA, {
    thinking: false,
    op: 'intake_memo_split',
  });
  if (!out || typeof out.driver !== 'string') return null;
  return {
    driver: String(out.driver || '').trim(),
    company: String(out.company || '').trim(),
    driverBrief: String(out.driverBrief || '').trim(),
  };
}

function joinParts(parts) {
  return parts.map((v) => String(v || '').trim()).filter(Boolean).join(' / ') || null;
}

// 예산 안에 자르되 말이 잘린 티가 덜 나게 마지막 조각을 통째로 버린다.
function fitToBudget(text, budget) {
  const s = String(text || '').trim();
  if (!s || byteLength(s) <= budget) return s || null;
  const parts = s.split(' / ');
  const kept = [];
  for (const part of parts) {
    const next = kept.concat(part).join(' / ');
    if (byteLength(next) > budget) break;
    kept.push(part);
  }
  if (kept.length) return kept.join(' / ');
  // 첫 조각조차 안 들어가면 글자 단위로 자른다.
  let out = '';
  for (const ch of s) {
    if (byteLength(out + ch) > budget) break;
    out += ch;
  }
  return out || null;
}

// 접수 요청사항을 나눈다.
//
//   { driver, company, driverBrief }
//     driver      — 기사 전달사항 전체. orders.memo_customer에 그대로 저장한다(우리 화면과
//                   기사 앱은 길이 제한이 없다).
//     company     — 업체 전달사항. orders.memo_billing → 콜마너 적요2.
//     driverBrief — 적요1에 실을 요약. 예산 안에 들어가면 driver와 같다.
//
// LLM이 실패해도 접수를 막지 않는다 — 요청사항 전부를 기사 쪽으로 두는 예전 동작으로 떨어진다.
// 놓쳐서 생기는 손해(기사가 못 봄)가 섞여서 생기는 손해보다 크기 때문이다.
async function splitIntakeMemo(parsed, options = {}) {
  const opts = (parsed && parsed.options) || {};
  const memo = (parsed && parsed.memo) || '';
  const plate = options.plate
    || ((parsed && parsed.vehicles && parsed.vehicles[0] && parsed.vehicles[0].number) || null);
  const budget = briefBudgetBytes(plate);
  // 한글 1자 = UTF-8 3바이트. 모델에게는 글자 수로 말해야 지켜진다.
  const briefChars = Math.max(8, Math.floor(budget / 3));

  const byOption = splitOptions(opts);

  let free = { driver: memo.trim(), company: '', driverBrief: '' };
  if (memo.trim()) {
    const classified = options.classify
      ? await options.classify(memo, briefChars).catch(() => null)
      : await classifyFreeText(memo, briefChars).catch((e) => {
        console.error('요청사항 분류 실패 — 전부 기사 전달사항으로 둔다:', e.message);
        return null;
      });
    if (classified) free = classified;
  }

  const driver = joinParts([...byOption.driver, free.driver]);
  const company = joinParts([...byOption.company, free.company]);

  // 요약은 기사 쪽만 필요하다. 옵션은 이미 짧으므로 자유 문장 요약 앞에 그대로 붙인다.
  const briefSource = joinParts([...byOption.driver, free.driverBrief || free.driver]);
  const driverBrief = driver && byteLength(driver) <= budget
    ? driver
    : fitToBudget(briefSource, budget);

  return {
    driver,
    company,
    driverBrief,
    budget,
    // 확인 카드용 — 옵션(주유·서류·책임보험…)은 카드가 별도 줄로 이미 보여주므로, 여기에
    // 또 넣으면 같은 말이 두 번 나온다. 카드는 자유 문장 부분만 쓴다.
    freeDriver: free.driver || null,
    freeCompany: free.company || null,
  };
}

module.exports = {
  splitIntakeMemo,
  splitOptions,
  describeOption,
  fitToBudget,
  briefBudgetBytes,
  byteLength,
  OPTION_TARGET,
  MEMO1_MAX_BYTES,
};
