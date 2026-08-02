import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../_components/AppShell';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function BranchesPage() {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/branches/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('지사 데이터를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, branches } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/branches">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">지사 관리</h1>
          <p className="page-sub">지사 정보 및 운영 설정을 관리합니다.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn" href="/branches/new">+ 지사 등록</a>
        </div>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>지사명</th><th>코드</th><th>대표번호</th><th>주소</th><th>담당자</th><th>상태</th><th>관리</th></tr>
            </thead>
            <tbody>
              {branches.length === 0 && (
                <tr><td colSpan={7} className="empty">등록된 지사가 없습니다.</td></tr>
              )}
              {branches.map((b) => (
                <tr key={b.id}>
                  <td>{b.name}</td>
                  <td>{b.code || '-'}</td>
                  <td>{b.main_phone || '-'}</td>
                  <td>{b.address || '-'}</td>
                  <td>{b.contact_name || '-'}{b.contact_phone ? ' · ' + b.contact_phone : ''}</td>
                  <td><span className={'badge ' + (b.status === 'active' ? 'green' : 'gray')}>{b.status === 'active' ? '운영중' : '비활성'}</span></td>
                  <td>
                    <div className="table-actions">
                      <a className="btn small secondary" href={'/branches/' + b.id + '/edit'}>수정</a>
                      <a className="btn small secondary" href={'/branches/' + b.id + '/payment-methods'}>결제</a>
                      <a className="btn small secondary" href={'/branches/' + b.id + '/operating-hours'}>운영시간</a>
                      <a className="btn small secondary" href={'/branches/' + b.id + '/fare-rules'}>요금</a>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
