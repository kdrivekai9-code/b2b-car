// 계기판 사진에서 주행거리(총 적산거리)를 읽는다.
//
// 콜마너 탁송사진 목록의 계기판 사진(기본 13번째, 지사별 조정 가능)을 제미나이에 넘겨 숫자를
// 받는다. 운행시작 시점과 운행완료 시점 값을 각각 읽고, 그 차이가 그 오더의 주행거리다.
//
// 잘못 읽은 숫자를 고객에게 통보하는 것이 아무것도 안 보내는 것보다 나쁘다. 그래서
//   - 모델에 확신도(confidence)를 함께 요구하고 낮으면 버린다,
//   - 상식적인 범위를 벗어난 값(음수, 과도하게 큰 값)은 버린다,
//   - 완료값이 시작값보다 작으면 버린다(계기판 교체·오인식),
//   - 한쪽이라도 없으면 총 주행거리를 만들지 않는다(통보 문구에서 그 줄이 사라진다).
const { generateJsonWithImages } = require('./vertexAi');

// 승용차 적산거리의 현실적인 상한. 이보다 크면 트립미터/연비 등 다른 숫자를 읽은 것으로 본다.
const MAX_PLAUSIBLE_KM = 2000000;
// 한 오더의 주행거리 상한 — 국내 탁송 한 건이 이 이상일 수 없다. 넘으면 두 사진이 다른
// 차량이거나 오인식이다.
const MAX_TRIP_KM = 3000;
const MIN_CONFIDENCE = 0.6;
const FETCH_TIMEOUT_MS = 15000;

const ODOMETER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    // 계기판에 보이는 총 적산거리(ODO). 트립(TRIP A/B)이나 연비 숫자와 구분해야 한다.
    odometerKm: { type: 'NUMBER' },
    // 숫자를 확실히 읽었는지 — 흐릿하거나 일부가 가려졌으면 낮게 준다.
    confidence: { type: 'NUMBER' },
    // 왜 그 숫자로 읽었는지(디버깅용, 고객에게는 안 보인다).
    note: { type: 'STRING' },
  },
  required: ['confidence'],
};

const ODOMETER_INSTRUCTION = `당신은 차량 계기판 사진에서 총 적산거리(ODO)를 읽는 도구입니다.

규칙:
- 총 적산거리(ODO, 누적 주행거리)만 읽습니다. TRIP A/B(구간거리), 연비, 주행가능거리, 속도,
  RPM, 시간, 온도는 절대 읽지 마세요.
- 단위가 mile로 표시된 경우에도 숫자만 그대로 주고, note에 "mile"이라고 적으세요.
- 사진에 계기판이 없거나 숫자를 읽을 수 없으면 odometerKm을 비우고 confidence를 0으로 주세요.
- 일부 숫자가 가려졌거나 흐릿해서 확신이 없으면 confidence를 0.5 미만으로 주세요.
- 추측하지 마세요. 확실하지 않으면 낮은 confidence가 정답입니다.

confidence는 0~1 사이 숫자입니다.`;

function plausibleKm(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0 || n > MAX_PLAUSIBLE_KM) return null;
  return Math.round(n);
}

// 외부 링크에서 이미지 바이트를 받는다. lib/kakaoOrderPhotos.js의 fetchImage와 같은 방식이지만
// 그쪽은 카카오 업로드 전용 모듈이라(순환 참조를 피하려고) 여기 따로 둔다.
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

// 사진 한 장에서 주행거리를 읽는다. 실패·불확실은 모두 null이다 — 호출부가 "못 읽었다"와
// "0km"를 구분할 수 있어야 한다(0km를 고객에게 통보하면 안 된다).
async function readOdometerKm(url, options = {}) {
  const fetchOne = options.fetchImage || fetchImage;
  const generate = options.generate || generateJsonWithImages;

  const got = await fetchOne(url);
  // 링크가 죽었거나 아직 사진이 안 올라온 경우다 — 모델 탓이 아니므로 나중에 다시 시도할 수
  // 있게 표시한다(모델이 못 읽은 것은 같은 사진을 다시 읽어도 결과가 같아 재시도 대상이 아니다).
  if (!got.ok) return { km: null, reason: got.error, retryable: true };

  let out;
  try {
    out = await generate(
      ODOMETER_INSTRUCTION,
      '이 계기판 사진의 총 적산거리(ODO)를 읽어주세요.',
      [{ buffer: got.buffer, mimeType: got.contentType }],
      ODOMETER_SCHEMA,
      // 숫자를 정확히 읽어야 하는 추출 작업이라 thinking을 끄지 않는다(vertexAi.js 주석 참고).
      { timeoutMs: options.timeoutMs, op: 'odometer_ocr' }
    );
  } catch (e) {
    return { km: null, reason: `계기판 인식 실패: ${e.message}` };
  }

  const confidence = Number(out && out.confidence);
  if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) {
    return { km: null, reason: `확신도 부족(${Number.isFinite(confidence) ? confidence : '없음'})`, note: out && out.note };
  }
  const km = plausibleKm(out && out.odometerKm);
  if (km === null) {
    return { km: null, reason: `값이 계기판 숫자로 보이지 않음(${out && out.odometerKm})`, note: out && out.note };
  }
  return { km, confidence, note: out && out.note };
}

// 시작·완료 값으로 총 주행거리를 만든다. 둘 중 하나라도 없거나 앞뒤가 뒤집혔거나 비현실적으로
// 크면 null — 그 경우 통보 문구에서 주행거리 줄만 빠지고 나머지는 정상 발송된다.
function computeDistance(startKm, endKm) {
  const a = plausibleKm(startKm);
  const b = plausibleKm(endKm);
  if (a === null || b === null) return null;
  const diff = b - a;
  if (diff < 0 || diff > MAX_TRIP_KM) return null;
  return diff;
}

module.exports = {
  readOdometerKm,
  computeDistance,
  plausibleKm,
  fetchImage,
  MIN_CONFIDENCE,
  MAX_TRIP_KM,
  MAX_PLAUSIBLE_KM,
  ODOMETER_SCHEMA,
};
