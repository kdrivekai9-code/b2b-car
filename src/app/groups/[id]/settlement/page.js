// 정산내역(관리자) — views/groups/settlement.ejs의 Next 판.
//
// 본문은 고객용(/my/settlement)과 공유하는 부품이다(_components/settlement/SettlementView).
// EJS도 두 라우트가 같은 뷰를 렌더했다 — 본문을 복사하면 금액 표시를 고칠 때 한쪽만 바뀌고,
// 그건 곧 청구서가 갈리는 것이다.
import AppShell from '../../../_components/AppShell';
import SettlementView from '../../../_components/settlement/SettlementView';
import { ExcelLink, PrintButton } from '../../../_components/settlement/SettlementActions';
import GroupSettingsShell from '../../_components/GroupSettingsShell';
import loadGroupData from '../../_components/loadGroupData';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function GroupSettlementPage({ params, searchParams }) {
  const { id } = await params;
  const sp = (await searchParams) || {};
  const data = await loadGroupData(id, 'settlement', sp);
  const { currentUser, group, groups, month, surchargeMode } = data;

  return (
    <AppShell currentUser={currentUser} activePath="/groups">
      <GroupSettingsShell
        group={group} groups={groups} active="settlement"
        title="정산내역"
        sub={<>
          완료된 오더를 <b>완료일 기준</b>으로 묶었습니다. 금액은 업체별 계약 요금입니다(배차 요금 아님).
          {' '}할증 표시는 <b>{surchargeMode === 'itemized' ? '별도 줄(항목별)' : '운행요금 포함'}</b> 방식입니다.
        </>}
        actions={<>
          {/* 새 창으로 연다(사용자 지시) — 목록을 보던 화면을 잃지 않고 인쇄만 하고 닫을 수
              있어야 한다. 엑셀은 인쇄 앞에 둔다(사용자 지시). */}
          <ExcelLink base={`/groups/${group.id}/settlement`} month={month} />
          <PrintButton base={`/groups/${group.id}/settlement`} month={month} />
        </>}
      >
        <SettlementView data={data} sp={sp} base={`/groups/${group.id}/settlement`} />
      </GroupSettingsShell>
    </AppShell>
  );
}
