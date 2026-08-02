import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../_components/AppShell';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function KnowledgeBasePage() {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/knowledge-base/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('지식관리 데이터를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, entries, categories } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/knowledge-base">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">지식관리</h1>
          <p className="page-sub">AI FAQ 응답에 사용되는 지식베이스 항목을 관리합니다.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/knowledge-base/categories">카테고리 관리</a>
          <a className="btn" href="/knowledge-base/new">+ 항목 등록</a>
        </div>
      </div>

      {categories.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {categories.map((c) => (
              <span key={c.id} className="badge gray">{c.name}</span>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>카테고리</th><th>질문</th><th>답변 (요약)</th><th>관리</th></tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr><td colSpan={4} className="empty">등록된 지식 항목이 없습니다.</td></tr>
              )}
              {entries.map((e) => (
                <tr key={e.id}>
                  <td><span className="badge gray">{e.category}</span></td>
                  <td>{e.question}</td>
                  <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.answer}</td>
                  <td>
                    <div className="table-actions">
                      <a className="btn small secondary" href={'/knowledge-base/' + e.id + '/edit'}>수정</a>
                      <form method="POST" action={'/knowledge-base/' + e.id + '/delete'} style={{ display: 'inline' }}>
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
