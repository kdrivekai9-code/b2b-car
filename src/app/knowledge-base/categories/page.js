import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../_components/AppShell';
import { fetchExpressJson } from '../../_lib/internalFetch';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function KnowledgeBaseCategoriesPage() {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetchExpressJson('/knowledge-base/categories/data.json', { proto, host, cookie: hdrs.get('cookie') });
  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('카테고리 정보를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, categories } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/knowledge-base">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">카테고리 관리</h1>
          <p className="page-sub">지식 항목을 분류할 카테고리를 등록합니다. 카테고리를 선택해 질의응답 항목을 바로 추가할 수 있습니다.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/knowledge-base">목록으로</a>
        </div>
      </div>

      <div className="card">
        <form method="POST" action="/knowledge-base/categories">
          <div className="field full"><label>새 카테고리명 *</label><input type="text" name="name" required placeholder="예: 픽업정책, 취소정책, 요금정책" /></div>
          <button className="btn" type="submit">카테고리 추가</button>
        </form>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>카테고리명</th><th>등록된 항목 수</th><th>등록일시</th><th>관리</th></tr>
            </thead>
            <tbody>
              {categories.length === 0 && (
                <tr><td colSpan={4} className="empty">등록된 카테고리가 없습니다.</td></tr>
              )}
              {categories.map((c) => (
                <tr key={c.id}>
                  <td><span className="badge gray">{c.name}</span></td>
                  <td>{c.entry_count}</td>
                  <td>{c.created_at}</td>
                  <td>
                    <a className="btn small" href={`/knowledge-base/new?category=${encodeURIComponent(c.name)}`}>질의응답 추가</a>
                    <form style={{ display: 'inline' }} method="POST" action={`/knowledge-base/categories/${c.id}/delete`}>
                      <button className="btn small secondary" type="submit">삭제</button>
                    </form>
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
