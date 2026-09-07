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
const { isPostalRequested } = require('./postalReceipt');

// 우편발송 요청이 기사 쪽에서 빠졌을 때 대신 넣는 문구. 원문 조각을 잘라 옮기지 않는 이유는
// 문장 경계가 없을 때가 있어서다 — 실제 접수문이 "우편발송판매 탁송 신청합니다"처럼
// 붙어 왔고, 그런 원문을 기계로 자르면 "우편발송판매"가 남는다.
const POSTAL_DRIVER_NOTE = '출발지 주소로 우편발송';

// "이 문장에 등기·우편 이야기가 이미 있나"를 보는 잣대.
//
// isPostalRequested를 쓰면 안 된다 — 그 함수는 "발송 **요청**인가"를 보므로 동사가 있어야
// 걸린다(POSTAL_REQUEST_RE). 우리가 붙이는 요약 문구 '출발지 등기'에는 동사가 없어서
// 매번 "아직 없다"로 읽히고, 저장을 반복하면 같은 말이 계속 쌓인다. 실제로 그렇게 만들었다.
function mentionsPostal(text) {
  return /등기|우편/.test(String(text || ''));
}
// 요약(적요1)은 100Byte라 더 짧게 — 짧을수록 예산 다툼에서 살아남는다.
//
// fitToBudget은 뒤 조각부터 버리므로, 이 안내가 길면 자리를 못 얻고 통째로 사라진다.
// 실측: '출발지로 등기발송'(25Byte)은 예산 77Byte에서 4Byte가 모자라 떨어져 나갔다.
// '출발지 등기'(16Byte)면 같은 조건에서 남는다. 앞에 회수서류 문구가 오므로 무엇을 등기로
// 보내는지는 문맥으로 읽힌다.
//
// 앞으로 옮기지 않는 이유: fitToBudget이 앞 조각을 남기니 맨 앞에 두면 반드시 살아남지만,
// 그러면 차키·주차 위치가 밀려 잘린다. 그쪽은 잘리면 기사가 차를 아예 못 가져간다.
// 우선순위는 모델 지시문의 ①차키 ②주차 ③서류 순서를 그대로 따른다.
const POSTAL_BRIEF_NOTE = '출발지 등기';

// 적요1 전체 예산(정의서: 최대 100Byte, 후불접수시 더 짤릴 수 있음).
const MEMO1_MAX_BYTES = 100;
// 차종·차량번호가 맨 앞에 붙는다 — 그만큼 빼고 남는 자리가 요약 예산이다.
const PLATE_SEPARATOR_BYTES = 3; // " / "

function byteLength(s) {
  return Buffer.byteLength(String(s || ''), 'utf8');
}

// 기사 전달사항 맨 앞에 붙는 차량 표시 — "토레스 150두8774".
//
// 왜 저장값에 붙이나(2026-09-07, 사용자 지시): 예전에는 콜마너로 보내는 순간에만 차량번호를
// 앞에 끼웠다(lib/callmaner.js memoWithVehicle). 그래서 관리자 화면의 기사전달사항에는 그
// 값이 없고, 무엇이 실제로 전달됐는지 확인할 방법이 없었다 — 콜마너에만 남는 문자열이었다.
// 저장값에 붙여두면 화면과 전송값이 같아지고, 전송 시점에 따로 조립할 것이 없어진다.
//
// 차종을 함께 붙이는 이유도 같다. 콜마너 payload에는 차종 칸이 아예 없어서 지금까지 기사에게
// 전달된 적이 없었다 — 무슨 차를 가지러 가는지가 기사에게는 번호만큼 중요하다.
function vehiclePrefix(vehicleType, vehicleNumber) {
  const parts = [String(vehicleType || '').trim(), String(vehicleNumber || '').trim()].filter(Boolean);
  return parts.join(' ') || null;
}

// 이미 앞에 붙어 있으면 그대로 둔다 — 수정 저장을 반복할 때마다 쌓이면 적요1이 그것만으로 찬다.
function withVehiclePrefix(text, prefix) {
  const body = String(text || '').trim();
  const head = String(prefix || '').trim();
  if (!head) return body || null;
  if (!body) return head;
  if (body === head || body.startsWith(`${head} `) || body.startsWith(`${head}/`)) return body;
  return `${head} / ${body}`;
}

