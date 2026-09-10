// 프리미엄(대리) 요금(법인) — views/groups/premium_fare_rules.ejs의 Next 판.
//
// 법인대리(프리미엄)는 편도 서비스라 탁송과 같은 거리 기준이다. 옆 탭의 일일기사는 이용
// 시간 기준인 다른 상품이다 — 두 표를 섞으면 청구가 어긋난다.
import AppShell from '../../../_components/AppShell';
import ConfirmForm from '../../../_components/ConfirmForm';
import DistanceTierTable from '../../../branches/_components/DistanceTierTable';
import GroupSettingsShell from '../../_components/GroupSettingsShell';
import loadGroupData from '../../_components/loadGroupData';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function GroupPremiumFareRulesPage({ params, searchParams }) {
  const { id } = await params;
  const sp = (await searchParams) || {};
  const { currentUser, group, groups, tiers, branchTiers } = await loadGroupData(id, 'premium-fare-rules');

  return (
    <AppShell currentUser={currentUser} activePath="/groups">
      <GroupSettingsShell
        group={group} groups={groups} active="premium_fare" formId="premiumOnewayFareForm"
        title="프리미엄(대리) 요금"
        sub={<>법인대리(프리미엄)는 <b>편도 서비스</b>라 탁송과 같은 거리 기준입니다. 이용 시간 기준인 <b>일일기사</b>와는 다른 표입니다.</>}
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
                이 법인에 등록된 요금표가 없어 <b>소속 지사({group.branch_name || '-'})의 프리미엄(대리) 요금표</b>가 적용됩니다.
                (지사 구간 {branchTiers.length}개)
              </p>
              {branchTiers.length > 0 ? (
                <ConfirmForm message="소속 지사 요금표를 이 법인으로 복사할까요?"
                  method="POST" action={`/groups/${group.id}/premium-fare-rules/copy`} style={{ marginTop: 10 }}>
                  <button className="btn secondary" type="submit">소속 지사 요금표 가져오기</button>
                </ConfirmForm>
              ) : (
                <p className="page-sub" style={{ marginBottom: 0 }}>
                  지사에도 등록된 표가 없습니다 — 프리미엄대리 오더는 <b>자동계산 없이 수동 입력</b>이 되고,
                  챗봇 요금 문의는 &quot;등록되어 있지 않습니다&quot;로 안내한 뒤 상담원 연결을 제안합니다.
                  탁송 요금표로 대신 계산하지는 않습니다(계약과 다른 금액이 조용히 청구되기 때문입니다).
                </p>
              )}
            </>
          )}
        </div>

        <form id="premiumOnewayFareForm" method="POST" action={`/groups/${group.id}/premium-fare-rules`}>
          <div className="card">
            <div className="section-title">📏 거리 구간별 요금</div>
            <p className="page-sub">계산식: 기본요금 + (거리 − 기준거리) × (할증요금 ÷ 할증단위)</p>
            <DistanceTierTable tiers={tiers} withNote />
          </div>
        </form>

        {sp.saved === '1' && <div className="toast">저장되었습니다.</div>}
        {sp.copied === '1' && <div className="toast">소속 지사 요금표를 가져왔습니다.</div>}
      </GroupSettingsShell>
    </AppShell>
  );
}
