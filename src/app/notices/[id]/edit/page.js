import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../../_components/AppShell';
import { fetchExpressJson } from '../../../_lib/internalFetch';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function EditNoticePage({ params }) {
  const { id } = await params;
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetchExpressJson(`/notices/${id}/edit/data.json`, { proto, host, cookie: hdrs.get('cookie') });
  if (res.status === 401) redirect('/login');
  if (res.status === 403) throw new Error('권한이 없습니다.');
  if (res.status === 404) throw new Error('공지사항을 찾을 수 없습니다.');
  if (!res.ok) throw new Error('공지사항 정보를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, notice } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/notices">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">공지사항 수정</h1>
          <p className="page-sub">시스템 공지 내용을 작성하세요.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/notices">취소</a>
          <button className="btn" type="submit" form="noticeForm">저장</button>
        </div>
      </div>
      <div className="card">
        <form id="noticeForm" method="POST" action={`/notices/${notice.id}`}>
          <div className="field full"><label>제목 *</label><input type="text" name="title" defaultValue={notice.title || ''} required /></div>
          <div className="field full"><label>내용 *</label><textarea name="content" defaultValue={notice.content || ''} required style={{ minHeight: 200 }}></textarea></div>
        </form>
      </div>
    </AppShell>
  );
}
