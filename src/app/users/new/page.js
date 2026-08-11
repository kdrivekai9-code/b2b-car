import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../_components/AppShell';
import { fetchExpressJson } from '../../_lib/internalFetch';
import UserForm from '../_components/UserForm';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function NewUserPage({ searchParams }) {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';
  // 카카오 채널 매핑 화면("미등록계정")에서 온 name/phone/branch_id/return_to를 그대로
  // Express 쪽으로 넘긴다 — 프리필/복귀 판단은 서버(routes/users.js prefillFromQuery,
  // ALLOWED_RETURN_TO)가 한 곳에서 맡는다.
  const sp = await searchParams;
  const query = new URLSearchParams(sp || {}).toString();

  const res = await fetchExpressJson('/users/new/data.json' + (query ? '?' + query : ''), { proto, host, cookie: hdrs.get('cookie') });
  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('사용자 등록 정보를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, branches, groups, prefill, returnTo } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/users">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">사용자 등록</h1>
          <p className="page-sub">사용자 계정 정보를 입력하세요.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/users">취소</a>
          <button className="btn" type="submit" form="userForm">저장</button>
        </div>
      </div>
      <div className="card">
        <UserForm mode="create" user={prefill || {}} branches={branches} groups={groups} returnTo={returnTo || ''} />
      </div>
    </AppShell>
  );
}
