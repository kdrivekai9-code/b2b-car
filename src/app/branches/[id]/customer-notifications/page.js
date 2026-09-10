// 고객 통보(지사) — views/branches/customer_notifications.ejs의 Next 판.
//
// 사건 블록은 법인 화면과 공유하는 부품이다(_components/NotificationEvents) — EJS도 같은
// 이유로 파티셜이다. 복사해두면 변수 칩 하나를 늘려도 한쪽만 고쳐 갈라진다.
import AppShell from '../../../_components/AppShell';
import NotificationEvents from '../../../_components/NotificationEvents';
import BranchSettingsShell from '../../_components/BranchSettingsShell';
import loadBranchData from '../../_components/loadBranchData';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function BranchCustomerNotificationsPage({ params, searchParams }) {
  const { id } = await params;
  const sp = (await searchParams) || {};
  const {
    currentUser, branch, branches, events, variables,
    agentIdleReleaseMinutes, defaultAgentIdleReleaseMinutes,
  } = await loadBranchData(id, 'customer-notifications');

  return (
    <AppShell currentUser={currentUser} activePath="/branches">
      <BranchSettingsShell
        branch={branch} branches={branches} active="customer_notifications" formId="customerNotificationsForm"
        title="고객 통보"
        sub="오더 상태가 바뀌면 고객에게 먼저 안내합니다. 상태별로 사용 여부·보내는 시점·문구를 정합니다."
      >
        {sp.error ? <div className="error-msg">{sp.error}</div> : null}
        {sp.notice ? <div className="success-msg">{sp.notice}</div> : null}

        <div className="card">
          <form id="customerNotificationsForm" method="POST" action={`/branches/${branch.id}/customer-notifications`}>
            <div className="section-title">🔔 상태별 고객 통보</div>
            <p className="page-sub">
              카카오 상담톡과 웹 챗봇으로 접수한 오더 모두에 나갑니다. 문구 위의 변수 버튼을 누르면
              커서 위치에 변수가 들어갑니다 — 값이 없으면 그 줄은 통째로 사라지므로
              <code>기사명: {'{driver_name}'}</code>처럼 <strong>&quot;라벨: 변수&quot;</strong> 꼴로 쓰는 것을 권합니다.
            </p>

            <div className="notify-event-block">
              <div className="row">
                <div className="field">
                  <label>봇 응대 복귀 시간</label>
                  <div className="delay-minutes-input">
                    <span>상담원 대화가</span>
                    <input type="number" name="agent_idle_release_minutes" defaultValue={agentIdleReleaseMinutes}
                      min={0} max={1440} step={1} required />
                    <span>분 동안 없으면 봇으로</span>
                  </div>
                  <p className="page-sub">
                    고객이 상담원 연결을 요청한 뒤 대화가 끊기면 세션이 계속 상담원 상태로 남습니다.
                    이 시간이 지나면 봇 응대로 되돌려, 고객이 다시 말을 걸었을 때 봇이 답할 수 있게 합니다.
                    방금 상담원이 답한 대화는 대상이 아닙니다. <strong>0</strong>으로 두면 자동 복귀를 하지 않습니다
                    (기본 {defaultAgentIdleReleaseMinutes}분).
                  </p>
                </div>
              </div>
            </div>

            <NotificationEvents events={events} variables={variables}
              photoSettingsUrl={`/branches/${branch.id}/photo-settings`} />
          </form>
        </div>
      </BranchSettingsShell>
    </AppShell>
  );
}
