import BranchTabSwitch from './BranchTabSwitch';

// views/partials/branch_tabs.ejs를 이식 — 지사 관리 화면 상단의 목록/기본정보/결제방식/
// 운영시간/요금표/프리미엄 요금표/오더 상태/사진 업로드 안내/추가기능/콜마너 연동 탭. 지사 목록
// 페이지(active='list')에는 특정 지사 컨텍스트가 없어서, legacy와 동일하게 목록의 첫 번째
// 지사를 기준으로 탭 링크를 만든다(지사가 하나도 없으면 목록 탭만 보임).
const TAB_DEFS = [
  { key: 'basic', label: '기본 정보', path: 'edit' },
  { key: 'payment', label: '결제방식 설정', path: 'payment-methods' },
  { key: 'hours', label: '운영시간 설정', path: 'operating-hours' },
  { key: 'fare', label: '요금표 설정', path: 'fare-rules' },
  { key: 'premium_fare', label: '프리미엄 요금표', path: 'premium-fare-rules' },
  { key: 'status', label: '오더 상태 설정', path: 'order-status' },
  { key: 'photo', label: '사진 업로드 안내', path: 'photo-settings' },
  { key: 'extra', label: '추가기능', path: 'extra-settings' },
  { key: 'callmaner', label: '콜마너 연동', path: 'callmaner' },
  { key: 'dispatch_delay', label: '배차지연 알림', path: 'dispatch-delay' },
  { key: 'customer_notifications', label: '고객 통보', path: 'customer-notifications' },
];

export default function BranchTabs({ active, branches = [], branch = null }) {
  const targetBranch = branch || branches[0] || null;
  const activeDef = TAB_DEFS.find((t) => t.key === active);
  const switchPath = activeDef ? activeDef.path : 'edit';

  return (
    <div className="tabs branch-tabs">
      <a href="/branches" className={active === 'list' ? 'active' : ''}>지사 관리</a>
      {targetBranch && TAB_DEFS.map((t) => (
        <a key={t.key} href={`/branches/${targetBranch.id}/${t.path}`} className={active === t.key ? 'active' : ''}>{t.label}</a>
      ))}
      {branches.length > 1 && targetBranch && (
        <BranchTabSwitch branches={branches} activeBranchId={targetBranch.id} switchPath={switchPath} />
      )}
    </div>
  );
}
