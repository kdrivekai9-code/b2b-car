import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../_components/AppShell';
import { fetchExpressJson } from '../../_lib/internalFetch';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function NoticeDetailPage({ params }) {
  const { id } = await params;
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetchExpressJson(`/notices/${id}/data.json`, { proto, host, cookie: hdrs.get('cookie') });
  if (res.status === 401) redirect('/login');
  if (res.status === 404) throw new Error('공지사항을 찾을 수 없습니다.');
  if (!res.ok) throw new Error('공지사항 정보를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, notice } = await res.json();
  const isAdmin = currentUser && currentUser.role === 'admin';

  return (
    <AppShell currentUser={currentUser} activePath="/notices">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">{notice.title}</h1>
          <p className="page-sub">{notice.author_name || '-'} · {notice.created_at}</p>
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/notices">&larr; 목록으로</a>
          {isAdmin && (
            <>
              <a className="btn secondary" href={`/notices/${notice.id}/edit`}>수정</a>
              <form method="POST" action={`/notices/${notice.id}/delete`} style={{ display: 'inline' }}>
                <button className="btn danger" type="submit">삭제</button>
              </form>
            </>
          )}
        </div>
      </div>
      <div className="card">
        <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7, fontSize: 14 }}>{notice.content}</p>
      </div>
    </AppShell>
  );
}
