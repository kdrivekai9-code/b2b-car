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

// 촬영 순서와 항목 이름 — **운행전과 운행후가 다르다.**
//
// 콜마너 기사 앱의 촬영 순서다(사용자 확정 2026-09-08). 운행후에는 계기판이 **맨 앞**으로
// 오고 나머지가 한 칸씩 밀린다. 그래서 순번만으로는 무엇을 찍은 것인지 알 수 없다 —
// 운행전 1번은 전면이지만 운행후 1번은 계기판이다.
//
// 이 사실을 몰라서 두 가지가 조용히 틀려 있었다(2026-09-08 실측으로 확인):
//
//  1) **주행거리 종료값이 한 번도 안 읽혔다.** 계기판을 양쪽 모두 13번에서 찾았는데 운행후
//     13번은 보조석 앞바퀴다. order_callmaner_photos를 보면 phase=end/seq=13은 전부
//     ocr_status='failed'이고, orders.odometer_end와 distance_total은 전부 NULL이었다.
//     운행전(13번=계기판)만 129422·128422처럼 제대로 읽혔다.
//
//  2) **운행전·운행후 비교가 다른 항목끼리였다.** 짝을 순번으로 지어서 운행전 전면(1)과
//     운행후 계기판(1)을 나란히 놓았다. 흠집이 언제 생겼는지 보는 화면인데 비교 대상 자체가
//     어긋나 있었다.
//
// 좌/우가 이름에 들어간다(운전석·보조석). 앞서 사진만 보고는 좌우를 가릴 수 없어 비워뒀는데,
// 이제 촬영 순서가 확정됐으므로 적는다 — 근거는 사람의 확인이고, 사진 열세 장의 종류
// (전면·사선·옆면·바퀴·계기판)는 실물 대조와 일치했다(OID1455·OID2075).
//
// 콜마너가 순서를 바꾸면 여기를 바꾼다. 지사별로 다르면 branches에 칸을 두는 방식으로
// 넓힌다(odometer_photo_index가 이미 그 방식이다).
const PHOTO_ITEMS = {
  [PHASE_START]: [
    '전면', '보조석 측면', '운전석 측면', '운전석 옆면', '운전석 앞바퀴', '운전석 뒷바퀴',
    '뒷면', '운전석 뒤 측면', '보조석 뒤 측면', '보조석 옆면', '보조석 뒤 바퀴',
    '보조석 앞 바퀴', '계기판',
  ],
  [PHASE_END]: [
    '계기판', '전면', '보조석 측면', '운전석 측면', '운전석 옆면', '운전석 앞바퀴',
    '운전석 뒷바퀴', '뒷면', '운전석 뒤 측면', '보조석 뒤 측면', '보조석 옆면',
    '보조석 뒤 바퀴', '보조석 앞 바퀴',
  ],
};

// 뒤에서 이름으로 순번을 되찾는다(계기판·전면이 몇 번인지). 순번을 코드에 박으면 표와
// 어긋나는 순간 조용히 틀린 사진을 읽는다 — 그게 위 1)의 원인이었다.
function seqOfItem(item, phase) {
  const list = PHOTO_ITEMS[phase] || PHOTO_ITEMS[PHASE_START];
  const at = list.indexOf(item);
  return at < 0 ? null : at + 1;
}

// 그 순번이 무엇을 찍은 것인가. 표 밖이면 null — 모르는 것을 아는 척하지 않는다.
function photoItem(seq, phase) {
  const list = PHOTO_ITEMS[phase] || PHOTO_ITEMS[PHASE_START];
  const n = Number(seq);
  return (Number.isInteger(n) && n >= 1 && n <= list.length) ? list[n - 1] : null;
}

// 계기판 사진이 몇 번째인지. 단계마다 다르다(운행전 13, 운행후 1).
const DEFAULT_ODOMETER_PHOTO_INDEX = seqOfItem('계기판', PHASE_START);

// 이름이 있으면 "1. 전면", 없으면 "3번" — 모르는 것을 아는 척하지 않는다.
function photoLabel(seq, phase) {
  const n = Number(seq);
  const name = photoItem(n, phase);
  return name ? `${n}. ${name}` : `${n}번`;
}

