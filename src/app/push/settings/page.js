import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../_components/AppShell';
import PushSettingsClient from './PushSettingsClient';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function PushSettingsPage() {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/push/settings/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('알림 설정 데이터를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, branches } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/push/settings">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">오더 알림 설정</h1>
          <p className="page-sub">이 브라우저(기기)에서 받을 알림 이벤트를 설정하세요.</p>
        </div>
      </div>
      <PushSettingsClient currentUser={currentUser} branches={branches} />
    </AppShell>
  );
}
