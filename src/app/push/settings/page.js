import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../_components/AppShell';
import PushSettingsClient from './PushSettingsClient';
// 통보 종류 목록·이름은 통보 모듈이 주인이다 — 화면에 따로 적으면 종류가 늘 때 갈린다
// (EJS 화면도 routes/push.js clientEventTypes로 같은 값을 받는다).
// DB를 건드리지 않는 상수 모듈에서 가져온다. 예전에는 lib/kakaoOrderNotify에서 가져왔는데,
// 그 모듈이 ../db를 require하고 db.js는 모듈 로드 시점에 던져서 next build가 실패했다
// ("Failed to collect page data for /push/settings", 2026-09-08). 로컬에는 .env가 있어
// 통과하고 CI에서만 드러난다.
import { EVENT_TYPES, DEFAULT_EVENT_SETTINGS } from '../../../../lib/notifyEvents';

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
          {/* 문구가 역할마다 달라야 한다 — 고객은 **자기 오더**의 진행을 알려고 이 화면에 온다.
              EJS(views/push_settings.ejs)와 같은 문구를 쓴다. */}
          {currentUser && currentUser.role === 'client' ? (
            <p className="page-sub">
              이 브라우저(기기)에서 <strong>내 오더의 진행 알림</strong>을 받습니다.
              배차·운행시작·운행완료·취소가 있을 때 상담창을 열지 않아도 알림이 뜹니다.
            </p>
          ) : (
            <p className="page-sub">이 브라우저(기기)에서 받을 알림 이벤트를 설정하세요.</p>
          )}
        </div>
      </div>
      <PushSettingsClient currentUser={currentUser} branches={branches} eventTypes={EVENT_TYPES.map((key) => ({ key, label: (DEFAULT_EVENT_SETTINGS[key] || {}).label || key }))} />
    </AppShell>
  );
}
