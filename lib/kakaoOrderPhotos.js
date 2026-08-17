// 오더 사진을 카카오 상담톡 고객에게 보낸다.
//
// Phase 3의 첫 조각. 로그 분석에서 상담원 발화의 61.6%가 사진 관련이었다 — 기사가 올린 인수증·
// 차량 사진을 상담원이 받아서 고객에게 다시 전달하는 일이 대부분이었다. 그 전달을 봇이 한다.
//
// 기획서는 "카카오 3일 보관에서 자체 저장소로 옮기는 작업"도 Phase 3에 넣었는데, 그건 이미
// 끝나 있다 — 기사는 우리 업로드 페이지로 올리고(routes/photoUpload.js), 파일은 Supabase
// Storage 공개 버킷에 남는다(lib/storage.js). 여기서 할 일은 그것을 카카오로 내보내는 것뿐이다.
//
// 카카오는 우리 URL을 그대로 실어주지 않는다. 명세가 "이미지 업로드 API로 업로드한 이미지를
// 사용해야 합니다"라고 못박고 있어서, 파일을 받아 카카오에 다시 올린 뒤 그 URL로 보낸다.
const db = require('../db');
const kakaoConsult = require('./kakaoConsult');
const callmanerPhotos = require('./callmanerPhotos');

// 보낼 사진이 없을 때/권한이 없을 때의 안내는 호출부가 아니라 여기서 정한다 — 같은 상황에
// 화면마다 다른 말을 하면 고객은 무엇이 문제인지 알 수 없다.
const MESSAGES = {
  noPhotos: '아직 등록된 사진이 없습니다. 기사님이 사진을 올리면 바로 보내드리겠습니다.',
  notAllowed: '사진은 상담원을 통해 확인하실 수 있습니다. 상담원을 연결해드릴까요?',
  allFailed: '사진을 전달하는 중 문제가 생겼습니다. 상담원이 확인 후 보내드리겠습니다.',
  noOdometer: '아직 계기판 주행거리가 기록되지 않았습니다. 기사님이 입력하면 바로 알려드리겠습니다.',
  // 두 번째로 물었는데도 없을 때. 같은 말을 반복하면 고객은 방치됐다고 느낀다.
  noPhotosAgain: '사진이 아직 등록되지 않았습니다. 상담원이 기사님께 직접 확인해 보내드리겠습니다.',
  // 링크는 받았는데 아직 열리지 않는 상태(아래 loadPhotosForCustomer 주석 참고). "없다"고 하면
  // 거짓말이고 "오류"라고 하면 고객이 우리 잘못으로 읽는다 — 있는 그대로 아직 준비 중이라고 한다.
  photosNotReady: '사진이 아직 준비 중입니다. 등록이 끝나는 대로 보내드리겠습니다.',
};

// 한 번에 보낼 최대 장수. 사진이 수십 장인 오더도 있는데 전부 보내면 대화창이 묻힌다.
const MAX_PHOTOS_PER_SEND = 5;
const FETCH_TIMEOUT_MS = 15000;

// 사진 요청인지 판정한다. 라우트가 아니라 여기 두는 이유는 검증 스크립트가 같은 정의를 쓰기
// 위해서다 — 라우트 안의 정규식은 떼어내 확인할 방법이 마땅치 않다.
//
// 고객이 사진을 "보내겠다"고 하는 경우는 요청이 아니다. 그때 우리가 사진을 보내면 대화가
// 어긋나고, 고객은 자기가 보낸 사진이 되돌아온 것으로 오해한다.
const PHOTO_REQUEST_RE = /(사진|이미지|인수증|사진첩)/;
const PHOTO_SENDING_RE = /(보내드|보낼게|보낼께|첨부할|올릴게|올릴께|보내겠)/;

function isPhotoRequest(text) {
  const s = String(text || '');
  return PHOTO_REQUEST_RE.test(s) && !PHOTO_SENDING_RE.test(s);
}

// 주행거리 문의("몇 km 뛰었나요", "계기판 얼마예요")인지.
const ODOMETER_REQUEST_RE = /(주행\s*거리|주행km|계기판|킬로수|킬로\s*수|몇\s*키로|몇\s*km|odo)/i;

function isOdometerRequest(text) {
  return ODOMETER_REQUEST_RE.test(String(text || ''));
}

