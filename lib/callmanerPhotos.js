// 콜마너 탁송사진(ConsPicture) 수집·조회.
//
// 링크만 보관한다(사용자 확정) — 우리 버킷으로 복사하지 않으므로 콜마너가 링크를 만료시키면
// 과거 사진은 볼 수 없게 된다. 그 대신 저장공간과 다운로드 비용이 없다.
//
// 기사 업로드 사진(order_photos)과 같은 테이블에 섞지 않은 이유: order_photos는 오더상세
// 갤러리·고객 사진요청 응답·주행거리 답변(lib/kakaoOrderPhotos.js summarizeOdometer)이 모두
// 읽고 있어서, 외부 링크를 그 안에 섞으면 그 세 기능의 동작이 함께 바뀐다.
const db = require('../db');

const UNDEFINED_TABLE = '42P01';

const PHASE_START = 'start'; // 운행전 (ConsPicture의 before)
const PHASE_END = 'end';     // 운행후 (ConsPicture의 after)

// 계기판 사진이 몇 번째인지 — 현재 관측값은 13번째다. 콜마너가 순서를 바꿀 수 있어 지사별로
// 조정할 수 있게 했다(branches.odometer_photo_index, 1-based).
const DEFAULT_ODOMETER_PHOTO_INDEX = 13;

function odometerPhotoIndex(branch) {
  const raw = Number(branch && branch.odometer_photo_index);
  if (!Number.isInteger(raw) || raw <= 0) return DEFAULT_ODOMETER_PHOTO_INDEX;
  return raw;
}

// 이미 저장된 링크는 건너뛰고 새 링크만 넣는다(unique (order_id, phase, seq)).
// 콜마너가 같은 순번에 다른 링크를 주면 링크를 갱신한다 — 사진이 교체된 경우다.
async function savePhotos(orderId, phase, urls) {
  if (!Array.isArray(urls) || !urls.length) return 0;
  let saved = 0;
  for (let i = 0; i < urls.length; i += 1) {
    const seq = i + 1; // 1-based — 계기판을 "13번째"로 찾으므로 순번을 그대로 보존한다
    try {
      const result = await db.run(
        `INSERT INTO order_callmaner_photos (order_id, phase, seq, url)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (order_id, phase, seq) DO UPDATE SET
           url = excluded.url,
           -- 링크가 바뀌면 이전 인식 결과는 그 사진의 것이 아니다.
           odometer_km = CASE WHEN order_callmaner_photos.url <> excluded.url THEN NULL ELSE order_callmaner_photos.odometer_km END,
           ocr_status = CASE WHEN order_callmaner_photos.url <> excluded.url THEN NULL ELSE order_callmaner_photos.ocr_status END`,
        [orderId, phase, seq, urls[i]]
      );
      if (result && result.rowCount) saved += 1;
    } catch (e) {
      if (e && e.code === UNDEFINED_TABLE) return 0; // 마이그레이션 전 — 조용히 넘어간다
      throw e;
    }
  }
  return saved;
}

// 콜마너에서 사진을 받아 저장한다. 완료 시점에 부르는 것이 정석이고(정의서: "탁송콜 완료시"),
// 운행시작 시점에 불러도 before만 들어오거나 아무것도 없을 수 있다 — 둘 다 정상이다.
async function collectPhotos(callmaner, branch, order) {
  if (!order || !order.callmaner_conf_slip) return { before: 0, after: 0 };
  const links = await callmaner.consPicture(branch, order.callmaner_conf_slip);
  const [before, after] = await Promise.all([
    savePhotos(order.id, PHASE_START, links.before),
    savePhotos(order.id, PHASE_END, links.after),
  ]);
  return { before, after };
}

async function loadPhotos(orderId, phase) {
  try {
    if (phase) {
      return await db.all(
        'SELECT * FROM order_callmaner_photos WHERE order_id = ? AND phase = ? ORDER BY seq ASC',
        [orderId, phase]
      );
    }
    return await db.all(
      // 운행전 → 운행후 순으로 보여준다(시간 순서).
      `SELECT * FROM order_callmaner_photos WHERE order_id = ?
       ORDER BY CASE phase WHEN 'start' THEN 0 ELSE 1 END, seq ASC`,
      [orderId]
    );
  } catch (e) {
    if (e && e.code === UNDEFINED_TABLE) return [];
    throw e;
  }
}

// 계기판 사진 한 장 — 순번으로 찾는다. 장수가 모자라면 null(주행거리 계산을 건너뛴다).
function findOdometerPhoto(photos, index) {
  if (!Array.isArray(photos) || !photos.length) return null;
  return photos.find((p) => Number(p.seq) === Number(index)) || null;
}

