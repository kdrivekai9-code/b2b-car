import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../_components/AppShell';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

const ROLE_LABEL = { admin: '관리자', branch_manager: '지사장', client: '클라이언트' };

export default async function UsersPage() {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/users/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('사용자 데이터를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, users } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/users">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">사용자 관리</h1>
          <p className="page-sub">시스템 사용자 계정을 관리합니다.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn" href="/users/new">+ 사용자 등록</a>
        </div>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>아이디</th><th>이름</th><th>역할</th><th>지사</th><th>법인</th>
                <th>등급</th><th>연락처</th><th>상태</th><th>접속</th><th>관리</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr><td colSpan={10} className="empty">등록된 사용자가 없습니다.</td></tr>
              )}
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.login_id}</td>
                  <td>{u.name}</td>
                  <td>{ROLE_LABEL[u.role] || u.role}</td>
                  <td>{u.branch_name || '-'}</td>
                  <td>{u.group_name || '-'}</td>
                  <td>{u.grade === 'leader' ? '법인 담당(리더)' : u.grade === 'member' ? '법인 담당(일반)' : '-'}</td>
                  <td>{u.phone || '-'}</td>
                  <td><span className={'badge ' + (u.status === 'active' ? 'green' : 'gray')}>{u.status === 'active' ? '활성' : '비활성'}</span></td>
                  <td><span className={'badge ' + (u.is_logged_in ? 'blue' : 'gray')}>{u.is_logged_in ? '로그인 중' : '오프라인'}</span></td>
                  <td>
                    <div className="table-actions">
                      <a className="btn small secondary" href={'/users/' + u.id + '/edit'}>수정</a>
                      <form method="POST" action={'/users/' + u.id + '/revoke-session'} style={{ display: 'inline' }}>
                        <button className="btn small secondary" type="submit" disabled={!u.is_logged_in}>세션 만료</button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
