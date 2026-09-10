// 계정정보(법인) — views/groups/accounts.ejs의 Next 판.
import AppShell from '../../../_components/AppShell';
import ConfirmForm from '../../../_components/ConfirmForm';
import GroupSettingsShell from '../../_components/GroupSettingsShell';
import loadGroupData from '../../_components/loadGroupData';
import AccountForm from './AccountForm';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

const ROLE_LABELS = { admin: '관리자', branch_manager: '지사장', client: '클라이언트' };

export default async function GroupAccountsPage({ params, searchParams }) {
  const { id } = await params;
  const sp = (await searchParams) || {};
  const { currentUser, group, groups, users, branches, editing, clientTypes } =
    // ?edit=은 서버가 읽어 "수정 중인 계정"을 정한다 — 주소창 값을 그대로 넘긴다.
    await loadGroupData(id, 'accounts', sp);

  return (
    <AppShell currentUser={currentUser} activePath="/groups">
      <GroupSettingsShell
        group={group} groups={groups} active="accounts"
        title="계정정보" sub="이 법인 소속으로 등록된 계정입니다. 등록하면 법인이 자동으로 지정됩니다."
      >
        {sp.error ? <div className="alert error">{sp.error}</div> : null}
        {sp.notice ? <div className="alert success">{sp.notice}</div> : null}

        <div className="card">
          <div className="section-title">{editing ? '계정 수정' : '계정 등록'}</div>
          <AccountForm group={group} branches={branches} editing={editing} clientTypes={clientTypes} />
        </div>

        <div className="card">
          <div className="section-title">등록된 계정 {users.length}개</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>아이디</th><th>법인</th><th>이름</th><th>역할</th><th>구분</th><th>지사</th><th>연락처</th><th>상태</th><th>관리</th></tr></thead>
              <tbody>
                {!users.length && <tr><td colSpan={9} className="empty">등록된 계정이 없습니다.</td></tr>}
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.login_id}</td>
                    <td>{u.group_name || '-'}</td>
                    <td>{u.name}</td>
                    <td>{ROLE_LABELS[u.role] || u.role}</td>
                    <td>
                      {u.role !== 'client' ? '-' : u.client_type === 'dealer' ? (
                        <>
                          <span className="badge blue">개인 딜러</span>
                          {/* 별도청구 여부는 정산서가 몇 장 나오는지를 정한다 — 목록에서 바로 보여야 한다. */}
                          {u.separate_settlement ? <span className="badge amber">별도 정산</span> : null}
                        </>
                      ) : <span className="badge gray">본사 직원</span>}
                    </td>
                    <td>{u.branch_name || '-'}</td>
                    <td>{u.phone || '-'}</td>
                    <td><span className={'badge ' + (u.status === 'active' ? 'green' : 'gray')}>{u.status === 'active' ? '활성' : '비활성'}</span></td>
                    <td>
                      <div className="table-actions">
                        <a className="btn small secondary" href={`/groups/${group.id}/accounts?edit=${u.id}`}>수정</a>
                        {/* 삭제 대신 비활성화다 — 이 계정으로 접수된 오더·상담 이력이 남아
                            있어서 행을 지우면 이력에서 사용자명이 사라진다(사용자 확정). */}
                        <ConfirmForm message={`${u.name} 계정을 ${u.status === 'active' ? '비활성화' : '활성화'}할까요?`}
                          method="POST" action={`/groups/${group.id}/accounts/${u.id}/status`} style={{ display: 'inline' }}>
                          <button className="btn small secondary" type="submit">{u.status === 'active' ? '비활성화' : '활성화'}</button>
                        </ConfirmForm>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="page-sub" style={{ marginBottom: 0 }}>계정은 삭제하지 않고 비활성화합니다 — 그 계정으로 접수된 오더·상담 이력이 남아 있어서, 지우면 이력에서 사용자명이 사라집니다.</p>
        </div>
      </GroupSettingsShell>
    </AppShell>
  );
}