// 계기판 사진을 읽어 주행거리를 채운다. 이미 읽은 사진은 다시 읽지 않는다(ocr_status) —
// 폴링이 매분 도는데 사진마다 제미나이를 다시 부르면 비용이 계속 쌓인다.
//
// 실패해도 오더 동기화를 막지 않는다: 주행거리는 통보에 곁들이는 정보라, 못 읽으면 그 줄만
// 빠지고 나머지 안내는 그대로 나가야 한다.
async function resolveOdometer(odometerOcr, branch, order, phase, options = {}) {
  const index = odometerPhotoIndex(branch);
  const photos = await loadPhotos(order.id, phase);
  const target = findOdometerPhoto(photos, index);
  if (!target) return null;                       // 장수 부족 — 계산 건너뜀
  if (target.odometer_km != null) return Number(target.odometer_km); // 이미 읽음
  if (target.ocr_status === 'failed') return null;                   // 모델이 못 읽음 — 재시도해도 같다

  const result = await odometerOcr.readOdometerKm(target.url, options);
  // result.km이 null일 때 Number(null)은 NaN이 아니라 0이다 — 그대로 쓰면 "못 읽었다"가
  // "0km"로 저장되고 상태가 done이 되어 다시 읽지도 않는다(OID1237이 실제로 0으로 굳었다).
  const raw = result ? result.km : null;
  const km = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  // 링크가 죽어서 못 받은 것(retryable)과 모델이 못 읽은 것을 구분한다 — 앞의 것은 사진이
  // 나중에 올라오면 다시 시도할 여지가 있고, 뒤의 것은 같은 사진을 다시 읽어도 결과가 같다.
  const status = km !== null ? 'done' : (result && result.retryable ? 'pending' : 'failed');
  await db.run(
    'UPDATE order_callmaner_photos SET odometer_km = ?, ocr_status = ? WHERE id = ?',
    [km, status, target.id]
  ).catch((e) => console.error('계기판 인식 결과 저장 실패:', e.message));
  if (km === null) {
    console.error(`계기판 인식 실패 (order=${order.oid}, phase=${phase}):`, result && result.reason);
  }
  return km;
}

// 오더의 주행거리 3종을 갱신한다(운행시작/완료 시점 계기판 값과 그 차이).
async function syncOdometer(odometerOcr, branch, order, options = {}) {
  const startKm = await resolveOdometer(odometerOcr, branch, order, PHASE_START, options);
  const endKm = await resolveOdometer(odometerOcr, branch, order, PHASE_END, options);
  const total = odometerOcr.computeDistance(startKm, endKm);
  if (startKm === null && endKm === null) return null;

  await db.run(
    `UPDATE orders SET odometer_start = ?, odometer_end = ?, distance_total = ? WHERE id = ?`,
    [startKm, endKm, total, order.id]
  ).catch((e) => {
    // 컬럼이 없는 DB(마이그레이션 전)에서는 조용히 넘어간다 — 주행거리 하나 때문에 동기화가
    // 막히면 안 된다.
    if (!e || e.code !== '42703') throw e;
  });
  return { startKm, endKm, total };
}


// ── 번호판 대조 ────────────────────────────────────────────────────────────
// 접수한 차량번호(orders.vehicle_number)와 운행시작 전면 사진의 번호판을 맞춰본다.
//
// 판정은 셋이다. 특히 "못 읽음"과 "다름"을 반드시 갈라야 한다 — 못 읽은 것을 상이로 묶으면
// 헛알림이 쌓이고, 그러면 진짜 상이 건까지 무시하게 된다.
const DEFAULT_PLATE_PHOTO_INDEX = 1;

function platePhotoIndex(branch) {
  const raw = Number(branch && branch.plate_photo_index);
  if (!Number.isInteger(raw) || raw <= 0) return DEFAULT_PLATE_PHOTO_INDEX;
  return raw;
}

async function syncPlateCheck(plateOcr, branch, order, options = {}) {
  // 접수 번호가 없으면 대조할 대상이 없다.
  const registered = String(order.vehicle_number || '').trim();
  if (!registered) return null;
  // 이미 판정한 오더는 다시 부르지 않는다. unreadable만 다시 시도한다 — 사진이 늦게
  // 올라오는 경우가 있어서다(match/mismatch는 같은 사진이면 결과가 같다).
  if (order.plate_check_status === 'match' || order.plate_check_status === 'mismatch') return null;

  const photos = await loadPhotos(order.id, PHASE_START);
  const index = platePhotoIndex(branch);
  const target = (photos || []).find((p) => Number(p.seq) === Number(index));
  if (!target) return null;
  if (target.plate_ocr_status === 'failed') return null; // 모델이 못 읽음 — 다시 읽어도 같다

  let plate = target.plate_text || null;
  if (!plate) {
    const result = await plateOcr.readPlate(target.url, options);
    plate = result && result.plate ? result.plate : null;
    const status = plate ? 'done' : (result && result.retryable ? 'pending' : 'failed');
    await db.run(
      'UPDATE order_callmaner_photos SET plate_text = ?, plate_ocr_status = ? WHERE id = ?',
      [plate, status, target.id]
    ).catch((e) => console.error('번호판 인식 결과 저장 실패:', e.message));
    if (!plate) console.error(`번호판 인식 실패 (order=${order.oid}):`, result && result.reason);
  }

  const same = plateOcr.comparePlates(registered, plate);
  const status = same === null ? 'unreadable' : (same ? 'match' : 'mismatch');
  await db.run(
    `UPDATE orders SET plate_check_status = ?, plate_recognized = ?, plate_photo_url = ?,
       plate_checked_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
     WHERE id = ?`,
    [status, plate, target.url, order.id]
  ).catch((e) => console.error('번호판 대조 결과 저장 실패:', e.message));

  return { status, registered, recognized: plate, photoUrl: target.url, photoSeq: target.seq };
}

module.exports = {
  syncPlateCheck,
  platePhotoIndex,
  DEFAULT_PLATE_PHOTO_INDEX,
  PHASE_START,
  PHASE_END,
  resolveOdometer,
  syncOdometer,
  DEFAULT_ODOMETER_PHOTO_INDEX,
  odometerPhotoIndex,
  savePhotos,
  collectPhotos,
  loadPhotos,
  findOdometerPhoto,
};
