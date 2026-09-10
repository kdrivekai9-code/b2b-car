// 배차지연 알림(법인) — views/groups/dispatch_delay.ejs의 Next 판.
//
// **옵트인이다.** 등록하지 않으면 아무 일도 일어나지 않고, 지사 기본값을 물려받지도 않는다 —
// 화면이 그 사실을 먼저 밝힌다.
import AppShell from '../../../_components/AppShell';
import ConfirmForm from '../../../_components/ConfirmForm';
import GroupSettingsShell from '../../_components/GroupSettingsShell';
import loadGroupData from '../../_components/loadGroupData';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

const STYLES = '.checkline.inline { display: inline-flex; align-items: center; gap: 4px; }';

export default async function GroupDispatchDelayPage({ params, searchParams }) {
  const { id } = await params;
  const sp = (await searchParams) || {};
  const { currentUser, group, groups, setting, callTypes, selected } = await loadGroupData(id, 'dispatch-delay');

  return (
    <AppShell currentUser={currentUser} activePath="/groups">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <GroupSettingsShell
        group={group} groups={groups} active="dispatch_delay" formId="delayForm"
        title="배차지연 알림"
        sub="배차가 지연될 때 챗봇이 고객에게 먼저 안내하고 요금 상향을 제안합니다."
      >
        {sp.error ? <div className="error-msg">{sp.error}</div> : null}
        {sp.notice ? <div className="success-msg">{sp.notice}</div> : null}

        <div className="card">
          <div className="section-title">📌 현재 상태</div>
          {setting ? (
            <p className="page-sub" style={{ margin: 0 }}>이 법인에 <b>선제 안내가 켜져 있습니다.</b></p>
          ) : (
            <p className="page-sub" style={{ margin: 0 }}>
              등록된 설정이 없어 이 법인에는 <b>선제 안내가 나가지 않습니다.</b>
              배차지연 안내는 등록한 법인에만 나가는 옵트인 기능이라, 지사 기본값을 물려받지 않습니다.
            </p>
          )}
        </div>

        <form id="delayForm" method="POST" action={`/groups/${group.id}/dispatch-delay`}>
          <div className="card">
            <div className="section-title">⏱ 지연 판단과 상향 금액</div>
            <div className="field">
              <label>적용할 콜 유형</label>
              <div className="var-chip-row" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {callTypes.map((t) => (
                  <label className="checkline inline" key={t.key}>
                    <input type="checkbox" name="call_types" value={t.key} defaultChecked={selected.includes(t.key)} />
                    {' '}{t.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="row">
              <div className="field">
                <label>배차지연 판단 시간(분)</label>
                <input type="number" name="delay_minutes" defaultValue={setting ? setting.delay_minutes : 5}
                  min={1} max={120} step={1} required />
                <span className="hint">&quot;접수&quot; 상태로 이 시간이 지나면 지연으로 봅니다.</span>
              </div>
              <div className="field">
                <label>요금 상향금액(원)</label>
                <input type="number" name="raise_amount" defaultValue={setting ? setting.raise_amount : 3000}
                  min={1000} max={10000} step={1000} required />
                <span className="hint">1,000원 단위로 10,000원까지</span>
              </div>
            </div>
          </div>
        </form>

        {setting && (
          <div className="card">
            <ConfirmForm message="이 법인의 배차지연 선제 안내를 끌까요?"
              method="POST" action={`/groups/${group.id}/dispatch-delay/delete`}>
              <button className="btn small secondary" type="submit">선제 안내 끄기</button>
            </ConfirmForm>
          </div>
        )}
      </GroupSettingsShell>
    </AppShell>
  );
}
