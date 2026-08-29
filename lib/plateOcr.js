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

// 사진이 이 크기보다 작으면 읽지 않는다(모델을 부르지도 않는다).
//
// 실측(2026-08-29, OID1237): 콜마너가 준 탁송사진이 **개별 사진이 아니라 격자 스크린샷**이었다.
// 400×300에 90° 회전이라 번호판이 몇 픽셀뿐인데, 모델은 확신도 0.95로 "228오9847"을 지어냈다
// (접수 번호는 199다9077). 같은 사진에서 계기판 인식은 정직하게 실패(failed)했는데 번호판만
// 자신 있게 틀렸다 — 확신도 기준만으로는 이 실패를 못 막는다.
//
// 폰 카메라 사진은 긴 변이 1000px을 훌쩍 넘는다. 800은 넉넉히 낮춰 잡은 값이다.
const MIN_LONG_EDGE_PX = Number(process.env.PLATE_OCR_MIN_LONG_EDGE || 800);
// 계기판(0.6)보다 높게 잡는다. 여기서 틀리면 "번호판이 다르다"고 관리자에게 알림이 가는데,
// 헛알림이 반복되면 진짜 상이 건까지 무시하게 된다. 애매하면 아예 판정하지 않는 편이 낫다.
const MIN_CONFIDENCE = 0.75;

const PLATE_SCHEMA = {
  type: 'object',
  properties: {
    plate: { type: 'string', description: '번호판 전체 문자열. 못 읽으면 빈 문자열' },
    confidence: { type: 'number', description: '0~1' },
    // 모델은 사진의 문제를 이미 알고 있다 — 위 실측에서 묻지도 않았는데 note에
    // "사진이 회전되어 있습니다"라고 적어왔다. 물어보면 답한다.
    imageIssue: {
      type: 'string',
      enum: ['none', 'collage', 'rotated', 'blurry', 'too_small', 'no_plate'],
      description: '사진 자체의 문제. 문제가 없으면 none',
    },
    note: { type: 'string' },
  },
  required: ['plate', 'confidence', 'imageIssue'],
};

const PLATE_INSTRUCTION = `당신은 차량 사진에서 번호판을 읽는 도구입니다.

규칙:
- 한국 번호판 형식으로 읽습니다. 예: "12가3456", "123가4567", "서울12가3456".
- 지역명(서울/경기 등)이 번호판에 인쇄되어 있으면 함께 적습니다. 없으면 숫자와 한글만 적습니다.
- 번호판이 안 보이거나, 흐려서 한 글자라도 확신할 수 없으면 plate를 빈 문자열로 두고 confidence를 0으로 합니다.
- 추측하지 마십시오. 반쯤 가려진 번호를 메워 넣는 것은 틀린 답보다 나쁩니다.
- 사진에 차가 여러 대면 가장 크고 정면에 있는 차의 번호판을 읽습니다.

imageIssue는 사진 자체의 문제를 알려주는 칸입니다. 하나라도 해당하면 그 값을 적고 plate는 빈 문자열로 둡니다:
- collage   : 여러 장의 사진이 격자로 모여 있는 화면(스크린샷 등). 한 대의 차를 찍은 사진이 아님
- rotated   : 사진이 90도 이상 돌아가 있어 똑바로 볼 수 없음
- blurry    : 번호판 글자가 뭉개져 확신할 수 없음
- too_small : 번호판이 너무 작게 찍혀 글자를 셀 수 없음
- no_plate  : 번호판이 화면에 없음
문제가 없을 때만 none으로 적고 번호를 읽습니다.`;

