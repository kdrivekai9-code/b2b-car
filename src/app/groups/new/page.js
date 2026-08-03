import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../_components/AppShell';
import { fetchExpressJson } from '../../_lib/internalFetch';
import GroupForm from '../_components/GroupForm';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function NewGroupPage() {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetchExpressJson('/groups/new/data.json', { proto, host, cookie: hdrs.get('cookie') });
  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('법인 등록 정보를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, branches } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/groups">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">법인 등록</h1>
          <p className="page-sub">법인 정보를 입력하세요.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/groups">취소</a>
          <button className="btn" type="submit" form="groupForm">저장</button>
        </div>
      </div>
      <div className="card">
        <GroupForm mode="create" group={{}} branches={branches} />
      </div>
    </AppShell>
  );
}
