// 통보 종류와 기본 문구 — **DB를 건드리지 않는 상수만** 여기 둔다.
//
// 왜 파일을 나눴나(2026-09-08 실사고): 이 상수들이 lib/kakaoOrderNotify.js에 있었고, 알림 설정
// Next 페이지(src/app/push/settings/page.js)가 거기서 import했다. 그 모듈은 ../db를 require하고
// **db.js는 모듈 로드 시점에 던진다** — DATABASE_URL이 없으면 질의를 한 줄도 안 하는 코드까지
// 같이 죽는다. 그래서 `next build`가 "Failed to collect page data for /push/settings"로 실패했고,
// 프로덕션 배포 하나가 실패해 그 프로젝트는 이전 코드에 그대로 남았다.
//
// 로컬에서는 .env가 있어서 빌드가 통과한다 — CI에서만 드러난다. 같은 함정을 CI 검사 목록에서도
// 겪었다(그때도 .env가 있는 로컬에서 재서 24개가 CI에서 한꺼번에 죽었다).
//
// 규칙: Next 페이지가 import하는 모듈은 DB에 닿지 않아야 한다. 값이 필요하면 이렇게 상수만
// 담은 파일로 빼거나, 서버 엔드포인트를 통해 받는다.

// 지사가 따로 설정하지 않았을 때의 기본값 — 지사 설정 화면에 행이 없을 때만 쓰인다.
// 행이 하나라도 있으면 그 값이 항상 이긴다(loadEventSetting).
//
// 여기 값을 함부로 올리지 말 것. 한때 배차를 2분으로 올려두고 마이그레이션으로 저장된 행까지
// 같이 바꿨는데, 관리자가 화면에서 설정한 적 없는 값이 조용히 바뀌어 있었다. 지연은 관리자가
// 화면에서 정하는 값이고, 여기는 "아무것도 설정 안 했을 때의 출발점"일 뿐이다.
//
// 배차완료만 1분 미룬다 — 배차 직후 취소되는 경우가 있어서, 바로 보내면 "배차됐습니다" 다음에
// 곧장 "취소됐습니다"가 이어진다. 나머지는 이미 결과가 확정된 사건이라 미룰 이유가 없다.
const DEFAULT_EVENT_SETTINGS = {
  dispatched: {
    label: '배차완료',
    enabled: true,
    delayMinutes: 1,
    attachPhotos: false,
    template: '요청하신 {order_type}건이 기사님 배차되었습니다.\n접수번호: {oid}\n일시: {reserved_at}\n{origin_full} → {destination_full}\n기사명: {driver_name}\n기사전화번호: {driver_phone}',
  },
  started: {
    label: '운행시작',
    enabled: true,
    delayMinutes: 0,
    attachPhotos: false,
    template: '요청하신 {order_type}건이 운행시작 되었습니다.\n접수번호: {oid}\n일시: {reserved_at}\n{origin_full} → {destination_full}',
  },
  completed: {
    label: '운행완료',
    enabled: true,
    delayMinutes: 0,
    attachPhotos: false,
    template: '요청하신 {order_type}건이 운행완료 되었습니다.\n접수번호: {oid}\n일시: {reserved_at}\n{origin_full} → {destination_full}',
  },
  // 우편발송(등기) 요청 건에서 기사가 인수증을 올렸을 때. 다른 사건과 달리 콜마너 상태 변화가
  // 아니라 업로드 자체가 방아쇠다(routes/receiptUpload.js가 직접 부른다).
  //
  // 사진 첨부를 기본으로 켠다 — 운행시작·완료의 사진 첨부는 지사가 켜는 선택이지만, 여기서는
  // 인수증 사진이 곧 통보의 내용이다. 사진 없이 "등록되었습니다"만 가면 고객은 다시 물어야 한다.
  receipt_uploaded: {
    label: '영수증 업로드',
    enabled: true,
    delayMinutes: 0,
    attachPhotos: true,
    template: '요청하신 {order_type}건의 서류 발송 영수증이 등록되었습니다.\n접수번호: {oid}\n등기번호: {tracking_no}',
  },
  dispatch_cancelled: {
    label: '배차취소',
    enabled: true,
    delayMinutes: 0,
    attachPhotos: false,
    template: '[{oid}] 배차받은 기사님이 취소하였고, 다른 기사님께 배차 진행중입니다.',
  },
  cancelled: {
    label: '오더취소',
    // 기본으로 끈다(사용자 확정). 콜마너의 '취소'를 그대로 믿을 수 없다는 것이 실측으로
    // 확인됐다 — 기사가 배차를 취소하면 콜마너가 잠깐 '취소'를 준 뒤 1분쯤 뒤에 '접수'로
    // 되돌린다(OID1237: 18:41:29 취소 → 18:42:30 접수). 그 순간을 잡아 "오더가 취소되었습니다"를
    // 보내면 멀쩡히 진행 중인 오더를 취소됐다고 통보하는 오발신이 된다.
    // 진짜 취소를 안내하고 싶으면 지사 설정에서 켤 수 있다.
    enabled: false,
    delayMinutes: 0,
    attachPhotos: false,
    template: '[{oid}] 오더가 취소되었습니다. 문의사항은 상담원에게 말씀해주세요.',
  },
};

const TEMPLATE_VARIABLES = [
  { token: '{oid}', label: '접수번호', hint: '예: OID1246' },
  { token: '{order_type}', label: '오더종류', hint: '탁송 / 프리미엄대리 / 일일기사' },
  { token: '{reserved_at}', label: '일시', hint: '예약일시(없으면 줄이 사라짐)' },
  { token: '{origin_full}', label: '출발지', hint: '상세주소까지 합친 값' },
  { token: '{destination_full}', label: '도착지', hint: '상세주소까지 합친 값' },
  { token: '{driver_name}', label: '기사명', hint: '배차 전에는 줄이 사라짐' },
  { token: '{driver_phone}', label: '기사전화번호', hint: '콜마너 안심번호(050)' },
  { token: '{odometer_start}', label: '출발지 주행거리', hint: '계기판 인식값, 단위(km) 자동' },
  { token: '{odometer_end}', label: '도착지 주행거리', hint: '계기판 인식값, 단위(km) 자동' },
  { token: '{distance_total}', label: '최종 운행 거리', hint: '도착지 − 출발지, 단위(km) 자동' },
  { token: '{photo_link}', label: '사진 모아보기 링크', hint: '탁송사진을 한 화면에 모아 보는 주소' },
  { token: '{driver_place}', label: '기사 현재 위치', hint: '예: 서울 강남구 역삼동 (배차 전에는 줄이 사라짐)' },
  { token: '{driver_eta}', label: '출발지 도착 예상', hint: '예: 약 12분 (배차 전에는 줄이 사라짐)' },
  { token: '{driver_location_link}', label: '실시간 위치 링크', hint: '지도로 기사 위치를 보는 주소(운행 중에만 열림)' },
  { token: '{tracking_no}', label: '등기번호', hint: '영수증 업로드 통보에서만 채워진다' },
];

const EVENT_TYPES = Object.keys(DEFAULT_EVENT_SETTINGS);

module.exports = { DEFAULT_EVENT_SETTINGS, TEMPLATE_VARIABLES, EVENT_TYPES };
