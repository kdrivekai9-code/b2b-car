// 추가기능(사진 보기 권한) — views/branches/extra_settings.ejs의 Next 판.
import AppShell from '../../../_components/AppShell';
import BranchSettingsShell from '../../_components/BranchSettingsShell';
import loadBranchData from '../../_components/loadBranchData';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function BranchExtraSettingsPage({ params }) {
  const { id } = await params;
  const { currentUser, branch, branches, settings } = await loadBranchData(id, 'extra-settings');

  return (
    <AppShell currentUser={currentUser} activePath="/branches">
      <BranchSettingsShell
        branch={branch} branches={branches} active="extra" formId="extraForm"
        title="추가기능" sub="지사 단위의 부가 권한/기능을 설정하세요."
      >
        <div className="card">
          <form id="extraForm" method="POST" action={`/branches/${branch.id}/extra-settings`}>
            <div className="section-title">🔒 사진 보기 권한 (기본: 전체 차단)</div>
            <div className="row">
              <div className="field">
                <label className="checkline">
                  <input type="checkbox" name="client_can_view" value="1" defaultChecked={!!settings.client_can_view} />
                  {' '}고객사(딜러)에게 사진 열람 허용
                </label>
              </div>
              <div className="field">
                <label className="checkline">
                  <input type="checkbox" name="branch_manager_can_view" value="1" defaultChecked={!!settings.branch_manager_can_view} />
                  {' '}지사장에게 사진 열람 허용
                </label>
              </div>
            </div>
          </form>
        </div>
      </BranchSettingsShell>
    </AppShell>
  );
}
