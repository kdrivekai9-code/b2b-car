import GroupTabSwitch from './GroupTabSwitch';

// views/partials/group_tabs.ejs를 이식 — 법인 관리 화면 상단의 목록/법인정보/계정정보/요금표
// 3종/고객통보/배차지연 탭.
//
// 탭 정의는 EJS 파셜과 **같은 순서·같은 라벨·같은 경로**여야 한다. 이 두 화면은 서로 오가는
// 사이라(목록·법인정보는 Next가, 요금표·고객통보 등은 Express EJS가 그린다) 한쪽만 고치면
// 같은 탭 줄이 화면마다 다르게 보인다.
const TAB_DEFS = [
  { key: 'basic', label: '법인 정보', path: 'edit' },
  { key: 'accounts', label: '계정정보', path: 'accounts' },
  { key: 'fare', label: '탁송 요금', path: 'fare-rules' },
  { key: 'daily_driver_fare', label: '일일기사 요금', path: 'daily-driver-fare-rules' },
  { key: 'premium_fare', label: '프리미엄(대리) 요금', path: 'premium-fare-rules' },
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
