import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../_components/AppShell';

// Stage 1 slice: reproduces routes/inquiries.js + views/inquiries/list.ejs behavior
// (same data, same auth/scoping via /inquiries/data.json) as a React page.
// Only reached when NEXT_STAGE1_INQUIRIES_ENABLED=true (see src/proxy.js).
export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

const STATUS_OPTIONS = ['new', 'in_progress', 'waiting_customer', 'answered', 'converted_to_order', 'closed'];

export default async function InquiriesListPage({ searchParams }) {
  const sp = await searchParams;
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';
  const qs = new URLSearchParams(sp).toString();

  const res = await fetch(`${proto}://${host}/inquiries/data.json${qs ? '?' + qs : ''}`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });

  if (res.status === 401) redirect('/login');
  // requireRole('admin','branch_manager')는 client 역할에게 EJS와 동일하게 403(HTML)을
  // 그대로 돌려준다 — 여기서는 그 HTML을 JSON으로 파싱하지 않고 views/403.ejs와 같은
  // 안내를 그대로 재현한다.
  if (res.status === 403) {
    return (
      <>
        <h1 className="page-title">403 · 접근 권한 없음</h1>
        <p className="page-sub">이 화면에 접근할 권한이 없습니다.</p>
        <a className="btn secondary" href="/">대시보드로 이동</a>
      </>
    );
  }
  if (!res.ok) throw new Error('문의 목록을 불러오지 못했습니다 (' + res.status + ')');

  const data = await res.json();
  const { inquiries, filters } = data;

  return (
    <AppShell currentUser={data.currentUser} activePath="/inquiries">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">문의 관리</h1>
          <p className="page-sub">챗봇 문의 접수 내역을 조회하고 오더 전환까지 관리합니다. (Next.js 프리뷰)</p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 10 }}>
        <form method="GET" action="/inquiries" className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field">
            <label>상태</label>
            <select name="status" defaultValue={filters.status}>
              <option value="">전체</option>
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="field">
            <label>카테고리</label>
            <select name="category" defaultValue={filters.category}>
              <option value="">전체</option>
              <option value="fare">fare</option>
              <option value="general">general</option>
            </select>
          </div>
          <div className="field full">
            <label>검색</label>
            <input type="text" name="q" defaultValue={filters.q} placeholder="문의/출발지/도착지 검색" />
          </div>
          <div className="field" style={{ maxWidth: 120 }}>
            <button className="btn" type="submit">조회</button>
          </div>
        </form>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th><th>상태</th><th>카테고리</th><th>요청자</th><th>지사</th>
                <th>법인</th><th>배편</th><th>문의 요약</th><th>등록일</th>
              </tr>
            </thead>
            <tbody>
              {inquiries.length === 0 && <tr><td colSpan={9} className="empty">등록된 문의가 없습니다.</td></tr>}
              {inquiries.map((i) => {
                const summary = (i.inquiry_text || '').length > 40
                  ? i.inquiry_text.slice(0, 40) + '…'
                  : (i.inquiry_text || '-');
                return (
                  <tr key={i.id} style={{ cursor: 'pointer' }}>
                    <td><a href={`/inquiries/${i.id}`}>{i.id}</a></td>
                    <td>{i.status}</td>
                    <td>{i.category}</td>
                    <td>{i.user_name || '-'}</td>
                    <td>{i.branch_name || '-'}</td>
                    <td>{i.corporation_name || '-'}</td>
                    <td><span className={`badge ${i.has_ferry_leg ? 'red' : 'green'}`}>{i.has_ferry_leg ? '필요' : '없음'}</span></td>
                    <td>{summary}</td>
                    <td>{i.created_at}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
