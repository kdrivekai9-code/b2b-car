'use client';

// 지사 설정 탭 — views/partials/branch_tabs.ejs의 Next 판.
//
// **탭 목록은 여기 한 벌만 둔다.** EJS 쪽과 값이 갈리면 같은 화면인데 탭이 다르게 보이고,
// 이관 도중에는 그 차이가 "어느 화면이 Next인지"로 오해된다. 그래서 이 파일과 EJS 파일이
// 같은 목록을 갖는지 scripts/check-branch-tabs-parity.js가 대조한다.
//
// 클라이언트 컴포넌트인 이유는 지사 전환 <select> 하나 때문이다 — 고르면 같은 탭을 유지한
// 채 다른 지사로 이동한다(EJS도 같은 동작).
const TAB_DEFS = [
  { key: 'basic', label: '기본 정보', path: 'edit' },
  { key: 'payment', label: '결제방식 설정', path: 'payment-methods' },
  { key: 'hours', label: '운영시간 설정', path: 'operating-hours' },
  // 이름 변경(정책): 이 표들은 이제 "법인 표가 없을 때 쓰는 기본값"이다 — 법인관리 쪽에
  // 같은 이름의 표가 생겼다. 프리미엄 요금표는 실제로 일일기사에 쓰고 있어 이름을 맞췄다
  // (프리미엄(대리)은 편도 거리 기준으로 아래에 별도 표가 생겼다).
  { key: 'fare', label: '탁송 요금', path: 'fare-rules' },
  { key: 'premium_fare', label: '일일기사 요금', path: 'premium-fare-rules' },
  { key: 'premium_oneway_fare', label: '프리미엄(대리) 요금', path: 'premium-oneway-fare-rules' },
  // 콜마너에 거는 금액 — 고객 청구액(탁송 요금)과 별개다. 거래처와 무관해 지사별로만 둔다.
  { key: 'dispatch_fare', label: '배차 요금', path: 'dispatch-fare-rules' },
  { key: 'status', label: '오더 상태 설정', path: 'order-status' },
  { key: 'photo', label: '사진 업로드 안내', path: 'photo-settings' },
  { key: 'extra', label: '추가기능', path: 'extra-settings' },
  { key: 'callmaner', label: '콜마너 연동', path: 'callmaner' },
  { key: 'dispatch_delay', label: '배차지연 알림', path: 'dispatch-delay' },
  { key: 'customer_notifications', label: '고객 통보', path: 'customer-notifications' },
];

export default function BranchTabs({ branch, branches = [], active }) {
  const list = branches || [];
  const target = branch && branch.id ? branch : (list.length ? list[0] : null);
  const activeDef = TAB_DEFS.find((t) => t.key === active);
  const switchPath = (activeDef && activeDef.path) || 'edit';

  return (
    <div className="tabs branch-tabs">
      <a href="/branches" className={active === 'list' ? 'active' : ''}>지사 관리</a>
      {target && TAB_DEFS.map((t) => (
        <a key={t.key} href={`/branches/${target.id}/${t.path}`} className={active === t.key ? 'active' : ''}>
          {t.label}
        </a>
      ))}
      {list.length > 1 && target && (
        <select
          className="branch-tab-switch"
          defaultValue={String(target.id)}
          // 지사를 바꿔도 보던 탭을 유지한다 — 매번 기본 정보로 돌아가면 여러 지사의 같은
          // 설정을 비교할 수가 없다.
          onChange={(e) => { window.location.href = `/branches/${e.target.value}/${switchPath}`; }}
        >
          {list.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      )}
    </div>
  );
}