// 기사가 적어둔 계기판 값들로 주행거리를 요약한다.
//
// 값을 사진마다 두었기 때문에(마이그레이션 20260809030000의 이유) 주행거리는 최댓값 − 최솟값이다.
// 한 개뿐이면 뺄 수가 없어서 그 값만 알려준다 — 임의로 0을 상대편으로 두면 주행거리가 계기판
// 숫자 전체가 되어버린다.
function summarizeOdometer(photoRows) {
  const values = (photoRows || [])
    .map((p) => Number(p && p.odometer_km))
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);

  if (!values.length) return { count: 0, text: null };
  const km = (n) => n.toLocaleString('ko-KR');
  if (values.length === 1) {
    return { count: 1, start: values[0], text: `계기판 기록은 ${km(values[0])}km 한 건입니다.` };
  }
  const start = values[0];
  const end = values[values.length - 1];
  return {
    count: values.length,
    start,
    end,
    distance: end - start,
    text: `계기판 ${km(start)}km → ${km(end)}km, 주행거리는 ${km(end - start)}km입니다.`,
  };
}

// 열람 권한은 웹 화면(routes/orders.js)과 같은 규칙을 쓴다. 카카오 고객은 거래처(client)
// 자격으로 보는 것이므로 지사가 client_can_view를 꺼두었으면 봇도 보내지 않는다 — 화면에서는
// 막아놓고 챗봇으로는 나가면 그 설정은 의미가 없다.
async function canCustomerViewPhotos(branchId) {
  if (!branchId) return false;
  const row = await db.get('SELECT client_can_view FROM branch_photo_settings WHERE branch_id = ?', [branchId])
    .catch(() => null);
  return !!(row && row.client_can_view);
}

async function loadOrderPhotos(orderId, limit = MAX_PHOTOS_PER_SEND) {
  return db.all(
    'SELECT id, url, created_at FROM order_photos WHERE order_id = ? ORDER BY id DESC LIMIT ?',
    [orderId, limit]
  ).catch(() => []);
}

// 고객이 어느 시점 사진을 물었는지. 실사용 발화가 대부분 시점을 지정한다 — "탁송출발사진좀
// 확인부탁드립니다", "도착사진 받으셨으면 빠르게 전송 부탁". 지정했는데 반대쪽을 보내면
// 고객은 다시 물어야 한다.
const PHASE_START_HINT_RE = /(출발|운행\s*전|상차|픽업|인수)/;
const PHASE_END_HINT_RE = /(도착|운행\s*후|완료|하차|인도|탁송\s*후)/;

function photoPhaseHint(text) {
  const s = String(text || '');
  // 둘 다 있으면("출발 도착사진이 없네요") 시점을 고르지 않는다 — 아래 기본 규칙을 따른다.
  const start = PHASE_START_HINT_RE.test(s);
  const end = PHASE_END_HINT_RE.test(s);
  if (start === end) return null;
  return start ? callmanerPhotos.PHASE_START : callmanerPhotos.PHASE_END;
}

// 고객에게 보낼 사진을 고른다.
//
// 사진 출처가 둘이다. 기사가 우리 업로드 페이지로 올린 것(order_photos)과, 콜마너로 배차된
// 오더의 탁송사진(order_callmaner_photos)이다. 이 함수가 생기기 전까지 이 경로는 앞의 것만
// 봤는데, 콜마너로 굴러가는 거래처(핸들모빌리티 등)는 order_photos가 늘 비어 있어서 **사진을
// 갖고 있으면서 "아직 없습니다"라고 답했다.** 상담 로그에서 상담원 발화의 60.5%가 사진 전달인
// 거래처가 정확히 그 경우다.
//
// 둘을 합치지 않고 있는 쪽을 쓴다: 한 오더는 우리 기사 앱이나 콜마너 중 한 경로로만 굴러가므로
// 합칠 일이 없고, 만에 하나 둘 다 있으면 같은 차 사진이 두 벌 나간다. 기사 앱 쪽을 우선하는
// 이유는 그게 우리 버킷에 있어 확실히 열리기 때문이다(콜마너 링크는 아래 지연 문제가 있다).
async function loadPhotosForCustomer(orderId, limit = MAX_PHOTOS_PER_SEND, phaseHint = null) {
  const own = await loadOrderPhotos(orderId, limit);
  if (own.length) return { photos: own, source: 'driver', phase: null, total: own.length };

  // 콜마너 사진은 운행전/운행후로 나뉜다. 시점을 지정하지 않았으면 나중 것(운행후)을 먼저 본다 —
  // 고객이 시점을 안 밝히고 묻는 시점은 대개 차가 도착한 뒤다.
  const phases = phaseHint
    ? [phaseHint]
    : [callmanerPhotos.PHASE_END, callmanerPhotos.PHASE_START];
  for (const phase of phases) {
    const rows = await callmanerPhotos.loadPhotos(orderId, phase).catch(() => []);
    if (rows.length) {
      return { photos: rows.slice(0, limit), source: 'callmaner', phase, total: rows.length };
    }
  }
  return { photos: [], source: null, phase: null, total: 0 };
}

