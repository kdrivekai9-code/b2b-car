// 사진 업로드 안내 — views/branches/photo_settings.ejs의 Next 판.
import AppShell from '../../../_components/AppShell';
import BranchSettingsShell from '../../_components/BranchSettingsShell';
import loadBranchData from '../../_components/loadBranchData';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function BranchPhotoSettingsPage({ params }) {
  const { id } = await params;
  const { currentUser, branch, branches, settings } = await loadBranchData(id, 'photo-settings');

  return (
    <AppShell currentUser={currentUser} activePath="/branches">
      <BranchSettingsShell
        branch={branch} branches={branches} active="photo" formId="photoForm"
        title="사진 업로드 안내"
        sub="기사 사진 업로드 화면에 표시할 안내문구와 안내 이미지를 설정하세요."
      >
        <div className="card">
          <form id="photoForm" method="POST" action={`/branches/${branch.id}/photo-settings`}>
            <div className="section-title">🖼 사진 업로드 안내</div>
            <div className="field full">
              <label>안내 문구</label>
              <textarea name="guide_text" defaultValue={settings.guide_text || ''}
                placeholder="예) 차량 인도 시점 4방향 사진을 촬영해주세요." />
            </div>
            <div className="field full">
              <label>안내 이미지 URL</label>
              <input type="text" name="guide_image_url" defaultValue={settings.guide_image_url || ''} placeholder="https://..." />
            </div>
          </form>
        </div>
      </BranchSettingsShell>
    </AppShell>
  );
}