// 운행전·운행후를 **항목으로** 짝지어 나란히 놓는다.
//
// 순번으로 짝지으면 안 된다. 운행후는 계기판이 맨 앞에 붙어 한 칸씩 밀리므로(PHOTO_ITEMS),
// 순번을 맞추면 운행전 전면과 운행후 계기판을 나란히 놓게 된다 — 실제로 그렇게 나가고 있었다.
// 같은 자리를 비교해야 무엇이 달라졌는지 보인다. 흠집이 언제 생겼는지가 사고 처리의 전부다.
//
// 줄 순서는 **운행전 촬영 순서**를 따른다(전면부터). 한쪽만 있는 항목도 자리를 남긴다 —
// 빠진 것이 보여야 "안 찍었다"를 알 수 있다.
function pairByPhase(photos) {
  const rows = Array.isArray(photos) ? photos : [];
  const byItem = new Map();
  const unknown = [];

  rows.forEach((photo) => {
    const item = photoItem(photo && photo.seq, photo && photo.phase);
    if (!item) { unknown.push(photo); return; }
    if (!byItem.has(item)) byItem.set(item, { start: null, end: null });
    const slot = byItem.get(item);
    if (photo.phase === PHASE_END) slot.end = photo; else slot.start = photo;
  });

  const paired = PHOTO_ITEMS[PHASE_START]
    .filter((item) => byItem.has(item))
    .map((item) => {
      const slot = byItem.get(item);
      return {
        item,
        // 화면에 적는 이름은 항목이다. 순번은 단계마다 달라서 이름 옆에 붙이면 헷갈린다 —
        // 대신 단계별 순번을 따로 실어 보내 필요한 화면이 덧붙이게 한다.
        label: item,
        startSeq: seqOfItem(item, PHASE_START),
        endSeq: seqOfItem(item, PHASE_END),
        // 기존 호출부가 key로 쓰던 값. 운행전 순번을 그대로 쓴다(줄 순서와 같다).
        seq: seqOfItem(item, PHASE_START),
        start: slot.start,
        end: slot.end,
      };
    });

  // 표에 없는 순번(콜마너가 장수를 늘린 경우)은 뒤에 붙인다 — 조용히 사라지면 사진이
  // 있는데 없는 것이 된다. 이때는 짝을 지을 근거가 없어 순번으로 묶는다.
  const extraSeqs = [...new Set(unknown.map((p) => Number(p && p.seq)).filter(Number.isFinite))]
    .sort((a, b) => a - b);
  const extras = extraSeqs.map((seq) => ({
    item: null,
    label: `${seq}번`,
    startSeq: seq,
    endSeq: seq,
    seq,
    start: unknown.find((p) => p.phase === PHASE_START && Number(p.seq) === seq) || null,
    end: unknown.find((p) => p.phase === PHASE_END && Number(p.seq) === seq) || null,
  }));

  return [...paired, ...extras];
}

// 계기판 사진의 순번. **단계를 받는다** — 운행전 13, 운행후 1이다.
//
// branches.odometer_photo_index 재정의는 그 칸이 생길 때 "운행후 순서가 다르다"는 것을
// 몰랐으므로 **운행전 기준 값**으로 적혀 있다(현재 두 지사 모두 13 = 표와 같은 값).
// 그래서 운행후에는 재정의를 쓰지 않고 표를 쓴다. 지사가 순서 자체를 달리 쓰게 되면
// 운행후용 칸을 따로 두는 쪽이 맞다 — 한 값으로 두 단계를 덮으면 지금 고친 버그가 돌아온다.
function odometerPhotoIndex(branch, phase) {
  const canonical = seqOfItem('계기판', phase === PHASE_END ? PHASE_END : PHASE_START);
  if (phase === PHASE_END) return canonical;
  const raw = Number(branch && branch.odometer_photo_index);
  if (!Number.isInteger(raw) || raw <= 0) return canonical;
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
  const index = odometerPhotoIndex(branch, phase);
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
// 번호판을 읽는 사진은 **운행전 전면**이다(syncPlateCheck이 PHASE_START만 읽는다).
// 순번을 1로 박지 않고 표에서 가져온다 — 표가 바뀌면 여기도 따라가야 한다.
const DEFAULT_PLATE_PHOTO_INDEX = seqOfItem('전면', PHASE_START);

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
    // 상이는 알림이 나가는 판정이라 두 번 읽어 확인한다(readPlateConfirmed 주석 참고).
    const result = await plateOcr.readPlateConfirmed(target.url, registered, options);
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
  PHOTO_ITEMS, photoItem, seqOfItem, photoLabel, pairByPhase,
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
