import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../_components/AppShell';
import FerryFaresClient from './FerryFaresClient';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function FerryFaresPage({ searchParams }) {
  const sp = await searchParams;
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const qs = sp?.saved ? '?saved=1' : '';
  const res = await fetch(`${proto}://${host}/ferry-fares/data.json${qs}`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('도선료 데이터를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, rules, saved } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/ferry-fares">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">도선료 관리</h1>
          <p className="page-sub">경로에 도선(페리) 구간이 포함된 오더의 요금을 계산할 때 쓰는 차종별 선적비용표입니다.</p>
        </div>
        <div className="page-head-actions">
          <button className="btn" type="submit" form="ferryFareForm">저장</button>
        </div>
      </div>
      {saved && <div className="success-msg" style={{ marginBottom: 12 }}>✓ 저장되었습니다.</div>}
      <FerryFaresClient initialRules={rules} />
    </AppShell>
  );
}
