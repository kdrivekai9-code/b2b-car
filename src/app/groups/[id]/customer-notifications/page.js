// 고객 통보(법인) — views/groups/customer_notifications.ejs의 Next 판.
//
// 사건 블록은 지사 화면과 같은 부품을 쓴다(_components/NotificationEvents) — EJS도 같은
// 이유로 파티셜이다. 복사해두면 변수 칩 하나를 늘려도 한쪽만 고쳐 갈라진다.
import AppShell from '../../../_components/AppShell';
import ConfirmForm from '../../../_components/ConfirmForm';
import NotificationEvents from '../../../_components/NotificationEvents';
import GroupSettingsShell from '../../_components/GroupSettingsShell';
import loadGroupData from '../../_components/loadGroupData';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function GroupCustomerNotificationsPage({ params, searchParams }) {
  const { id } = await params;
  const sp = (await searchParams) || {};
  const { currentUser, group, groups, events, variables, hasOwnSettings } =
    await loadGroupData(id, 'customer-notifications');

  return (
    <AppShell currentUser={currentUser} activePath="/groups">
      <GroupSettingsShell
        group={group} groups={groups} active="customer_notifications" formId="groupNotificationsForm"
        title="고객 통보"
        sub="오더 상태가 바뀌면 고객에게 먼저 안내합니다. 상태별로 사용 여부·보내는 시점·문구를 정합니다."
      >
        {sp.error ? <div className="error-msg">{sp.error}</div> : null}
        {sp.notice ? <div className="success-msg">{sp.notice}</div> : null}

        {/* 비어 있을 때 무엇이 적용되는지 밝힌다 — 빈 화면만 보이면 통보가 꺼진 줄 안다. */}
        <div className="card">
          <div className="section-title">📌 현재 적용되는 설정</div>
          {hasOwnSettings ? (
            <>
              <p className="page-sub" style={{ margin: 0 }}><b>이 법인 전용 통보 설정</b>이 적용됩니다.</p>
              <ConfirmForm message="법인 설정을 지우고 소속 지사 설정을 따르게 할까요?"
                method="POST" action={`/groups/${group.id}/customer-notifications/reset`} style={{ marginTop: 10 }}>
                <button className="btn secondary" type="submit">지사 설정으로 되돌리기</button>
              </ConfirmForm>
            </>
          ) : (
            <p className="page-sub" style={{ margin: 0 }}>
              이 법인에 저장된 설정이 없어 <b>소속 지사({group.branch_name || '-'})의 통보 설정</b>이 적용됩니다.
              아래 값은 그 지사 설정을 그대로 보여주는 것이며, 저장하면 이 법인 전용 설정이 됩니다.
            </p>
          )}
        </div>

        <div className="card">
          <form id="groupNotificationsForm" method="POST" action={`/groups/${group.id}/customer-notifications`}>
            <div className="section-title">🔔 상태별 고객 통보</div>
            <p className="page-sub">
              카카오 상담톡과 웹 챗봇으로 접수한 오더 모두에 나갑니다. 문구 위의 변수 버튼을 누르면
              커서 위치에 변수가 들어갑니다 — 값이 없으면 그 줄은 통째로 사라지므로
              <code>기사명: {'{driver_name}'}</code>처럼 <strong>&quot;라벨: 변수&quot;</strong> 꼴로 쓰는 것을 권합니다.
            </p>
            <NotificationEvents events={events} variables={variables}
              photoSettingsUrl={`/branches/${group.branch_id}/photo-settings`} />
          </form>
        </div>
      </GroupSettingsShell>
    </AppShell>
  );
}
