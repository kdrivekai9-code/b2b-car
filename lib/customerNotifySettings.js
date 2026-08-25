// 고객 통보·배차지연 설정 화면이 공유하는 표시용 상수와 행 조립 규칙.
//
// 왜 모듈로 뺐나: 같은 설정을 지사(routes/branches.js)와 법인(routes/groups.js) 두 곳에서
// 관리하게 되면서, 사건 목록·안내문구·미리보기 규칙이 양쪽에 복사될 참이었다. 이 코드베이스에서
// 화면을 복사해두고 한쪽만 고쳐 갈라진 사고가 반복됐다 — 한 벌만 둔다.
//
// 실제 발송 규칙(사건 종류·기본 문구·변수 치환)은 lib/kakaoOrderNotify.js가 갖고 있다.
// 여기 있는 건 "화면에 어떻게 보여줄지"뿐이다.
const kakaoOrderNotify = require('./kakaoOrderNotify');

const NOTIFY_EVENT_HINTS = {
  dispatched: '기사가 배정되었을 때.',
  started: '기사가 운행을 시작했을 때.',
  completed: '운행이 완료되었을 때.',
  dispatch_cancelled: '배차받은 기사가 취소해서 다시 배차를 찾는 중일 때. 오더는 살아 있습니다.',
  cancelled: '오더 자체가 취소되었을 때.',
};

// 사진을 붙일 수 있는 사건 — 콜마너 탁송사진은 운행전/운행후로만 온다. 배차 시점에는 아직
// 사진이 없어서 스위치를 켜도 보낼 것이 없다.
//
// receipt_uploaded는 붙이는 사진이 다르다(콜마너 탁송사진이 아니라 기사가 우리 업로드
// 페이지로 올린 인수증 — lib/kakaoOrderNotify.js). 여기 넣지 않으면 관리자가 통보 설정을
// 저장하는 순간 attach_photos가 false로 덮여(routes/branches.js가 이 집합으로 걸러 저장한다)
// 인수증 사진이 조용히 안 나가게 된다.
const NOTIFY_PHOTO_EVENTS = new Set(['started', 'completed', 'receipt_uploaded']);

// 미리보기용 예시 오더. 실제 렌더러(renderTemplate)에 그대로 통과시켜 보여준다 — 화면에서
// 규칙을 다시 구현하면 실제로 고객이 받는 문구와 어긋난다.
const NOTIFY_PREVIEW_ORDER = {
  oid: 'OID1246',
  order_type: 'dispatch',
  callmaner_driver_name: '홍길동',
  callmaner_driver_phone: '050-7111-2222',
  origin_address: '서울 강서구 양천로53길 30',
  origin_address_detail: '3층',
  destination_address: '경기 성남시 분당구 판교역로 160',
  destination_address_detail: 'B동 로비',
  reserved_date: '2026-08-20',
  reserved_time: '14:00',
  odometer_start: 12345,
  odometer_end: 12470,
  distance_total: 125,
};

// 배차지연 선제 안내를 걸 콜 유형.
const DISPATCH_CALL_TYPES = [
  { key: 'corporate_call', label: '법인콜', orderType: 'premium' },
  { key: 'daily_driver', label: '일일기사', orderType: 'daily_driver' },
  { key: 'dispatch', label: '탁송', orderType: 'dispatch' },
];

function parseCallTypes(raw) {
  const values = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const allowed = DISPATCH_CALL_TYPES.map((t) => t.key);
  return values.map(String).filter((v) => allowed.indexOf(v) >= 0);
}

// 저장된 행(없으면 빈 배열)으로 화면에 뿌릴 사건 목록을 만든다.
//
// inherited: 이 화면에 저장된 값이 없어서 다른 곳(법인 화면이면 지사 설정)의 값을 보여주는
// 중인지. 법인 화면은 비어 있을 때 "지금은 지사 설정이 적용된다"를 반드시 밝혀야 한다 —
// 빈 칸만 보이면 통보가 꺼진 줄 안다.
function buildEventRows(savedRows, options = {}) {
  const savedByEvent = new Map((savedRows || []).map((row) => [row.event_type, row]));
  const inheritedRows = new Map((options.inheritedRows || []).map((row) => [row.event_type, row]));

  return kakaoOrderNotify.EVENT_TYPES.map((key) => {
    const fallback = kakaoOrderNotify.DEFAULT_EVENT_SETTINGS[key];
    const own = savedByEvent.get(key);
    // 자기 값이 없으면 물려받는 값 → 그것도 없으면 코드 기본값 순으로 보여준다.
    const row = own || inheritedRows.get(key) || null;
    const template = (row && String(row.message_template || '').trim()) || fallback.template;
    const attachPhotos = row && row.attach_photos !== undefined
      ? row.attach_photos === true
      : !!fallback.attachPhotos;
    return {
      key,
      label: fallback.label,
      hint: NOTIFY_EVENT_HINTS[key] || '',
      enabled: row ? row.enabled !== false : fallback.enabled,
      delayMinutes: row && Number.isFinite(Number(row.delay_minutes)) ? Number(row.delay_minutes) : fallback.delayMinutes,
      template,
      attachPhotos,
      photoSupported: NOTIFY_PHOTO_EVENTS.has(key),
      inherited: !own,
      // 실제 발송에 쓰는 렌더러를 그대로 통과시킨 결과를 보여준다.
      preview: kakaoOrderNotify.renderTemplate(template, NOTIFY_PREVIEW_ORDER),
    };
  });
}

module.exports = {
  NOTIFY_EVENT_HINTS,
  NOTIFY_PHOTO_EVENTS,
  NOTIFY_PREVIEW_ORDER,
  DISPATCH_CALL_TYPES,
  parseCallTypes,
  buildEventRows,
};
