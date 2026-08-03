import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../_components/AppShell';
import { fetchExpressJson } from '../../_lib/internalFetch';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function NewKnowledgeBasePage({ searchParams }) {
  const sp = await searchParams;
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';
  const qs = sp && sp.category ? `?category=${encodeURIComponent(sp.category)}` : '';

  const res = await fetchExpressJson(`/knowledge-base/new/data.json${qs}`, { proto, host, cookie: hdrs.get('cookie') });
  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('지식 항목 등록 정보를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, entry, categories } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/knowledge-base">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">지식 항목 등록</h1>
          <p className="page-sub">질문·답변을 입력하면 저장 시 자동으로 임베딩이 생성됩니다.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/knowledge-base">취소</a>
          <button className="btn" type="submit" form="kbForm">저장</button>
        </div>
      </div>
      <div className="card">
        <form id="kbForm" method="POST" action="/knowledge-base">
          <div className="field">
            <label>카테고리 <a href="/knowledge-base/categories" style={{ fontWeight: 'normal', fontSize: '0.85em' }}>(카테고리 관리)</a></label>
            <select name="category" defaultValue={entry.category || ''}>
              {categories.map((c) => (
                <option key={c.id} value={c.name}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="field full"><label>질문 *</label><input type="text" name="question" required placeholder="예: 탁송 취소는 언제까지 가능한가요?" /></div>
          <div className="field full"><label>답변 *</label><textarea name="answer" required placeholder="예: 기사 배정 전까지는 위약금 없이 취소 가능합니다." style={{ minHeight: 140 }}></textarea></div>
        </form>
      </div>
    </AppShell>
  );
}
