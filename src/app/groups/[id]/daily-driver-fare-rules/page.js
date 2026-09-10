// 일일기사 요금(법인) — views/groups/daily_driver_fare_rules.ejs의 Next 판.
//
// 법인 표가 없으면 소속 지사 표가 적용된다(폴백). 그래서 화면이 **지금 무엇이 적용되고
// 있는지**를 먼저 밝힌다 — 빈 표만 보여주면 관리자는 요금이 0원인 줄 안다.
import AppShell from '../../../_components/AppShell';
import ConfirmForm from '../../../_components/ConfirmForm';
import HourTierTable from '../../../branches/_components/HourTierTable';
import GroupSettingsShell from '../../_components/GroupSettingsShell';
import loadGroupData from '../../_components/loadGroupData';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function GroupDailyDriverFareRulesPage({ params, searchParams }) {
  const { id } = await params;
  const sp = (await searchParams) || {};
  const { currentUser, group, groups, tiers, branchTiers } = await loadGroupData(id, 'daily-driver-fare-rules');

  return (
    <AppShell currentUser={currentUser} activePath="/groups">
      <GroupSettingsShell
        group={group} groups={groups} active="daily_driver_fare" formId="ddFareForm"
        title="일일기사 요금"
        sub="시간 구간 기반 요금입니다. 계산식: 기본요금 + (이용시간 − 기준시간) × 시간당 추가요금"
      >
        {sp.error ? <div className="alert error">{sp.error}</div> : null}

        <div className="card">
          <div className="section-title">📌 현재 적용되는 요금표</div>
          {tiers.length ? (
            <p className="page-sub" style={{ margin: 0 }}>
              <b>이 법인 전용 요금표</b>가 적용됩니다. (구간 {tiers.length}개)
            </p>
          ) : (
            <>
              <p className="page-sub" style={{ margin: 0 }}>
                이 법인에 등록된 요금표가 없어 <b>소속 지사({group.branch_name || '-'})의 일일기사 요금표</b>가 적용됩니다.
                (지사 구간 {branchTiers.length}개)
              </p>
              {branchTiers.length > 0 && (
                <ConfirmForm message="소속 지사 요금표를 이 법인으로 복사할까요?"
                  method="POST" action={`/groups/${group.id}/daily-driver-fare-rules/copy`} style={{ marginTop: 10 }}>
                  <button className="btn secondary" type="submit">소속 지사 요금표 가져오기</button>
                </ConfirmForm>
              )}
            </>
          )}
        </div>

        <form id="ddFareForm" method="POST" action={`/groups/${group.id}/daily-driver-fare-rules`}>
          <div className="card">
            <div className="section-title">⏱ 시간 구간별 요금</div>
            <HourTierTable tiers={tiers} />
          </div>
        </form>

        {sp.saved === '1' && <div className="toast">저장되었습니다.</div>}
        {sp.copied === '1' && <div className="toast">소속 지사 요금표를 가져왔습니다.</div>}
      </GroupSettingsShell>
    </AppShell>
  );
}
