// 일일기사 요금 — views/branches/premium_fare_rules.ejs의 Next 판.
//
// ⚠ 표 이름이 premium_fare_rules인 것은 옛 이름이 남은 것이고, 실제로 쓰는 상품은
// **일일기사**다(이용 시간 기준). 프리미엄대리는 옆 탭에 별도 표가 있다.
import AppShell from '../../../_components/AppShell';
import BranchSettingsShell from '../../_components/BranchSettingsShell';
import HourTierTable from '../../_components/HourTierTable';
import loadBranchData from '../../_components/loadBranchData';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function BranchPremiumFareRulesPage({ params, searchParams }) {
  const { id } = await params;
  const sp = (await searchParams) || {};
  const { currentUser, branch, branches, tiers } = await loadBranchData(id, 'premium-fare-rules');

  return (
    <AppShell currentUser={currentUser} activePath="/branches">
      <BranchSettingsShell
        branch={branch} branches={branches} active="premium_fare" formId="premiumFareForm"
        title="일일기사 요금"
        sub={<>
          <b>일일기사</b> 오더에 적용되는 시간 구간 기반 요금표입니다. 기본요금 + (초과시간 × 시간당 추가요금) 방식으로 계산됩니다.
          <br />프리미엄대리는 편도 거리 기준이라 <a href={`/branches/${branch.id}/premium-oneway-fare-rules`}>프리미엄(대리) 요금</a>에서 따로 등록합니다.
        </>}
      >
        {sp.saved === '1' && <div className="success-msg" style={{ marginBottom: 12 }}>✓ 저장되었습니다.</div>}

        <form id="premiumFareForm" method="POST" action={`/branches/${branch.id}/premium-fare-rules`}>
          <div className="card">
            <div className="section-title">⏱ 시간 구간별 요금 규칙</div>
            <p className="page-sub">구간 기준시간(base_hours) 이상이고 다음 구간 미만일 때 해당 구간 기본요금을 적용합니다.</p>
            <HourTierTable tiers={tiers} />
          </div>
        </form>
      </BranchSettingsShell>
    </AppShell>
  );
}
