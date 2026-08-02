import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../_components/AppShell';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function SettingsPage() {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/settings/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('설정 데이터를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, paymentMethods } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/settings">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">설정</h1>
          <p className="page-sub">시스템 기본값을 설정합니다.</p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-section-head">
          <div><h2>결제 방식</h2></div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>결제 방식</th><th>상태</th><th>관리</th></tr>
            </thead>
            <tbody>
              {paymentMethods.length === 0 && (
                <tr><td colSpan={3} className="empty">등록된 결제 방식이 없습니다.</td></tr>
              )}
              {paymentMethods.map((pm) => (
                <tr key={pm.id}>
                  <td>{pm.name}</td>
                  <td><span className={'badge ' + (pm.is_active ? 'green' : 'gray')}>{pm.is_active ? '활성' : '비활성'}</span></td>
                  <td>
                    <form method="POST" action={'/settings/payment-methods/' + pm.id + '/toggle'} style={{ display: 'inline' }}>
                      <button className="btn small secondary" type="submit">{pm.is_active ? '비활성화' : '활성화'}</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form method="POST" action="/settings/payment-methods" style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <input className="input" type="text" name="name" placeholder="결제 방식 이름" required style={{ maxWidth: 200 }} />
          <button className="btn" type="submit">추가</button>
        </form>
      </div>
    </AppShell>
  );
}
