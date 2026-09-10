// 탁송 요금(지사) — views/branches/fare_rules.ejs의 Next 판.
//
// 지사 설정에서 가장 큰 화면이다. 구간요금표 + 부가요금/노출 설정 + 오더구분별 대기·취소요금
// + 할증·부대비용까지 한 폼에 들어 있다. 뒤의 둘은 법인 화면과 공유하는 부품이다
// (_components/OrderTypeTripFees, _components/FareSurchargeSettings) — EJS도 같은 이유로
// 파티셜이고, 한쪽에만 항목을 늘리면 그 화면으로 저장할 때 다른 쪽 설정이 조용히 지워진다.
import AppShell from '../../../_components/AppShell';
import ConfirmForm from '../../../_components/ConfirmForm';
import FareSurchargeSettings from '../../../_components/FareSurchargeSettings';
import OrderTypeTripFees from '../../../_components/OrderTypeTripFees';
import BranchSettingsShell from '../../_components/BranchSettingsShell';
import DistanceTierTable from '../../_components/DistanceTierTable';
import loadBranchData from '../../_components/loadBranchData';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function BranchFareRulesPage({ params, searchParams }) {
  const { id } = await params;
  const sp = (await searchParams) || {};
  const data = await loadBranchData(id, 'fare-rules');
  const { currentUser, branch, branches, tiers, extra, orderTypeFeeGroups } = data;

  return (
    <AppShell currentUser={currentUser} activePath="/branches">
      <BranchSettingsShell
        branch={branch} branches={branches} active="fare" formId="fareForm"
        title="탁송 요금"
        sub="거리 기반 자동요금 계산 규칙입니다. 계산식: 기본요금 + (거리 − 기준거리) × (할증요금 ÷ 할증단위)"
      >
        {sp.error ? <div className="alert error">{sp.error}</div> : null}

        <div className="card">
          <div className="section-title">📋 다른 지사 요금표 복사</div>
          {/* 덮어쓰기라 되돌릴 수 없다 — 확인을 세운다(EJS와 같은 문구). */}
          <CopyForm branchId={branch.id} branches={branches} />
        </div>

        <form id="fareForm" method="POST" action={`/branches/${branch.id}/fare-rules`}>
          <div className="card">
            <div className="section-title">📏 거리 구간별 요금 규칙</div>
            <DistanceTierTable tiers={tiers} branchId={branch.id} withRepresentative />
          </div>

          <div className="card">
            <div className="section-title">➕ 부가 요금 / 노출 설정 <span className="hint">(대기·취소요금은 탁송 전용)</span></div>
            <div className="row">
              <div className="field"><label>왕복 비율(%, 편도 대비)</label>
                <input type="number" name="round_trip_ratio" defaultValue={extra.round_trip_ratio || 180} min={0} /></div>
              <div className="field"><label>대기 기준시간(분) · 탁송</label>
                <input type="number" name="wait_threshold_min" defaultValue={extra.wait_threshold_min || 15} min={0} /></div>
              <div className="field"><label>대기요금(원) · 탁송</label>
                <input type="number" name="wait_fee" defaultValue={extra.wait_fee || 0} min={0} /></div>
            </div>
            <div className="row">
              {/* 취소요금은 1,000원 단위로 받는다(사용자 확정) — 법인 화면도 같다. */}
              <div className="field"><label>배차 전 취소요금(원) · 탁송</label>
                <input type="number" name="cancel_before_fee" defaultValue={extra.cancel_before_fee || 0} min={0} step={1000} /></div>
              <div className="field"><label>배차 후 취소요금(원) · 탁송</label>
                <input type="number" name="cancel_after_fee" defaultValue={extra.cancel_after_fee || 0} min={0} step={1000} /></div>
            </div>
            <div className="row">
              <div className="field"><label className="checkline">
                <input type="checkbox" name="fare_table_enabled" value="1" defaultChecked={!!extra.fare_table_enabled} />
                {' '}이 요금표 사용 (미사용 시 요금을 수동으로 입력)</label></div>
              <div className="field"><label className="checkline">
                <input type="checkbox" name="fare_visible_to_client" value="1" defaultChecked={extra.fare_visible_to_client !== 0} />
                {' '}고객사(딜러)에게 요금 노출</label></div>
              <div className="field"><label className="checkline">
                <input type="checkbox" name="fare_editable_by_client" value="1" defaultChecked={!!extra.fare_editable_by_client} />
                {' '}고객사(딜러)의 금액 수정 허용</label></div>
            </div>
          </div>

          <OrderTypeTripFees groups={orderTypeFeeGroups} extra={extra} />
          <FareSurchargeSettings {...data} />
        </form>

        {sp.saved === '1' && <div className="toast">저장되었습니다.</div>}
        {sp.copied === '1' && (
          <div className="toast">{sp.from ? `${sp.from} 지사의 요금표를 복사했습니다.` : '요금표를 복사했습니다.'}</div>
        )}
      </BranchSettingsShell>
    </AppShell>
  );
}

// 다른 지사 요금표 복사 — 덮어쓰기라 확인을 받는다.
function CopyForm({ branchId, branches }) {
  return (
    <ConfirmForm message="선택한 지사의 요금표로 현재 지사 설정을 덮어쓸까요?"
      method="POST" action={`/branches/${branchId}/fare-rules/copy`}>
      <div className="row">
        <div className="field">
          <label>원본 지사 선택</label>
          <select name="source_branch_id" required defaultValue="">
            <option value="">선택하세요</option>
            {branches.filter((b) => b.id !== branchId).map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
        <div className="field" style={{ display: 'flex', alignItems: 'flex-end' }}>
          <button className="btn secondary" type="submit">이 지사로 요금표 복사</button>
        </div>
      </div>
      <p className="page-sub" style={{ marginTop: 8 }}>구간요금 규칙과 부가 요금/노출 설정이 함께 복사됩니다.</p>
    </ConfirmForm>
  );
}
