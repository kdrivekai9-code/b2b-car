import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../_components/AppShell';
import OrderListTable from './OrderListTable';

// Stage 1 slice: reproduces routes/orders.js + views/orders/list.ejs behavior
// (same data, same auth/scoping via /orders/data.json) as a React page.
// Only reached when NEXT_STAGE1_ORDERS_ENABLED=true (see src/proxy.js).
// Column show/hide/reorder/width/density customization lives in OrderListTable.js
// (client component, ported from public/js/order-list-columns.js).
export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function OrdersListPage({ searchParams }) {
  const sp = await searchParams;
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';
  const qs = new URLSearchParams(sp).toString();

  const res = await fetch(`${proto}://${host}/orders/data.json${qs ? '?' + qs : ''}`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });

  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('오더 리스트를 불러오지 못했습니다 (' + res.status + ')');

  const data = await res.json();
  const { orders, branches, ORDER_STATUSES, filters, pagination, currentUserRole, statusSummary } = data;
  const isAdmin = currentUserRole === 'admin';

  function pageHref(p) {
    const qp = new URLSearchParams();
    if (filters.branch_id) qp.set('branch_id', filters.branch_id);
    if (filters.status) qp.set('status', filters.status);
    if (filters.from) qp.set('from', filters.from);
    if (filters.to) qp.set('to', filters.to);
    if (filters.q) qp.set('q', filters.q);
    qp.set('page', String(p));
    return '/orders?' + qp.toString();
  }

  return (
    <AppShell currentUser={data.currentUser} activePath="/orders">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">오더 리스트</h1>
          <p className="page-sub">등록된 오더를 조회하고 상태를 관리합니다. 컬럼 표시/순서/너비/행간격은 이 브라우저에만 저장됩니다.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn" href="/orders/new">+ 오더 등록</a>
        </div>
      </div>

      <form className="filters card" method="GET" action="/orders">
        {isAdmin && (
          <div className="field">
            <label>지사</label>
            <select name="branch_id" defaultValue={filters.branch_id}>
              <option value="">전체 지사</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label>상태</label>
          <select name="status" defaultValue={filters.status}>
            <option value="">전체 상태</option>
            {ORDER_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="field"><label>시작일</label><input type="date" name="from" defaultValue={filters.from} /></div>
        <div className="field"><label>종료일</label><input type="date" name="to" defaultValue={filters.to} /></div>
        <div className="field"><label>검색(OID/주소)</label><input type="text" name="q" defaultValue={filters.q} placeholder="OID, 출발지, 도착지" /></div>
        <div className="field filter-actions">
          <a className="btn small secondary" href="/orders">초기화</a>
          <button className="btn" type="submit">조회</button>
        </div>
      </form>

      <div style={{ marginBottom: 14 }}>
        {filters.branch_id ? <span className="chip">지사 필터 적용중</span> : <span className="chip">전체 지사 표시중</span>}
        {filters.status && <span className="chip">상태: {filters.status}</span>}
        {(filters.from || filters.to) && <span className="chip">기간: {filters.from || '전체'} ~ {filters.to || '전체'}</span>}
        <span className="chip">총 {statusSummary.total}건</span>
        <span className="chip">오더등록 {statusSummary.registered}건</span>
        <span className="chip">완료 {statusSummary.completed}건</span>
        <span className="chip">대기 {statusSummary.pending}건</span>
        <span className="chip">취소 {statusSummary.cancelled}건</span>
        <span className="chip">문의 {statusSummary.inquiry}건</span>
      </div>

      <section className="card list-section-card">
        <OrderListTable orders={orders} />
        {pagination.totalPages > 1 && (
          <div className="pagination-bar">
            {pagination.page > 1
              ? <a className="btn small secondary" href={pageHref(pagination.page - 1)}>‹ 이전</a>
              : <span className="btn small secondary disabled">‹ 이전</span>}
            <span className="pagination-info">{pagination.page} / {pagination.totalPages} 페이지</span>
            {pagination.page < pagination.totalPages
              ? <a className="btn small secondary" href={pageHref(pagination.page + 1)}>다음 ›</a>
              : <span className="btn small secondary disabled">다음 ›</span>}
          </div>
        )}
      </section>
    </AppShell>
  );
}