// 이미지 크기를 헤더에서 읽는다(디코딩하지 않는다). JPEG의 SOF, PNG의 IHDR만 본다.
// 모델을 부르기 전에 걸러내는 것이 목적이라 실패하면 null을 주고 검사를 건너뛴다.
function imageSize(buffer) {
  if (!buffer || buffer.length < 24) return null;
  // PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // JPEG
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let i = 2;
    while (i < buffer.length - 9) {
      if (buffer[i] !== 0xFF) { i += 1; continue; }
      const marker = buffer[i + 1];
      // SOF0/1/2 (baseline·extended·progressive)에 크기가 들어 있다.
      if (marker >= 0xC0 && marker <= 0xC2) {
        return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
      }
      if (marker === 0xD8 || marker === 0xD9) { i += 2; continue; }
      const len = buffer.readUInt16BE(i + 2);
      if (!Number.isFinite(len) || len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

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

  // 너무 작은 사진은 모델을 부르지 않는다 — 공짜로 걸러지고, 무엇보다 이 크기에서는
  // 모델이 "확신 있게 틀린" 답을 준다(위 MIN_LONG_EDGE_PX 주석의 실측).
  const size = imageSize(got.buffer);
  if (size) {
    const longEdge = Math.max(size.width, size.height);
    if (longEdge < MIN_LONG_EDGE_PX) {
      return {
        plate: null,
        reason: `사진이 너무 작음(${size.width}x${size.height}, 긴 변 ${MIN_LONG_EDGE_PX}px 미만)`,
        size,
      };
    }
  }

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

  // 사진 자체에 문제가 있으면 번호를 읽었다 해도 믿지 않는다.
  const issue = String((out && out.imageIssue) || '').trim();
  if (issue && issue !== 'none') {
    return { plate: null, reason: `사진 문제(${issue})`, imageIssue: issue, note: out && out.note };
  }

  const confidence = Number(out && out.confidence);
  if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) {
    return { plate: null, reason: `확신도 부족(${Number.isFinite(confidence) ? confidence : '없음'})`, note: out && out.note };
  }
  const raw = String((out && out.plate) || '').trim();
  if (!raw) return { plate: null, reason: '번호판을 찾지 못함', note: out && out.note };
  // 모델이 형식에 안 맞는 문자열을 준 경우(설명 문장 등)는 버린다.
  if (!plateKey(raw)) return { plate: null, reason: `번호판 형식이 아님(${raw})`, note: out && out.note };

  return { plate: raw, confidence, imageIssue: issue || 'none', note: out && out.note };
}


// 상이 판정 전용 — 두 번 읽어 **같은 번호가 나올 때만** 믿는다.
//
// 왜: 확신도와 이미지 검사를 통과해도 모델이 지어낼 수 있다. 지어낸 값은 호출마다 흔들리는 반면
// 실제로 읽은 값은 안정적이다. 상이는 관리자에게 알림이 가는 판정이라, 그 한 가지에만 호출을
// 한 번 더 쓸 값어치가 있다(일치할 때는 두 번째 호출을 하지 않는다 — 대부분이 일치다).
async function readPlateConfirmed(url, registered, options = {}) {
  const first = await readPlate(url, options);
  if (!first.plate) return { ...first, confirmed: false };

  const same = comparePlates(registered, first.plate);
  // 접수 번호와 같으면 그대로 믿는다. 헛알림 위험이 없는 방향이라 재확인이 필요 없다.
  if (same !== false) return { ...first, confirmed: true };

  const second = await readPlate(url, options);
  if (!second.plate) {
    return { plate: null, reason: `재확인 실패(${second.reason || '읽지 못함'})`, confirmed: false };
  }
  if (plateKey(second.plate) !== plateKey(first.plate)) {
    // 두 번 읽었는데 다른 답이 나왔다 = 읽은 게 아니라 지어낸 것이다.
    return {
      plate: null,
      reason: `두 번 읽은 값이 다름(${first.plate} / ${second.plate}) — 인식을 믿을 수 없음`,
      confirmed: false,
    };
  }
  return { ...second, confirmed: true };
}

module.exports = {
  readPlateConfirmed, readPlate, comparePlates, plateKey, imageSize, MIN_CONFIDENCE, MIN_LONG_EDGE_PX };
