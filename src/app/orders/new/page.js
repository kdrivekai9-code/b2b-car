import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import OrderForm from './OrderForm';

// Stage 2 slice: reproduces routes/orders.js's GET /orders/new + POST /orders (create only —
// there is no "edit order" flow in the legacy app to migrate). Only reached when
// NEXT_STAGE2_ORDER_FORM_ENABLED=true (see src/proxy.js).
export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function NewOrderPage() {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/orders/new/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });

  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('오더 등록 화면을 불러오지 못했습니다 (' + res.status + ')');

  const data = await res.json();

  return (
    <>
      <div className="page-head-row page-heading">
        <div>
          <h1 className="page-title">오더 등록</h1>
        </div>
        <div className="page-heading-meta">필수 항목부터 입력해 주세요 (Next.js 프리뷰)</div>
      </div>
      <OrderForm initialData={data} />
    </>
  );
}
