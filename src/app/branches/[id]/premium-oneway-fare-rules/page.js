// 프리미엄(대리) 요금 — views/branches/premium_oneway_fare_rules.ejs의 Next 판.
//
// 법인대리(프리미엄)는 편도 서비스라 탁송과 같은 거리 기준이다. 바로 옆 '일일기사 요금'은
// 이용 시간 기준인 다른 상품이다 — 두 표를 섞으면 청구가 어긋난다.
import AppShell from '../../../_components/AppShell';
import BranchSettingsShell from '../../_components/BranchSettingsShell';
import DistanceTierTable from '../../_components/DistanceTierTable';
import loadBranchData from '../../_components/loadBranchData';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function BranchPremiumOnewayFareRulesPage({ params, searchParams }) {
  const { id } = await params;
  const sp = (await searchParams) || {};
  const { currentUser, branch, branches, tiers } = await loadBranchData(id, 'premium-oneway-fare-rules');

  return (
    <AppShell currentUser={currentUser} activePath="/branches">
      <BranchSettingsShell
        branch={branch} branches={branches} active="premium_oneway_fare" formId="premiumOnewayFareForm"
        title="프리미엄(대리) 요금"
        sub={<>법인대리(프리미엄)는 <b>편도 서비스</b>라 탁송과 같은 거리 기준입니다. 이용 시간 기준인 <b>일일기사</b>와는 다른 표입니다.</>}
      >
        <div className="card">
          <div className="section-title">📌 이 요금이 쓰이는 곳</div>
          <p className="page-sub" style={{ margin: 0 }}>
            오더구분이 <b>프리미엄대리</b>인 오더의 요금을 이 표로 계산합니다(거리 기준). 요금 문의 답변도 이 표를 씁니다.
          </p>
          <p className="page-sub" style={{ margin: 0 }}>
            <b>등록하지 않으면 자동계산을 하지 않습니다</b> — 탁송 요금표로 대신 계산하면 계약과 다른 금액이 조용히 청구되기 때문입니다.
            그때 오더 등록 화면은 수동 입력으로 바뀌고, 챗봇 요금 문의는 &quot;등록되어 있지 않습니다&quot;로 안내한 뒤 상담원 연결을 제안합니다.
          </p>
          <p className="page-sub" style={{ marginBottom: 0 }}>
            현재 등록된 구간: <b>{tiers.length}개</b>
            {!tiers.length && <span className="badge amber">미등록</span>}
            {' '}· 법인별로 다른 요금이면 <b>법인관리 → 프리미엄(대리) 요금</b>에 등록하세요(법인 표가 있으면 그것이 먼저 적용됩니다).
          </p>
        </div>

        <form id="premiumOnewayFareForm" method="POST" action={`/branches/${branch.id}/premium-oneway-fare-rules`}>
          <div className="card">
            <div className="section-title">📏 거리 구간별 요금</div>
            <p className="page-sub">계산식: 기본요금 + (거리 − 기준거리) × (할증요금 ÷ 할증단위)</p>
            <DistanceTierTable tiers={tiers} branchId={branch.id} withNote />
          </div>
        </form>

        {sp.saved === '1' && <div className="toast">저장되었습니다.</div>}
        {sp.error && <div className="alert error">{sp.error}</div>}
      </BranchSettingsShell>
    </AppShell>
  );
}
