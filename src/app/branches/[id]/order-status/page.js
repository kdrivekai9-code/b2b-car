// 오더 상태 설정 — views/branches/order_status.ejs의 Next 판.
import AppShell from '../../../_components/AppShell';
import BranchSettingsShell from '../../_components/BranchSettingsShell';
import loadBranchData from '../../_components/loadBranchData';
import { STATUS_COLORS } from '../../../_lib/statusColors';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function BranchOrderStatusPage({ params }) {
  const { id } = await params;
  const { currentUser, branch, branches, statuses } = await loadBranchData(id, 'order-status');

  return (
    <AppShell currentUser={currentUser} activePath="/branches">
      <BranchSettingsShell
        branch={branch} branches={branches} active="status" formId="statusForm"
        title="오더 상태 설정"
        sub="이 지사에서 고객사에게 노출할 상태와, 백오피스 전용(고객 비노출) 상태를 설정하세요."
      >
        <div className="card">
          <form id="statusForm" method="POST" action={`/branches/${branch.id}/order-status`}>
            <div className="table-wrap">
              <table>
                <thead><tr><th>상태</th><th>고객사 노출</th><th>백오피스 전용</th></tr></thead>
                <tbody>
                  {statuses.map((s) => (
                    <tr key={s.status_code}>
                      <td><span className={'badge ' + (STATUS_COLORS[s.status_code] || 'gray')}>{s.status_code}</span></td>
                      <td><input type="checkbox" name="customer_visible" value={s.status_code} defaultChecked={!!s.is_customer_visible} /></td>
                      <td><input type="checkbox" name="backoffice_only" value={s.status_code} defaultChecked={!!s.is_backoffice_only} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </form>
        </div>
      </BranchSettingsShell>
    </AppShell>
  );
}
