// 결제방식 설정 — views/branches/payment_methods.ejs의 Next 판.
import AppShell from '../../../_components/AppShell';
import BranchSettingsShell from '../../_components/BranchSettingsShell';
import loadBranchData from '../../_components/loadBranchData';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function BranchPaymentMethodsPage({ params }) {
  const { id } = await params;
  const { currentUser, branch, branches, allMethods, enabledMap } = await loadBranchData(id, 'payment-methods');

  return (
    <AppShell currentUser={currentUser} activePath="/branches">
      <BranchSettingsShell
        branch={branch} branches={branches} active="payment" formId="pmForm"
        title="결제방식 설정"
        sub="이 지사 오더 등록 화면에 노출할 결제수단과 기본값을 선택하세요. 하나도 선택하지 않으면 전체 결제수단이 노출됩니다."
      >
        <div className="card">
          <form id="pmForm" method="POST" action={`/branches/${branch.id}/payment-methods`}>
            <div className="section-title">💳 노출할 결제수단</div>
            {allMethods.map((pm) => (
              <div className="checkline" style={{ fontSize: 13, marginBottom: 8 }} key={pm.id}>
                {/* enabledMap에 키가 있으면 노출, 값이 1이면 기본값 — EJS와 같은 규칙이다. */}
                <input type="checkbox" name="payment_method_ids" value={pm.id} id={`pm_${pm.id}`}
                  defaultChecked={enabledMap[pm.id] !== undefined} />
                <label htmlFor={`pm_${pm.id}`} style={{ fontWeight: 400 }}>{pm.name}</label>
                &nbsp;&nbsp;
                <label className="checkline" style={{ display: 'inline-flex' }}>
                  <input type="radio" name="default_payment_method_id" value={pm.id}
                    defaultChecked={enabledMap[pm.id] === 1} /> 기본값
                </label>
              </div>
            ))}
          </form>
        </div>
      </BranchSettingsShell>
    </AppShell>
  );
}
