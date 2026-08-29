// 번호판 사진 인식 — 접수한 차량번호와 실제 차량이 같은지 확인한다.
//
// 왜 필요한가: 접수 때 받은 차량번호가 틀리면(고객 오기재, 다른 차가 나옴) 그대로 탁송이
// 진행되고 정산·보험·사고 처리가 전부 어긋난다. 기사가 운행시작에 찍는 전면 사진에 번호판이
// 있으니, 그걸 읽어 대조하면 출발 직후에 잡을 수 있다.
//
// 구조는 계기판 인식(lib/odometerOcr.js)과 같다 — 사진 한 장, 스키마 강제, 확신도 미달이면 null.
const { generateJsonWithImages } = require('./vertexAi');
const { normalizePlate, findPlate, PLATE_REGIONS } = require('./vehicleInfo');

// 번호판 몸통(지역명 제외) — "서울12가3456"에서 "12가3456"만 남긴다.
const PLATE_BODY_RE = /(\d{2,3}\s?[가-힣]\s?\d{4})/;

const FETCH_TIMEOUT_MS = 15000;
// 계기판(0.6)보다 높게 잡는다. 여기서 틀리면 "번호판이 다르다"고 관리자에게 알림이 가는데,
// 헛알림이 반복되면 진짜 상이 건까지 무시하게 된다. 애매하면 아예 판정하지 않는 편이 낫다.
const MIN_CONFIDENCE = 0.75;

const PLATE_SCHEMA = {
  type: 'object',
  properties: {
    plate: { type: 'string', description: '번호판 전체 문자열. 못 읽으면 빈 문자열' },
    confidence: { type: 'number', description: '0~1' },
    note: { type: 'string' },
  },
  required: ['plate', 'confidence'],
};

const PLATE_INSTRUCTION = `당신은 차량 사진에서 번호판을 읽는 도구입니다.

규칙:
- 한국 번호판 형식으로 읽습니다. 예: "12가3456", "123가4567", "서울12가3456".
- 지역명(서울/경기 등)이 번호판에 인쇄되어 있으면 함께 적습니다. 없으면 숫자와 한글만 적습니다.
- 번호판이 안 보이거나, 흐려서 한 글자라도 확신할 수 없으면 plate를 빈 문자열로 두고 confidence를 0으로 합니다.
- 추측하지 마십시오. 반쯤 가려진 번호를 메워 넣는 것은 틀린 답보다 나쁩니다.
- 사진에 차가 여러 대면 가장 크고 정면에 있는 차의 번호판을 읽습니다.`;

async function fetchImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `사진을 가져오지 못했습니다 (${res.status})` };
    const buffer = Buffer.from(await res.arrayBuffer());
    return { ok: true, buffer, contentType: res.headers.get('content-type') || 'image/jpeg' };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '사진 다운로드 시간 초과' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// 대조용 표준형. 공백·하이픈을 없애고 지역명을 뗀 "숫자+한글+숫자" 몸통만 남긴다.
//
// 지역명을 떼는 이유: 접수는 "12가3456"으로 받는데 번호판에는 "서울12가3456"이 찍혀 있는
// 경우가 흔하다. 그 차이로 상이 판정을 내면 헛알림만 쌓인다.
function plateKey(value) {
  // findPlate는 문자열이 아니라 { plate, rest }를 돌려준다 — 그대로 쓰면 "[object Object]"가 된다.
  const found = findPlate(String(value || ''));
  const base = found ? found.plate : String(value || '');
  const body = PLATE_BODY_RE.exec(normalizePlate(base).replace(/-/g, ''));
  return body ? body[1] : '';
}

// 두 번호가 같은 차인가. 한쪽이라도 번호판 형식이 아니면 판정하지 않는다(null).
function comparePlates(registered, recognized) {
  const a = plateKey(registered);
  const b = plateKey(recognized);
  if (!a || !b) return null;
  return a === b;
}

// 사진 한 장에서 번호판을 읽는다. 실패·불확실은 모두 plate: null이다 —
// 호출부가 "못 읽었다"와 "다른 번호다"를 반드시 구분해야 한다(뒤쪽만 알림 대상이다).
async function readPlate(url, options = {}) {
  const fetchOne = options.fetchImage || fetchImage;
  const generate = options.generate || generateJsonWithImages;

  const got = await fetchOne(url);
  // 링크가 죽었거나 사진이 아직 안 올라온 경우 — 모델 탓이 아니라 나중에 다시 볼 수 있다.
  if (!got.ok) return { plate: null, reason: got.error, retryable: true };

  let out;
  try {
    out = await generate(
      PLATE_INSTRUCTION,
      '이 사진에서 차량 번호판을 읽어주세요.',
      [{ buffer: got.buffer, mimeType: got.contentType }],
      PLATE_SCHEMA,
      { timeoutMs: options.timeoutMs, op: 'plate_ocr' }
    );
  } catch (e) {
    return { plate: null, reason: `번호판 인식 실패: ${e.message}` };
  }

  const confidence = Number(out && out.confidence);
  if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) {
    return { plate: null, reason: `확신도 부족(${Number.isFinite(confidence) ? confidence : '없음'})`, note: out && out.note };
  }
  const raw = String((out && out.plate) || '').trim();
  if (!raw) return { plate: null, reason: '번호판을 찾지 못함', note: out && out.note };
  // 모델이 형식에 안 맞는 문자열을 준 경우(설명 문장 등)는 버린다.
  if (!plateKey(raw)) return { plate: null, reason: `번호판 형식이 아님(${raw})`, note: out && out.note };

  return { plate: raw, confidence, note: out && out.note };
}

module.exports = { readPlate, comparePlates, plateKey, MIN_CONFIDENCE };
