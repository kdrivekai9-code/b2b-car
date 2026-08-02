import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../_components/AppShell';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function DriversPage() {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/drivers/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('기사 데이터를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, drivers } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/drivers">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">기사 관리</h1>
          <p className="page-sub">탁송 기사 정보를 관리합니다.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn" href="/drivers/new">+ 기사 등록</a>
        </div>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>이름</th><th>연락처</th><th>소속 지사</th><th>상태</th><th>관리</th></tr>
            </thead>
            <tbody>
              {drivers.length === 0 && (
                <tr><td colSpan={5} className="empty">등록된 기사가 없습니다.</td></tr>
              )}
              {drivers.map((d) => (
                <tr key={d.id}>
                  <td>{d.name}</td>
                  <td>{d.phone || '-'}</td>
                  <td>{d.branch_name}</td>
                  <td><span className={'badge ' + (d.status === 'active' ? 'green' : 'gray')}>{d.status === 'active' ? '활성' : '비활성'}</span></td>
                  <td>
                    <div className="table-actions">
                      <a className="btn small secondary" href={'/drivers/' + d.id + '/edit'}>수정</a>
                      <form method="POST" action={'/drivers/' + d.id + '/toggle'} style={{ display: 'inline' }}>
                        <button className="btn small secondary" type="submit">{d.status === 'active' ? '비활성화' : '활성화'}</button>
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
