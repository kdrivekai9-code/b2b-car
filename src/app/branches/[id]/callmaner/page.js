// 콜마너 연동 — views/branches/callmaner.ejs의 Next 판.
import AppShell from '../../../_components/AppShell';
import BranchSettingsShell from '../../_components/BranchSettingsShell';
import loadBranchData from '../../_components/loadBranchData';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function BranchCallmanerPage({ params }) {
  const { id } = await params;
  const { currentUser, branch, branches } = await loadBranchData(id, 'callmaner');

  return (
    <AppShell currentUser={currentUser} activePath="/branches">
      <BranchSettingsShell
        branch={branch} branches={branches} active="callmaner" formId="callmanerForm"
        title="콜마너 연동"
        sub="이 지사에서 등록되는 오더를 콜마너(외부 배차사)에도 자동으로 접수하고, 콜마너 쪽 상태 변경을 오더리스트에 반영합니다."
      >
        <div className="card">
          <form id="callmanerForm" method="POST" action={`/branches/${branch.id}/callmaner`}>
            <div className="section-title">🔗 콜마너 연동 설정</div>
            <div className="field">
              <label className="checkline">
                <input type="checkbox" name="callmaner_enabled" value="1" defaultChecked={!!branch.callmaner_enabled} />
                {' '}이 지사의 오더를 콜마너에 연동한다
              </label>
            </div>
            <div className="field full">
              <label>providerId</label>
              <input type="text" name="callmaner_provider_id" defaultValue={branch.callmaner_provider_id || ''}
                placeholder="예: B100-12345-AP12345" />
              <p className="page-sub">콜마너가 발급해준 providerId 전체 문자열을 그대로 입력하세요(콜마너 자체 지사코드-대표번호-관련어플코드로 구성되며, 우리 지사코드/대표번호와는 무관합니다).</p>
            </div>
          </form>
        </div>
      </BranchSettingsShell>
    </AppShell>
  );
}