function phaseLabel(phase) {
  if (phase === callmanerPhotos.PHASE_START) return '운행전';
  if (phase === callmanerPhotos.PHASE_END) return '운행후';
  return null;
}

// 주행거리는 사진 장수 제한과 무관하게 전부 봐야 한다 — 최댓값·최솟값을 구하는 것이라
// 최근 5장만 보면 출발 계기판이 빠질 수 있다.
async function loadOdometerRows(orderId) {
  return db.all(
    'SELECT odometer_km FROM order_photos WHERE order_id = ? AND odometer_km IS NOT NULL',
    [orderId]
  ).catch(() => []);
}

// 이 대화에서 "사진이 아직 없다"고 답한 횟수.
//
// 사진 재요청을 가려내기 위한 값이다. 기사에게 직접 알릴 방법이 없어서(푸시는 관리자·상담원
// 대상이고 기사에게 보내는 SMS 경로는 없다) 재요청은 상담원을 거쳐야 하는데, 처음 물었을 때부터
// 상담원을 붙이면 자동화 이득이 사라진다 — 기사가 곧 올릴 수도 있다. 두 번째부터 사람을 부른다.
// "아직 없다"와 "아직 준비 중이다" 둘 다 센다 — 고객에게는 같은 상황이라, 한쪽만 세면
// 콜마너 거래처에서는 몇 번을 물어도 상담원이 붙지 않는다.
async function countNoPhotoAnswers(sessionId) {
  const rows = await db.all(
    `SELECT COUNT(*) AS cnt FROM chat_messages
     WHERE session_id = ? AND sender = 'bot' AND (message LIKE ? OR message LIKE ?)`,
    [sessionId, `%${MESSAGES.noPhotos.slice(0, 20)}%`, `%${MESSAGES.photosNotReady.slice(0, 20)}%`]
  ).catch(() => []);
  return Number(rows[0] && rows[0].cnt) || 0;
}

// 주행거리 문의에 답한다. 사진과 같은 열람 권한을 따른다 — 사진은 못 보는데 거기 적힌 숫자는
// 알려주는 건 앞뒤가 맞지 않는다.
async function answerOdometer(order) {
  if (!(await canCustomerViewPhotos(order.branch_id))) {
    return { skipped: 'not_allowed', message: MESSAGES.notAllowed };
  }
  const summary = summarizeOdometer(await loadOdometerRows(order.id));
  if (!summary.count) return { skipped: 'no_odometer', message: MESSAGES.noOdometer };

  const oid = String(order.oid || '').trim();
  return { answered: true, message: `${oid ? `[${oid}] ` : ''}${summary.text}`, summary };
}

