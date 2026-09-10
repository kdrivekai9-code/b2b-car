// 배차 요금 — views/branches/dispatch_fare_rules.ejs의 Next 판.
//
// 콜마너에 거는 금액이다. 고객에게 청구하는 탁송 요금과 별개이며 거래처와 무관해 지사별로만 둔다.
import AppShell from '../../../_components/AppShell';
import BranchSettingsShell from '../../_components/BranchSettingsShell';
import DistanceTierTable from '../../_components/DistanceTierTable';
import loadBranchData from '../../_components/loadBranchData';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function BranchDispatchFareRulesPage({ params, searchParams }) {
  const { id } = await params;
  const sp = (await searchParams) || {};
  const { currentUser, branch, branches, tiers } = await loadBranchData(id, 'dispatch-fare-rules');

  return (
    <AppShell currentUser={currentUser} activePath="/branches">
      <BranchSettingsShell
        branch={branch} branches={branches} active="dispatch_fare" formId="dispatchFareForm"
        title="배차 요금"
        sub={<>콜마너에 거는 금액입니다. 고객에게 청구하는 <b>탁송 요금과 별개</b>이며, 고객 안내에는 쓰이지 않습니다.</>}
      >
        <div className="card">
          <div className="section-title">📌 이 요금이 쓰이는 곳</div>
          <p className="page-sub" style={{ margin: 0 }}>
            오더를 콜마너에 등록할 때 이 표로 계산한 금액을 겁니다(거리 기준).
            <b>등록하지 않으면 0원으로 나갑니다</b> — 없는 값을 지어내지 않기 때문입니다. 0원이면 기사 배차가 어려울 수 있습니다.
          </p>
          <p className="page-sub" style={{ marginBottom: 0 }}>
            현재 등록된 구간: <b>{tiers.length}개</b>
            {!tiers.length && <span className="badge amber">미등록</span>}
          </p>
        </div>

        <form id="dispatchFareForm" method="POST" action={`/branches/${branch.id}/dispatch-fare-rules`}>
          <div className="card">
            <div className="section-title">📏 거리 구간별 배차 요금</div>
            <p className="page-sub">계산식: 기본요금 + (거리 − 기준거리) × (할증요금 ÷ 할증단위)</p>
            <DistanceTierTable tiers={tiers} branchId={branch.id} />
          </div>
        </form>

        {sp.saved === '1' && <div className="toast">저장되었습니다.</div>}
      </BranchSettingsShell>
    </AppShell>
  );
}
