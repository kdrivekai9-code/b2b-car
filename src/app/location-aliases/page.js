import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../_components/AppShell';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function LocationAliasesPage() {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/location-aliases/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('거점 별칭 데이터를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, aliases } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/location-aliases">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">거점 별칭 관리</h1>
          <p className="page-sub">자주 사용하는 주소에 별칭을 등록해 빠른 검색을 지원합니다.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn" href="/location-aliases/new">+ 거점 등록</a>
        </div>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>거점명</th><th>주소</th><th>별칭</th><th>소속 지사</th><th>관리</th></tr>
            </thead>
            <tbody>
              {aliases.length === 0 && (
                <tr><td colSpan={5} className="empty">등록된 거점 별칭이 없습니다.</td></tr>
              )}
              {aliases.map((a) => (
                <tr key={a.id}>
                  <td>{a.canonical_name}</td>
                  <td>{a.address || '-'}</td>
                  <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.aliases || '-'}</td>
                  <td>{a.branch_name}</td>
                  <td>
                    <div className="table-actions">
                      <a className="btn small secondary" href={'/location-aliases/' + a.id + '/edit'}>수정</a>
                      <form method="POST" action={'/location-aliases/' + a.id + '/delete'} style={{ display: 'inline' }}>
                        <button className="btn small secondary" type="submit">삭제</button>
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