function fileNameFromUrl(url, index) {
  const clean = String(url || '').split('?')[0];
  const base = clean.slice(clean.lastIndexOf('/') + 1);
  if (kakaoConsult.ALLOWED_IMAGE_EXT.test(base)) return base;
  return `photo_${index + 1}.jpg`;
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
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// 사진을 카카오에 올려 URL을 모은다. 한 장이 실패해도 나머지는 보낸다 — 명세의 이미지 제한
// (5MB, 가로:세로 비율)에 걸리는 사진이 섞여 있을 수 있는데, 그 한 장 때문에 전부 못 보내면
// 고객은 아무것도 못 받는다.
async function uploadPhotosToKakao(session, photos, options = {}) {
  const upload = options.uploadImage || kakaoConsult.uploadImage;
  const fetchOne = options.fetchImage || fetchImage;

  const uploaded = [];
  const failed = [];
  for (let i = 0; i < photos.length; i += 1) {
    const photo = photos[i];
    const got = await fetchOne(photo.url);
    if (!got.ok) { failed.push({ photo, error: got.error }); continue; }

    const result = await upload(session, got.buffer, fileNameFromUrl(photo.url, i), got.contentType);
    if (!result || !result.ok) { failed.push({ photo, error: (result && result.error) || '업로드 실패' }); continue; }
    uploaded.push(result.url);
  }
  return { uploaded, failed };
}


// 오더 사진을 고객에게 보낸다.
//   { sent: n, total: n } — 보냈다
//   { skipped: '이유', message: '고객에게 할 말' } — 보내지 않았다
async function sendOrderPhotos(session, order, options = {}) {
  const send = options.sendImages || kakaoConsult.sendImages;

  if (!(await canCustomerViewPhotos(order.branch_id))) {
    return { skipped: 'not_allowed', message: MESSAGES.notAllowed };
  }

  const limit = options.limit || MAX_PHOTOS_PER_SEND;
  const picked = await loadPhotosForCustomer(order.id, limit, photoPhaseHint(options.text));
  const { photos, source, phase, total } = picked;
  if (!photos.length) return { skipped: 'no_photos', message: MESSAGES.noPhotos };

  // 여기서부터가 오래 걸린다 — 사진마다 내려받아 카카오에 다시 올린다. 그동안 아무 말이 없으면
  // 고객은 못 알아들은 줄 알고 다음 질문을 덧붙인다. 보낼 사진이 있다는 걸 확인한 뒤에만 알린다
  // (권한이 없거나 사진이 없으면 곧바로 끝나므로 안내가 헛돈다).
  if (options.onStart) await options.onStart(photos.length);

  const { uploaded, failed } = await uploadPhotosToKakao(session, photos, options);
  if (!uploaded.length) {
    // 콜마너 링크는 저장된 뒤 한동안 열리지 않는다(마이그레이션 20260816010000에서 실측 중).
    // 그 구간에서는 한 장도 못 받는 게 정상이라, 장애가 아니라 "아직 준비 중"이라고 답해야 한다.
    // no_photos로 돌려주는 이유: 호출부가 재요청 판정(두 번째부터 상담원 연결)을 그대로 태우게
    // 하기 위해서다 — 고객 입장에서는 "없다"와 구분되지 않는 같은 상황이다.
    if (source === 'callmaner') {
      return { skipped: 'no_photos', message: MESSAGES.photosNotReady, notReady: true, failed };
    }
    return { skipped: 'upload_failed', message: MESSAGES.allFailed, failed };
  }

  const oid = String(order.oid || '').trim();
  const head = oid ? `[${oid}] ` : '';
  const label = phaseLabel(phase);
  const what = label ? `${label} 사진` : '등록된 사진';
  // 몇 장 중 몇 장인지 밝힌다. 일부만 갔는데 그 말을 안 하면 고객은 그게 전부인 줄 안다.
  // total은 이 시점 전체 장수다(콜마너 사진은 수십 장이라 limit에서 잘리는 일이 흔하다).
  const caption = uploaded.length < total
    ? `${head}${what} ${total}장 중 ${uploaded.length}장을 보내드립니다. 나머지는 상담원이 확인 후 보내드리겠습니다.`
    : `${head}${what} ${uploaded.length}장을 보내드립니다.`;

  const result = await send(session, uploaded, caption);
  if (!result || !result.ok) {
    return { skipped: 'send_failed', message: MESSAGES.allFailed, error: result && result.error };
  }
  return { sent: uploaded.length, total, source, phase, failed: failed.length, caption };
}

module.exports = {
  sendOrderPhotos,
  isPhotoRequest,
  isOdometerRequest,
  summarizeOdometer,
  answerOdometer,
  loadOdometerRows,
  countNoPhotoAnswers,
  canCustomerViewPhotos,
  loadOrderPhotos,
  loadPhotosForCustomer,
  photoPhaseHint,
  uploadPhotosToKakao,
  fileNameFromUrl,
  MESSAGES,
  MAX_PHOTOS_PER_SEND,
};
