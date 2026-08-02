import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../_components/AppShell';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function NoticesPage() {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/notices/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('공지사항 데이터를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, notices } = await res.json();
  const isAdmin = currentUser && currentUser.role === 'admin';

  return (
    <AppShell currentUser={currentUser} activePath="/notices">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">공지사항</h1>
          <p className="page-sub">전체 공지사항 목록입니다.</p>
        </div>
        {isAdmin && (
          <div className="page-head-actions">
            <a className="btn" href="/notices/new">+ 공지 등록</a>
          </div>
        )}
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>제목</th><th>작성자</th><th>등록일</th>{isAdmin && <th>관리</th>}</tr>
            </thead>
            <tbody>
              {notices.length === 0 && (
                <tr><td colSpan={isAdmin ? 4 : 3} className="empty">등록된 공지사항이 없습니다.</td></tr>
              )}
              {notices.map((n) => (
                <tr key={n.id}>
                  <td><a href={'/notices/' + n.id}>{n.title}</a></td>
                  <td>{n.author_name || '-'}</td>
                  <td>{n.created_at ? String(n.created_at).slice(0, 10) : '-'}</td>
                  {isAdmin && (
                    <td>
                      <div className="table-actions">
                        <a className="btn small secondary" href={'/notices/' + n.id + '/edit'}>수정</a>
                        <form method="POST" action={'/notices/' + n.id + '/delete'} style={{ display: 'inline' }}>
                          <button className="btn small secondary" type="submit">삭제</button>
                        </form>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
