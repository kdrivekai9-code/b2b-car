import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../_components/AppShell';
import AiIntakeWorkspace from './AiIntakeWorkspace';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function AiIntakePage({ searchParams }) {
  const sp = await searchParams;
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';
  const cookie = hdrs.get('cookie') || '';
  const sessionQuery = new URLSearchParams(sp || {}).toString();

  const [initRes, sessionRes] = await Promise.all([
    fetch(`${proto}://${host}/orders/ai-intake/data.json`, {
      headers: { cookie, 'X-Requested-With': 'fetch' },
      cache: 'no-store',
    }),
    fetch(`${proto}://${host}/orders/ai-intake/session/data.json${sessionQuery ? '?' + sessionQuery : ''}`, {
      headers: { cookie, 'X-Requested-With': 'fetch' },
      cache: 'no-store',
    }),
  ]);

  if (initRes.status === 401 || sessionRes.status === 401) redirect('/login');
  if (!initRes.ok) throw new Error('AI 접수 초기 데이터를 불러오지 못했습니다 (' + initRes.status + ')');
  if (!sessionRes.ok) throw new Error('AI 접수 세션 데이터를 불러오지 못했습니다 (' + sessionRes.status + ')');

  const [data, sessionData] = await Promise.all([initRes.json(), sessionRes.json()]);
  const session = sessionData.existingSession;
  const messages = Array.isArray(sessionData.existingMessages) ? sessionData.existingMessages : [];
  const draft = sessionData.existingDraft || null;

  return (
    <AppShell currentUser={data.currentUser} activePath="/orders/ai-intake">
      {/* EJS(views/orders/ai_intake.ejs)와 같은 머리말 — 제목만 둔다. */}
      <div className="page-head-row page-heading">
        <div>
          <h1 className="page-title">AI 챗봇</h1>
        </div>
      </div>

      <AiIntakeWorkspace
        initData={data}
        initialSession={session}
        initialMessages={messages}
        initialDraft={draft}
        serverTurnEnabled={!!data.aiIntakeServerTurnEnabled}
      />

    </AppShell>
  );
}