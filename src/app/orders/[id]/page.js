import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../_components/AppShell';
import OrderForm from '../new/OrderForm';
import OrderDetailAdminPanels from './OrderDetailAdminPanels';
import OrderHistoryPanel from './OrderHistoryPanel';

// 오더 상세페이지를 기존 접수폼(OrderForm.js, /orders/new)의 edit 모드로 재사용 —
// views/orders/detail.ejs는 수정이 아예 불가능한 읽기전용 화면이었다. 모든 역할(admin/
// branch_manager/client)이 이제 자기 소속 오더를 직접 수정할 수 있다. 상태변경/기사배정/
// 관리자메모는 여전히 admin/branch_manager 전용(OrderDetailAdminPanels.js) — client는
// 대신 배정 기사 정보 + 변경이력만 보는 OrderHistoryPanel.js를 본다.
// NEXT_ORDER_DETAIL_EDIT_ENABLED=true일 때만 도달(src/proxy.js).
export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

const STATUS_COLORS = {
  '오더등록': 'gray', '대기': 'gray', '접수': 'blue', '진행중': 'blue',
  '배정중': 'amber', '기사배정': 'amber', '문의': 'purple', '사고': 'red',
  '과태료': 'red', '취소요청': 'red', '취소': 'dark', '완료': 'green',
};

export default async function OrderDetailPage({ params }) {
  const { id } = await params;
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/orders/${id}/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });

  if (res.status === 401) redirect('/login');
  if (res.status === 403) {
    return (
      <>
        <h1 className="page-title">403 · 접근 권한 없음</h1>
        <p className="page-sub">이 오더에 접근할 권한이 없습니다.</p>
        <a className="btn secondary" href="/orders">← 오더 리스트로</a>
      </>
    );
  }
  if (res.status === 404) {
    return (
      <>
        <h1 className="page-title">오더를 찾을 수 없습니다</h1>
        <a className="btn secondary" href="/orders">← 오더 리스트로</a>
      </>
    );
  }
  if (!res.ok) throw new Error('오더 상세를 불러오지 못했습니다 (' + res.status + ')');

  const data = await res.json();
  const { order, currentUserRole } = data;
  const isAdminOrBranchManager = currentUserRole === 'admin' || currentUserRole === 'branch_manager';

  return (
    <AppShell currentUser={data.currentUser} activePath="/orders">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">오더 상세 · {order.oid}</h1>
          <p className="page-sub">
            <span className={`badge ${STATUS_COLORS[order.status] || 'gray'}`}>{order.status}</span>
            &nbsp; {order.branch_name} · {order.group_name || '-'} · 등록일시 {order.created_at}
          </p>
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/orders">&larr; 오더 리스트로</a>
        </div>
      </div>

      <OrderForm initialData={data} mode="edit" orderId={id} />
      <div style={{ marginTop: 18 }}>
        {isAdminOrBranchManager
          ? <OrderDetailAdminPanels data={data} orderId={id} />
          : <OrderHistoryPanel data={data} />}
      </div>
    </AppShell>
  );
}
