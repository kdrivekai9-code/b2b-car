import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../../_components/AppShell';
import { fetchExpressJson } from '../../../_lib/internalFetch';
import UserForm from '../../_components/UserForm';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function EditUserPage({ params }) {
  const { id } = await params;
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetchExpressJson(`/users/${id}/edit/data.json`, { proto, host, cookie: hdrs.get('cookie') });
  if (res.status === 401) redirect('/login');
  if (res.status === 404) throw new Error('사용자를 찾을 수 없습니다.');
  if (!res.ok) throw new Error('사용자 정보를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, user, branches, groups } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/users">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">사용자 수정</h1>
          <p className="page-sub">사용자 계정 정보를 입력하세요.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/users">취소</a>
          <button className="btn" type="submit" form="userForm">저장</button>
        </div>
      </div>
      <div className="card">
        <UserForm mode="edit" user={user} branches={branches} groups={groups} />
      </div>
    </AppShell>
  );
}
