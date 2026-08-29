import GroupTabSwitch from './GroupTabSwitch';

// views/partials/group_tabs.ejs를 이식한 법인 관리 상단 탭.
//
// 탭 정의는 EJS 파셜과 **같은 순서·같은 라벨·같은 경로**여야 한다. 이 두 화면은 서로 오가는
// 사이라(목록·법인정보는 Next가, 요금표·고객통보 등은 Express EJS가 그린다) 한쪽만 고치면
// 같은 탭 줄이 화면마다 다르게 보인다.
//
// 실제로 그렇게 됐다(2026-08-29 지적): EJS에 '정산내역'과 '지점 구간요금'을 더하면서 이 파일을
// 안 고쳐서, Next가 그리는 화면(법인 목록·법인 정보)에서는 그 두 탭이 아예 보이지 않았다.
// 두 탭이 보이는 화면과 안 보이는 화면이 섞여 있으니 "정산내역이 안 나온다"가 된다.
//
// 목록을 늘릴 때는 반드시 두 파일을 함께 고친다.
const TAB_DEFS = [
  { key: 'basic', label: '법인 정보', path: 'edit' },
  { key: 'accounts', label: '계정정보', path: 'accounts' },
  { key: 'fare', label: '탁송 요금', path: 'fare-rules' },
  // 지점↔지역 계약표. 거리 구간표보다 먼저 적용되므로 '탁송 요금' 바로 옆에 둔다.
  { key: 'office_fare', label: '지점 구간요금', path: 'office-fares' },
  { key: 'daily_driver_fare', label: '일일기사 요금', path: 'daily-driver-fare-rules' },
  { key: 'premium_fare', label: '프리미엄(대리) 요금', path: 'premium-fare-rules' },
  { key: 'settlement', label: '정산내역', path: 'settlement' },
  { key: 'customer_notifications', label: '고객 통보', path: 'customer-notifications' },
  { key: 'dispatch_delay', label: '배차지연 알림', path: 'dispatch-delay' },
];

// 목록 화면(active='list')에는 특정 법인 컨텍스트가 없다 — legacy와 같이 목록의 첫 법인을
// 기준으로 링크를 만든다(법인이 하나도 없으면 '법인 관리' 탭만 보인다).
export default function GroupTabs({ active, groups = [], group = null }) {
  const targetGroup = group || groups[0] || null;
  const activeDef = TAB_DEFS.find((t) => t.key === active);
  const switchPath = activeDef ? activeDef.path : 'edit';

  return (
    <div className="tabs branch-tabs">
      <a href="/groups" className={active === 'list' ? 'active' : ''}>법인 관리</a>
      {targetGroup && TAB_DEFS.map((t) => (
        <a
          key={t.key}
          href={`/groups/${targetGroup.id}/${t.path}`}
          className={active === t.key ? 'active' : ''}
        >{t.label}</a>
      ))}
      {groups.length > 1 && targetGroup && (
        <GroupTabSwitch groups={groups} activeGroupId={targetGroup.id} switchPath={switchPath} />
      )}
    </div>
  );
}
