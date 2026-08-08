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

// 주행거리는 사진 장수 제한과 무관하게 전부 봐야 한다 — 최댓값·최솟값을 구하는 것이라
// 최근 5장만 보면 출발 계기판이 빠질 수 있다.
async function loadOdometerRows(orderId) {
  return db.all(
    'SELECT odometer_km FROM order_photos WHERE order_id = ? AND odometer_km IS NOT NULL',
    [orderId]
  ).catch(() => []);
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

// 보낼 사진이 없을 때/권한이 없을 때의 안내는 호출부가 아니라 여기서 정한다 — 같은 상황에
// 화면마다 다른 말을 하면 고객은 무엇이 문제인지 알 수 없다.
const MESSAGES = {
  noPhotos: '아직 등록된 사진이 없습니다. 기사님이 사진을 올리면 바로 보내드리겠습니다.',
  notAllowed: '사진은 상담원을 통해 확인하실 수 있습니다. 상담원을 연결해드릴까요?',
  allFailed: '사진을 전달하는 중 문제가 생겼습니다. 상담원이 확인 후 보내드리겠습니다.',
  noOdometer: '아직 계기판 주행거리가 기록되지 않았습니다. 기사님이 입력하면 바로 알려드리겠습니다.',
};

// 오더 사진을 고객에게 보낸다.
//   { sent: n, total: n } — 보냈다
//   { skipped: '이유', message: '고객에게 할 말' } — 보내지 않았다
async function sendOrderPhotos(session, order, options = {}) {
  const send = options.sendImages || kakaoConsult.sendImages;

  if (!(await canCustomerViewPhotos(order.branch_id))) {
    return { skipped: 'not_allowed', message: MESSAGES.notAllowed };
  }

  const photos = await loadOrderPhotos(order.id, options.limit || MAX_PHOTOS_PER_SEND);
  if (!photos.length) return { skipped: 'no_photos', message: MESSAGES.noPhotos };

  const { uploaded, failed } = await uploadPhotosToKakao(session, photos, options);
  if (!uploaded.length) return { skipped: 'upload_failed', message: MESSAGES.allFailed, failed };

  const oid = String(order.oid || '').trim();
  const head = oid ? `[${oid}] ` : '';
  // 몇 장 중 몇 장인지 밝힌다. 일부만 갔는데 그 말을 안 하면 고객은 그게 전부인 줄 안다.
  const caption = failed.length
    ? `${head}등록된 사진 ${photos.length}장 중 ${uploaded.length}장을 보내드립니다. 나머지는 상담원이 확인 후 보내드리겠습니다.`
    : `${head}등록된 사진 ${uploaded.length}장을 보내드립니다.`;

  const result = await send(session, uploaded, caption);
  if (!result || !result.ok) {
    return { skipped: 'send_failed', message: MESSAGES.allFailed, error: result && result.error };
  }
  return { sent: uploaded.length, total: photos.length, failed: failed.length, caption };
}

module.exports = {
  sendOrderPhotos,
  isPhotoRequest,
  isOdometerRequest,
  summarizeOdometer,
  answerOdometer,
  loadOdometerRows,
  canCustomerViewPhotos,
  loadOrderPhotos,
  uploadPhotosToKakao,
  fileNameFromUrl,
  MESSAGES,
  MAX_PHOTOS_PER_SEND,
};
