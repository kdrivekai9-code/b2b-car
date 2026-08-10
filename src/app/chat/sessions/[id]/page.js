import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../../_components/AppShell';
import SessionDetailView from '../SessionDetailView';

// Stage 3 슬라이스 2: session_detail.ejs를 React로. 메시지/SSE/답장/담당지정(self)/삭제는
// 슬라이스 1의 SessionViewer.js를 그대로 재사용하고, 이 페이지 고유 기능(다른 상담원 지정,
// 종료, 봇복귀)만 SessionDetailView.js에 추가로 구현했다. legacy가 layoutMode:'top-nav'로
// 렌더링하던 것과 동일하게 AppShell도 topNav로 렌더링한다. 접수 마무리(오더등록) 폼은
// legacy에서도 이미 카드뷰로의 링크로 대체돼 있어(session_detail.ejs L101-107) 이식 대상이
// 아니다. 오직 NEXT_STAGE3_CHAT_DETAIL_ENABLED=true일 때만 도달한다(src/proxy.js).
export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function ChatSessionDetailPage({ params }) {
  const { id } = await params;
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/chat/sessions/${id}/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });

  if (res.status === 401) redirect('/login');
  if (res.status === 403) {
    return (
      <>
        <h1 className="page-title">403 · 접근 권한 없음</h1>
        <p className="page-sub">이 화면에 접근할 권한이 없습니다.</p>
        <a className="btn secondary" href="/">대시보드로 이동</a>
      </>
    );
  }
  if (res.status === 404) {
    return (
      <>
        <h1 className="page-title">세션을 찾을 수 없습니다</h1>
        <a className="btn secondary" href="/chat/sessions">← 목록으로</a>
      </>
    );
  }
  if (!res.ok) throw new Error('상담 세션을 불러오지 못했습니다 (' + res.status + ')');

  const data = await res.json();

  return (
    <AppShell currentUser={data.currentUser} activePath="/chat/sessions" topNav>
      <SessionDetailView initialSession={data.session} mappedAccount={data.mappedAccount} agents={data.agents} currentUser={data.currentUser} />
    </AppShell>
  );
}
