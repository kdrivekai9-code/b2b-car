import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../_components/AppShell';

// Stage 1 slice: reproduces routes/orders.js + views/orders/list.ejs behavior
// (same data, same auth/scoping via /orders/data.json) as a React page.
// Only reached when NEXT_STAGE1_ORDERS_ENABLED=true (see src/proxy.js).
// Not reproduced here: the client-side column show/hide/reorder/width/density
// customization (public/js/order-list-columns.js, localStorage-only, no data
// contract implications) — out of scope for a read-only Stage 1 contract-parity slice.
export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

const STATUS_COLORS = {
  '오더등록': 'gray', '대기': 'gray', '접수': 'blue', '진행중': 'blue',
  '배정중': 'amber', '기사배정': 'amber', '문의': 'purple', '사고': 'red',
  '과태료': 'red', '취소요청': 'red', '취소': 'dark', '완료': 'green',
};

function formatMoney(n) {
  return (Number(n) || 0).toLocaleString('ko-KR') + '원';
}

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
  const { orders, branches, ORDER_STATUSES, filters, pagination, currentUserRole } = data;
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
          <p className="page-sub">등록된 오더를 조회하고 상태를 관리합니다. (Next.js 프리뷰 — 항목 설정은 이 버전에 없습니다.)</p>
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
        <span className="chip">총 {pagination.totalCount}건</span>
      </div>

      <section className="card list-section-card">
        <div className="card-section-head">
          <div>
            <span className="section-kicker">ORDER OVERVIEW</span>
            <h2>오더 현황</h2>
          </div>
          <span className="count-badge">{pagination.totalCount}건</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>OID</th><th>지사</th><th>요청 법인</th><th>대표번호</th><th>출발지</th>
                <th>경유지</th><th>도착지</th><th>차종 / 차량번호</th><th>기사정보</th>
                <th>예약일시</th><th>결제방식</th><th>요금</th><th>상태</th><th>사진</th><th>등록일시</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 && <tr><td colSpan={15} className="empty">조건에 맞는 오더가 없습니다.</td></tr>}
              {orders.map((o) => {
                const vehicle = [o.vehicle_type, o.vehicle_number].filter(Boolean).join(' / ') || '-';
                // 구간 릴레이: leg_count > 0이면(order_legs 마이그레이션 이후 생성된 오더)
                // "N/M명 배정" 요약, 아니면(레거시 오더) 기존 단일 기사 표시 그대로.
                const driver = Number(o.leg_count) > 0
                  ? `기사 ${o.legs_assigned_count}/${o.leg_count}명 배정` + (o.leg_driver_names ? ` (${o.leg_driver_names})` : '')
                  : (o.driver_name ? (o.driver_name + (o.driver_phone ? ` (${o.driver_phone})` : '')) : '미배정');
                return (
                  <tr key={o.id} style={{ cursor: 'pointer' }}>
                    <td><a href={`/orders/${o.id}`}>{o.oid}</a></td>
                    <td title={o.branch_name}>{o.branch_name}</td>
                    <td title={o.group_name || '-'}>{o.group_name || '-'}</td>
                    <td title={o.group_phone || '-'}>{o.group_phone || '-'}</td>
                    <td title={o.origin_address}>{o.origin_address}</td>
                    <td title={o.waypoints_text || ''}>{o.waypoints_text || '-'}</td>
                    <td title={o.destination_address}>{o.destination_address}</td>
                    <td title={vehicle}>{vehicle}</td>
                    <td title={driver}>{driver}</td>
                    <td title={`${o.reserved_date} ${o.reserved_time}`}>{o.reserved_date} {o.reserved_time}</td>
                    <td title={o.payment_method_name || '-'}>{o.payment_method_name || '-'}</td>
                    <td>{formatMoney(o.fare_amount)}</td>
                    <td><span className={`badge ${STATUS_COLORS[o.status] || 'gray'}`}>{o.status}</span></td>
                    <td>{Number(o.photo_count) > 0 ? `📷 ${o.photo_count}` : '-'}</td>
                    <td title={o.created_at}>{o.created_at}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