// 요약이 들어갈 수 있는 자리. 차량 표시를 모르면 넉넉히 잡은 기본값(20바이트)으로 계산한다 —
// "토레스 150두8774"가 19바이트다. 예전에는 번호판만 계산해 11바이트로 잡았는데, 차종이
// 붙으면서 그 값으로는 예산을 넘긴다.
function briefBudgetBytes(prefix) {
  const headBytes = prefix ? byteLength(prefix) : 20;
  return Math.max(20, MEMO1_MAX_BYTES - headBytes - PLATE_SEPARATOR_BYTES);
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
  // 차량 정보의 필드 이름이 경로마다 다르다: 카카오 파서는 {plate, type}
  // (lib/kakaoIntakeParser.js), 웹 쪽 호출과 검사는 {number}를 쓴다. 둘 다 읽는다 —
  // 예전에는 number만 읽어서 카카오 접수는 번호를 못 받고 예산 기본값으로 계산했다.
  // 전송 시점에 번호를 다시 끼우고 있어서 드러나지 않았을 뿐이다.
  const v0 = (parsed && parsed.vehicles && parsed.vehicles[0]) || null;
  const plate = options.plate || (v0 && (v0.number || v0.plate)) || null;
  const vType = options.vehicleType || (v0 && v0.type) || null;
  // 기사 전달사항 맨 앞에 붙일 차량 표시. 여기서 붙여야 저장값과 콜마너로 나가는 값이 같아진다.
  const prefix = vehiclePrefix(vType, plate);
  const budget = briefBudgetBytes(prefix);
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

  // 우편발송(등기)은 **기사가 하는 일**이라 규칙으로 고정한다.
  //
  // LLM에 맡기면 갈린다: 같은 문장이 어떤 때는 driver로, 어떤 때는 company로 간다. 실제로
  // OID2075(2026-09-07)에서는 "출발지 주소로 우편발송"이 업체 전달사항으로 갔고, 그러면
  // 기사는 인수증을 어디로 보내야 하는지 아예 모른다 — 고객은 등기를 못 받는다.
  // 요약(driverBrief)에서는 지금도 빠진다(실측).
  //
  // 이 판정은 이미 결정적으로 있다(postalReceipt.isPostalRequested) — 같은 규칙이
  // postal_requested를 켜고 인수증 업로드 링크를 만든다. 그 값을 여기서도 쓴다.
  // 이 모듈 맨 위 주석의 원칙 그대로다: 뜻이 확정된 값은 규칙으로 나눈다.
  let freeDriverText = free.driver;
  let freeCompanyText = free.company;
  let freeBriefText = free.driverBrief;
  if (isPostalRequested(memo)) {
    // 업체 쪽으로 갔으면 거기서 뗀다 — 양쪽에 두면 상담원이 "누가 하는 일인지"를 다시 묻는다.
    freeCompanyText = joinParts(
      String(freeCompanyText || '').split(' / ').filter((part) => !mentionsPostal(part))
    ) || '';
    if (!mentionsPostal(freeDriverText)) {
      freeDriverText = joinParts([freeDriverText, POSTAL_DRIVER_NOTE]) || POSTAL_DRIVER_NOTE;
    }
    // 요약에도 남긴다. 적요1은 기사가 보는 유일한 칸이다 — 기사 채팅은 관리자가 링크를
    // 문자로 보내야 열리므로(routes/driverChat.js /link) 자동 대체 경로가 아니다.
    if (!mentionsPostal(freeBriefText)) {
      freeBriefText = joinParts([freeBriefText, POSTAL_BRIEF_NOTE]) || POSTAL_BRIEF_NOTE;
    }
  }

  const driverBody = joinParts([...byOption.driver, freeDriverText]);
  const company = joinParts([...byOption.company, freeCompanyText]);
  // 차량 표시는 기사 쪽에만 붙인다. 업체 전달사항(적요2)에는 붙이지 않는다 — 그 칸은 기사에게
  // 보이지 않고, 차량은 오더 자체의 값이라 업체가 그 칸에서 다시 확인할 이유가 없다.
  const driver = withVehiclePrefix(driverBody, prefix);

  // 요약은 기사 쪽만 필요하다. 옵션은 이미 짧으므로 자유 문장 요약 앞에 그대로 붙인다.
  // 요약 예산(budget)은 차량 표시를 뺀 나머지 자리다 — 그래서 예산 검사는 접두어 없는
  // 본문으로 하고, 붙이는 것은 그 뒤에 한다. 접두어까지 포함해 재면 예산을 두 번 빼는 셈이라
  // 정작 실을 수 있는 내용이 줄어든다.
  const briefSource = joinParts([...byOption.driver, freeBriefText || freeDriverText]);
  const briefBody = driverBody && byteLength(driverBody) <= budget
    ? driverBody
    : fitToBudget(briefSource, budget);
  const driverBrief = withVehiclePrefix(briefBody, prefix);

  return {
    driver,
    company,
    driverBrief,
    budget,
    // 확인 카드용 — 옵션(주유·서류·책임보험…)은 카드가 별도 줄로 이미 보여주므로, 여기에
    // 또 넣으면 같은 말이 두 번 나온다. 카드는 자유 문장 부분만 쓴다.
    freeDriver: freeDriverText || null,
    freeCompany: freeCompanyText || null,
  };
}

module.exports = {
  splitIntakeMemo,
  splitOptions,
  describeOption,
  fitToBudget,
  briefBudgetBytes,
  mentionsPostal,
  vehiclePrefix,
  withVehiclePrefix,
  byteLength,
  OPTION_TARGET,
  MEMO1_MAX_BYTES,
};
