import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../../_components/AppShell';
import { fetchExpressJson } from '../../../_lib/internalFetch';
import GroupForm from '../../_components/GroupForm';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function EditGroupPage({ params }) {
  const { id } = await params;
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetchExpressJson(`/groups/${id}/edit/data.json`, { proto, host, cookie: hdrs.get('cookie') });
  if (res.status === 401) redirect('/login');
  if (res.status === 404) throw new Error('법인을 찾을 수 없습니다.');
  if (!res.ok) throw new Error('법인 정보를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, group, branches } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/groups">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">법인 정보</h1>
          <p className="page-sub">법인 정보를 입력하세요.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/groups">취소</a>
          <a className="btn secondary" href={`/groups/${group.id}/users`}>사용자 리스트</a>
          <button className="btn" type="submit" form="groupForm">저장</button>
        </div>
      </div>
      <div className="card">
        <GroupForm mode="edit" group={group} branches={branches} />
      </div>
    </AppShell>
  );
}
