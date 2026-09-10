// 운영시간 설정 — views/branches/operating_hours.ejs의 Next 판.
//
// 예외일 추가 폼의 "휴무" 체크에 따라 오픈/마감 칸을 감추는 동작만 클라이언트가 필요해
// 그 조각만 따로 뺐다(ExceptionForm).
import AppShell from '../../../_components/AppShell';
import ConfirmForm from '../../../_components/ConfirmForm';
import BranchSettingsShell from '../../_components/BranchSettingsShell';
import TimeSelects from '../../_components/TimeSelects';
import ExceptionForm from './ExceptionForm';
import loadBranchData from '../../_components/loadBranchData';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function BranchOperatingHoursPage({ params }) {
  const { id } = await params;
  const { currentUser, branch, branches, hours, exceptions } = await loadBranchData(id, 'operating-hours');

  return (
    <AppShell currentUser={currentUser} activePath="/branches">
      <BranchSettingsShell
        branch={branch} branches={branches} active="hours" formId="hoursForm"
        title="운영시간 설정"
        sub={<>운영시간 외에는 오더 등록이 자동으로 차단됩니다. 시간을 <b>--</b>로 비워두면 제한 없이 24시간 등록 가능합니다. 모든 시간은 <b>24시간제</b>(00시~23시)로 입력합니다 — 예) 낮 12시 = 12시, 자정 = 00시.</>}
      >
        <div className="card">
          <form id="hoursForm" method="POST" action={`/branches/${branch.id}/operating-hours`}>
            <div className="section-title">🕒 평일 / 주말</div>
            <div className="row">
              <div className="field"><label>평일 오픈</label><TimeSelects namePrefix="weekday_open" value={hours.weekday.open_time} /></div>
              <div className="field"><label>평일 마감</label><TimeSelects namePrefix="weekday_close" value={hours.weekday.close_time} /></div>
              <div className="field">
                <label className="checkline" style={{ marginTop: 24 }}>
                  <input type="checkbox" name="weekday_closed" defaultChecked={!!hours.weekday.is_closed} /> 평일 휴무
                </label>
              </div>
            </div>
            <div className="row">
              <div className="field"><label>주말 오픈</label><TimeSelects namePrefix="weekend_open" value={hours.weekend.open_time} /></div>
              <div className="field"><label>주말 마감</label><TimeSelects namePrefix="weekend_close" value={hours.weekend.close_time} /></div>
              <div className="field">
                <label className="checkline" style={{ marginTop: 24 }}>
                  <input type="checkbox" name="weekend_closed" defaultChecked={!!hours.weekend.is_closed} /> 주말 휴무
                </label>
              </div>
            </div>
          </form>
        </div>

        <div className="card">
          <div className="section-title">📅 일자별 예외 (임시휴무 · 특별 운영)</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>날짜</th><th>휴무</th><th>오픈</th><th>마감</th><th>메모</th><th>관리</th></tr></thead>
              <tbody>
                {exceptions.length === 0 && (
                  <tr><td colSpan={6} className="empty">등록된 예외일이 없습니다.</td></tr>
                )}
                {exceptions.map((e) => (
                  <tr key={e.id}>
                    <td>{e.date}</td>
                    <td>{e.is_closed ? '휴무' : '정상운영'}</td>
                    <td>{e.open_time || '-'}</td>
                    <td>{e.close_time || '-'}</td>
                    <td>{e.note || '-'}</td>
                    <td>
                      <ConfirmForm message={`${e.date} 예외일을 삭제하시겠습니까?`}
                        method="POST" action={`/branches/${branch.id}/operating-hours/exceptions/${e.id}/delete`}>
                        <button className="btn small secondary" type="submit">삭제</button>
                      </ConfirmForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="section-title small">예외일 추가</div>
          <ExceptionForm branchId={branch.id} />
        </div>
      </BranchSettingsShell>
    </AppShell>
  );
}
