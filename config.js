// 오더 상태값 (개발기획서 5.1.2 참조 - Phase1은 전체 지사 공통 고정 목록)
const ORDER_STATUSES = [
  '오더등록', '대기', '접수', '진행중', '배정중', '기사배정',
  '문의', '사고', '과태료', '취소요청', '취소', '완료',
];

// 상태별 배지 색상 (UI 개선안 10절 반영 - 상태별 색상 체계)
const STATUS_COLORS = {
  '오더등록': 'gray',
  '대기': 'gray',
  '접수': 'blue',
  '진행중': 'blue',
  '배정중': 'amber',
  '기사배정': 'amber',
  '문의': 'purple',
  '사고': 'red',
  '과태료': 'red',
  '취소요청': 'red',
  '취소': 'dark',
  '완료': 'green',
};

module.exports = { ORDER_STATUSES, STATUS_COLORS };
