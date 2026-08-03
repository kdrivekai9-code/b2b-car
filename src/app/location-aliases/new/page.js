import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../_components/AppShell';
import { fetchExpressJson } from '../../_lib/internalFetch';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function NewLocationAliasPage() {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetchExpressJson('/location-aliases/new/data.json', { proto, host, cookie: hdrs.get('cookie') });
  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('거점 별칭 등록 정보를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, branches } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/location-aliases">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">거점 별칭 등록</h1>
          <p className="page-sub">반복 방문지의 여러 표기를 하나의 표준 주소로 매핑합니다.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/location-aliases">취소</a>
          <button className="btn" type="submit" form="aliasForm">저장</button>
        </div>
      </div>
      <div className="card">
        <form id="aliasForm" method="POST" action="/location-aliases">
          <div className="row">
            <div className="field">
              <label>소속 지사 *</label>
              <select name="branch_id" required defaultValue="">
                <option value="">선택하세요</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
            <div className="field"><label>거점명 *</label><input type="text" name="canonical_name" required placeholder="예: OO경매장" /></div>
          </div>
          <div className="row">
            <div className="field full"><label>표준 주소 *</label><input type="text" name="address" required /></div>
          </div>
          <div className="row">
            <div className="field full"><label>별칭 (콤마로 구분)</label><input type="text" name="aliases" placeholder="예: OO경매, OO옥션, OO중고차경매장" /></div>
          </div>
        </form>
      </div>
    </AppShell>
  );
}
