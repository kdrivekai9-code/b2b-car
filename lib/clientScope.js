// 법인 계정 구분(본사 직원 / 개인 딜러)과 그에 따른 조회 범위.
//
// 판정을 한 곳에 모으는 이유: 이 규칙이 오더 목록·오더 상세·대시보드·정산·챗봇·상담톡에서
// 각각 쓰인다. 화면마다 조건을 다시 쓰면 한 곳만 빠져도 딜러가 남의 오더를 보게 되는데,
// 그건 눈에 띄지 않는 사고다(더 보이는 것은 아무도 신고하지 않는다).

const CLIENT_TYPES = [
  { value: 'hq', label: '법인 본사 직원', hint: '소속 딜러의 오더까지 봅니다' },
  { value: 'dealer', label: '개인 딜러', hint: '본인이 접수한 오더만 봅니다' },
];

function normalizeClientType(raw) {
  const v = String(raw || '').trim();
  return CLIENT_TYPES.some((t) => t.value === v) ? v : 'hq';
}

// 개인 딜러인가. client 역할일 때만 의미가 있다 — admin·지사장에게 이 값이 붙어 있어도
// 무시한다(권한을 좁히는 방향이라 안전해 보이지만, 관리자가 오더를 못 보면 운영이 멈춘다).
function isDealer(user) {
  if (!user || user.role !== 'client') return false;
  return normalizeClientType(user.client_type) === 'dealer';
}

function isHqClient(user) {
  return !!user && user.role === 'client' && !isDealer(user);
}

// 딜러에게 별도 정산서를 끊는가. 딜러가 아니면 언제나 false —
// 본사 직원에게 개인 정산서를 끊는 개념은 없다.
function hasSeparateSettlement(user) {
  return isDealer(user) && !!user.separate_settlement;
}

function clientTypeLabel(user) {
  if (!user || user.role !== 'client') return null;
  const t = CLIENT_TYPES.find((x) => x.value === normalizeClientType(user.client_type));
  return t ? t.label : null;
}

module.exports = {
  CLIENT_TYPES,
  normalizeClientType,
  isDealer,
  isHqClient,
  hasSeparateSettlement,
  clientTypeLabel,
};
