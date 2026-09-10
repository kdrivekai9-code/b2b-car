// 오더 상태 배지 색 — **Next 쪽의 유일한 정의**다.
//
// config.js(STATUS_COLORS)를 그대로 import하지 않는 이유: 그 파일은 CommonJS이고 Express
// 상수들과 함께 있어 클라이언트 컴포넌트에서 끌어오면 딸려 오는 것이 는다. 대신 값이
// 갈리지 않는지 scripts/check-status-colors-parity.js가 대조한다.
//
// 왜 파일로 뺐나(2026-09-10 실측): Next 오더 목록(OrderListTable.js)이 자기 사본을 들고
// 있었는데 **'예약'이 빠져 있었다**. 그래서 예약 오더의 배지가 EJS에서는 indigo, Next에서는
// 회색으로 나왔다 — 프로덕션에서 그 화면은 Next였다. 사본이 둘이면 이런 누락이 조용하다.
export const STATUS_COLORS = {
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

export const statusColor = (s) => STATUS_COLORS[s] || 'gray';
