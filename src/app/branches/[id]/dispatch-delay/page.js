// 배차지연 알림 — views/branches/dispatch_delay.ejs의 Next 판.
//
// 챗봇이 "배차가 지연되고 있으니 요금을 올릴까요?"라고 먼저 제안할 대상을 법인 단위로
// 등록한다. 등록되지 않은 고객사에는 선제 안내가 나가지 않는다(옵트인).
import AppShell from '../../../_components/AppShell';
import ConfirmForm from '../../../_components/ConfirmForm';
import BranchSettingsShell from '../../_components/BranchSettingsShell';
import loadBranchData from '../../_components/loadBranchData';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

// 1,000원 단위, 최대 10,000원(EJS와 같다).
const RAISE_AMOUNTS = Array.from({ length: 10 }, (_, i) => (i + 1) * 1000);

export default async function BranchDispatchDelayPage({ params, searchParams }) {
  const { id } = await params;
  const sp = (await searchParams) || {};
  const { currentUser, branch, branches, groups, settings, callTypes } = await loadBranchData(id, 'dispatch-delay');

  return (
    <AppShell currentUser={currentUser} activePath="/branches">
      <BranchSettingsShell
        branch={branch} branches={branches} active="dispatch_delay" formId="dispatchDelayForm"
        title="배차지연 알림"
        sub="배차가 지연될 때 챗봇이 고객에게 먼저 안내하고 요금 상향을 제안합니다. 여기에 등록된 고객사에만 안내가 나갑니다."
      >
        {sp.error ? <div className="error-msg">{sp.error}</div> : null}
        {sp.notice ? <div className="success-msg">{sp.notice}</div> : null}

        <div className="card">
          <form id="dispatchDelayForm" method="POST" action={`/branches/${branch.id}/dispatch-delay`}>
            <div className="section-title">🔔 배차 지연시간 챗봇안내</div>

            <div className="row">
              <div className="field">
                <label>선택고객 <span className="req">*</span></label>
                <select name="group_id" required defaultValue="">
                  <option value="">고객사를 선택하세요</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}{g.main_phone ? ` (${g.main_phone})` : ''}</option>
                  ))}
                </select>
                <p className="page-sub">이 지사에 등록된 법인고객사만 선택할 수 있습니다. 이미 등록된 고객사를 다시 선택하면 기존 설정이 갱신됩니다.</p>
              </div>
              <div className="field">
                <label>배차지연 판단 <span className="req">*</span></label>
                <div className="delay-minutes-input">
                  <span>접수 후</span>
                  <input type="number" name="delay_minutes" defaultValue={5} min={1} max={120} step={1} required />
                  <span>분 미배차</span>
                </div>
                <p className="page-sub">접수 상태에서 이 시간이 지나도 기사가 배정되지 않으면 지연으로 봅니다(대기·예약 건은 제외).</p>
              </div>
            </div>

            <div className="row">
              <div className="field">
                <label>선택대상 <span className="req">*</span></label>
                <div className="call-type-choices">
                  {callTypes.map((t) => (
                    <label className="checkline" key={t.key}>
                      <input type="checkbox" name="call_types" value={t.key} defaultChecked={t.key === 'corporate_call'} />
                      {' '}{t.label}
                    </label>
                  ))}
                </div>
                <p className="page-sub">선택한 콜 유형의 주문에만 적용됩니다(중복 선택 가능).</p>
              </div>
              <div className="field">
                <label>요금 상향금액 <span className="req">*</span></label>
                <select name="raise_amount" required defaultValue={5000}>
                  {RAISE_AMOUNTS.map((a) => (
                    <option key={a} value={a}>{a.toLocaleString('ko-KR')}원</option>
                  ))}
                </select>
                <p className="page-sub">챗봇이 제안할 인상 금액입니다(1,000원 단위, 최대 10,000원).</p>
              </div>
            </div>
          </form>
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <div className="section-title">📋 업체별 등록 현황</div>
          {!settings.length ? (
            <p className="page-sub" style={{ margin: 0 }}>아직 등록된 고객사가 없습니다. 위에서 고객사를 선택해 등록해주세요.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>고객사</th><th>대표번호</th><th>선택대상</th>
                  <th>배차지연 판단</th><th>요금 상향금액</th><th>수정일시</th><th style={{ width: 80 }}></th>
                </tr>
              </thead>
              <tbody>
                {settings.map((s) => {
                  const keys = String(s.call_types || '').split(',').filter(Boolean);
                  const labels = callTypes.filter((t) => keys.includes(t.key)).map((t) => t.label);
                  return (
                    <tr key={s.id}>
                      <td>{s.group_name}</td>
                      <td>{s.group_phone || '-'}</td>
                      <td>{labels.join(', ') || '-'}</td>
                      <td>접수 후 {s.delay_minutes}분 미배차</td>
                      <td>{Number(s.raise_amount).toLocaleString('ko-KR')}원</td>
                      <td>{s.updated_at || s.created_at}</td>
                      <td>
                        <ConfirmForm message={`${s.group_name}의 배차지연 알림 설정을 삭제할까요?`}
                          method="POST" action={`/branches/${branch.id}/dispatch-delay/${s.id}/delete`}>
                          <button className="btn small danger" type="submit">삭제</button>
                        </ConfirmForm>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </BranchSettingsShell>
    </AppShell>
  );
}
