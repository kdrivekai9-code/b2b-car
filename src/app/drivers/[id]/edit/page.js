import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../../_components/AppShell';
import { fetchExpressJson } from '../../../_lib/internalFetch';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function EditDriverPage({ params }) {
  const { id } = await params;
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetchExpressJson(`/drivers/${id}/edit/data.json`, { proto, host, cookie: hdrs.get('cookie') });
  if (res.status === 401) redirect('/login');
  if (res.status === 404) throw new Error('기사를 찾을 수 없습니다.');
  if (!res.ok) throw new Error('기사 정보를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, driver, branches } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/drivers">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">기사 수정</h1>
          <p className="page-sub">기사 기본 정보를 입력하세요.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/drivers">취소</a>
          <button className="btn" type="submit" form="driverForm">저장</button>
        </div>
      </div>
      <div className="card">
        <form id="driverForm" method="POST" action={`/drivers/${driver.id}`}>
          <div className="row">
            <div className="field">
              <label>소속 지사 *</label>
              <select name="branch_id" required defaultValue={String(driver.branch_id)}>
                <option value="">선택하세요</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
            <div className="field"><label>이름 *</label><input type="text" name="name" defaultValue={driver.name || ''} required /></div>
          </div>
          <div className="row">
            <div className="field"><label>연락처</label><input type="text" name="phone" defaultValue={driver.phone || ''} placeholder="010-0000-0000" /></div>
          </div>
        </form>
      </div>
    </AppShell>
  );
}
