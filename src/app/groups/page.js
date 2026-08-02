import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../_components/AppShell';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function GroupsPage() {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/groups/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('법인 데이터를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, groups } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/groups">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">법인 관리</h1>
          <p className="page-sub">고객 법인 정보를 관리합니다.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn" href="/groups/new">+ 법인 등록</a>
        </div>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>법인명</th><th>대표번호</th><th>소속 지사</th><th>담당자</th><th>정산방식</th><th>관리</th></tr>
            </thead>
            <tbody>
              {groups.length === 0 && (
                <tr><td colSpan={6} className="empty">등록된 법인이 없습니다.</td></tr>
              )}
              {groups.map((g) => (
                <tr key={g.id}>
                  <td>{g.name}</td>
                  <td>{g.main_phone || '-'}</td>
                  <td>{g.branch_name}</td>
                  <td>{g.contact_name || '-'}{g.contact_phone ? ' · ' + g.contact_phone : ''}</td>
                  <td>{g.settlement_method || '-'}</td>
                  <td>
                    <div className="table-actions">
                      <a className="btn small secondary" href={'/groups/' + g.id + '/edit'}>수정</a>
                      <a className="btn small secondary" href={'/groups/' + g.id + '/users'}>구성원</a>
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
