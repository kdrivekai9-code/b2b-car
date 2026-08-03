import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../../_components/AppShell';
import { fetchExpressJson } from '../../../_lib/internalFetch';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

const ROLE_LABEL = { admin: '관리자', branch_manager: '지사장', client: '클라이언트' };

export default async function GroupUsersPage({ params }) {
  const { id } = await params;
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetchExpressJson(`/groups/${id}/users/data.json`, { proto, host, cookie: hdrs.get('cookie') });
  if (res.status === 401) redirect('/login');
  if (res.status === 404) throw new Error('법인을 찾을 수 없습니다.');
  if (!res.ok) throw new Error('법인 사용자 정보를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, group, users } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/groups">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">법인 사용자 리스트</h1>
          <p className="page-sub"><b>{group.name}</b>에 등록된 사용자 목록입니다.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/groups">법인 관리로</a>
          <a className="btn secondary" href={`/groups/${group.id}/edit`}>법인정보</a>
          <a className="btn" href="/users/new">+ 사용자 등록</a>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div><b>소속 지사:</b> {group.branch_name || '-'}</div>
          <div><b>대표번호:</b> {group.main_phone || '-'}</div>
          <div><b>사업자번호:</b> {group.business_registration_number || '-'}</div>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>아이디</th><th>이름</th><th>역할</th><th>지사</th><th>연락처</th><th>상태</th><th>관리</th></tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr><td colSpan={7} className="empty">해당 법인에 등록된 사용자가 없습니다.</td></tr>
              )}
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.login_id}</td>
                  <td>{u.name}</td>
                  <td>{ROLE_LABEL[u.role] || u.role}</td>
                  <td>{u.branch_name || '-'}</td>
                  <td>{u.phone || '-'}</td>
                  <td><span className={'badge ' + (u.status === 'active' ? 'green' : 'gray')}>{u.status === 'active' ? '활성' : '비활성'}</span></td>
                  <td><a className="btn small secondary" href={'/users/' + u.id + '/edit'}>수정</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
