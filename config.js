// 오더 상태값 (개발기획서 5.1.2 참조 - Phase1은 전체 지사 공통 고정 목록)
// 대기(확인중)/접수(배차중)은 콜마너(CMNP) 연동 전까지는 관리자가 수동으로도 선택 가능한
// 중간 상태 — '진행중'/'배정중'은 실사용 없어 제거.
// '운행시작'은 콜마너 OrderInfo의 baecha_status(2=운행시작)로만 들어온다 — 관리자가 손으로
// 고를 수도 있지만 실제로는 폴링(routes/callmanerSync.js)이 채운다. '기사배정' 바로 뒤에 둔
// 이유는 배차 이후의 하위 진행 단계라서다(기사배정 → 운행시작 → 완료).
const ORDER_STATUSES = [
  '오더등록', '예약', '대기', '대기(확인중)', '접수', '접수(배차중)', '기사배정', '운행시작',
  '문의', '사고', '과태료', '취소요청', '취소', '완료',
];

// 상태별 배지 색상 (UI 개선안 10절 반영 - 상태별 색상 체계)
const STATUS_COLORS = {
  '오더등록': 'gray',
  '예약': 'indigo',
  '대기': 'gray',
  '대기(확인중)': 'amber',
  '접수': 'blue',
  '접수(배차중)': 'blue',
  '기사배정': 'amber',
  '운행시작': 'teal',
  '문의': 'purple',
  '사고': 'red',
  '과태료': 'red',
  '취소요청': 'red',
  '취소': 'dark',
  '완료': 'green',
};

// 오더 종류(orders.order_type)의 고객 안내용 한글 라벨. 능동 통보 문구의 {order_type}이
// 이 값을 쓴다("요청하신 탁송건이 …"). 화면 쪽에는 같은 뜻의 라벨이 여러 군데 흩어져 있는데
// (views/orders/detail.ejs, src/app/orders/[id]/OrderSidePanel.js 등), 고객에게 나가는 문구는
// 한 곳에서만 정하도록 여기에 둔다 — 지사설정 화면(routes/branches.js)은 premium을 '법인콜'로
// 부르지만 고객 안내는 '프리미엄대리'로 통일한다(사용자 지정).
const ORDER_TYPE_LABELS = {
  dispatch: '탁송',
  premium: '프리미엄대리',
  daily_driver: '일일기사',
};

module.exports = { ORDER_STATUSES, STATUS_COLORS, ORDER_TYPE_LABELS };
