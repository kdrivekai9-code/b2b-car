import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../_components/AppShell';
import GroupTabs from './_components/GroupTabs';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function GroupsPage() {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/groups/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('법인 데이터를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, groups } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/groups">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">법인 관리</h1>
          <p className="page-sub">고객 법인 정보를 관리합니다.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn" href="/groups/new">+ 법인 등록</a>
        </div>
      </div>
      <GroupTabs active="list" groups={groups} />
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>법인명</th><th>대표번호</th><th>소속 지사</th><th>담당자</th><th>정산방식</th><th>관리</th></tr>
            </thead>
            <tbody>
              {groups.length === 0 && (
                <tr><td colSpan={6} className="empty">등록된 법인이 없습니다.</td></tr>
              )}
              {groups.map((g) => (
                <tr key={g.id}>
                  {/* 법인명을 누르면 법인 정보로 간다 — 목록에서 곧바로 설정에 들어가는 통로다.
                      관리 열의 '수정'과 같은 곳을 가리키지만, 이름을 누르는 것이 더 자연스럽다. */}
                  <td><a href={`/groups/${g.id}/edit`}>{g.name}</a></td>
                  <td>{g.main_phone || '-'}</td>
                  <td>{g.branch_name}</td>
                  <td>{g.contact_name || '-'}{g.contact_phone ? ' · ' + g.contact_phone : ''}</td>
                  <td>{g.settlement_method || '-'}</td>
                  <td>
                    <div className="table-actions">
                      <a className="btn small secondary" href={'/groups/' + g.id + '/edit'}>수정</a>
                      {/* 법인별 설정(정책 변경) — 요금표·통보를 지사가 아니라 법인 단위로 관리한다.
                          각 화면은 EJS(routes/groups.js)로, 지사 설정 화면과 같은 모양이다. */}
                      <a className="btn small secondary" href={'/groups/' + g.id + '/accounts'}>계정정보</a>
                      <a className="btn small secondary" href={'/groups/' + g.id + '/fare-rules'}>탁송 요금</a>
                      <a className="btn small secondary" href={'/groups/' + g.id + '/daily-driver-fare-rules'}>일일기사 요금</a>
                      <a className="btn small secondary" href={'/groups/' + g.id + '/customer-notifications'}>고객 통보</a>
                      <a className="btn small secondary" href={'/groups/' + g.id + '/dispatch-delay'}>배차지연</a>
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
