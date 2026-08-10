import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../_components/AppShell';
import AiIntakeWorkspace from './AiIntakeWorkspace';
import { renderChatText } from './formatChatText';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

function summarizeDraftFields(draft) {
  const fields = (draft && draft.fields) || {};
  return [
    ['예약일시', [fields.reserved_date, fields.reserved_time].filter(Boolean).join(' ') || '-'],
    ['출발지', [fields.origin_address, fields.origin_detail_address].filter(Boolean).join(' ') || '-'],
    ['도착지', [fields.destination_address, fields.destination_detail_address].filter(Boolean).join(' ') || '-'],
    ['차량번호', fields.vehicle_number || '-'],
    ['차종', fields.vehicle_type || '-'],
    ['기사 전달사항', fields.memo_customer || '-'],
    ['업체 전달사항', fields.memo_billing || '-'],
  ];
}

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
  const draftSummary = summarizeDraftFields(draft);

  return (
    <AppShell currentUser={data.currentUser} activePath="/orders/ai-intake">
      <div className="page-head-row page-heading">
        <div>
          <h1 className="page-title">AI 챗봇</h1>
          <p className="page-sub">Next.js 단계 전환: 최소 대화 루프(입력/파싱/응답 저장)를 활성화한 버전입니다.</p>
        </div>
      </div>

      <AiIntakeWorkspace
        initData={data}
        initialSession={session}
        initialMessages={messages}
        initialDraft={draft}
        serverTurnEnabled={!!data.aiIntakeServerTurnEnabled}
      />

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-section-head">
          <div>
            <span className="section-kicker">MIGRATION PREVIEW</span>
            <h2>초기화 데이터</h2>
          </div>
        </div>
        <div className="session-meta">
          <span>지사 {Array.isArray(data.branches) ? data.branches.length : 0}개</span>
          <span>법인 {Array.isArray(data.groups) ? data.groups.length : 0}개</span>
          <span>결제방식 {Array.isArray(data.paymentMethods) ? data.paymentMethods.length : 0}개</span>
          <span>즐겨찾기 {Array.isArray(data.favorites) ? data.favorites.length : 0}개</span>
          <span>기본 지사: <b>{data.defaultBranch || '-'}</b></span>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-section-head">
          <div>
            <span className="section-kicker">RESTORE SNAPSHOT</span>
            <h2>현재 복원 세션</h2>
          </div>
        </div>
        {!session && <div className="empty">복원할 열린 세션이 없습니다.</div>}
        {session && (
          <>
            <div className="session-meta" style={{ marginBottom: 10 }}>
              <span>세션 ID: <b>{session.id}</b></span>
              <span>메시지 {messages.length}건</span>
              <span>draft {draft ? '있음' : '없음'}</span>
            </div>
            <div className="table-wrap" style={{ marginBottom: 12 }}>
              <table>
                <thead>
                  <tr><th>항목</th><th>값</th></tr>
                </thead>
                <tbody>
                  {draftSummary.map(([label, value]) => (
                    <tr key={label}><td>{label}</td><td>{value}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="section-title small" style={{ marginBottom: 8 }}>최근 대화</div>
            <div style={{ display: 'grid', gap: 8 }}>
              {messages.length === 0 && <div className="empty">대화 이력이 없습니다.</div>}
              {messages.slice(-12).map((message) => (
                <div key={message.id} className={`ai-chat-bubble ${message.sender === 'user' ? 'ai-user' : message.sender === 'agent' ? 'ai-agent' : 'ai-bot'}`} style={{ maxWidth: '100%' }}>
                  {message.sender === 'agent' && <span className="bubble-label">상담원</span>}
                  <div>{message.sender === 'user' ? message.message : renderChatText(message.message)}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-section-head">
          <div>
            <span className="section-kicker">MIGRATION STATUS</span>
            <h2>현재 범위와 다음 단계</h2>
          </div>
        </div>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>현재는 최소 상호작용 루프(사용자 입력 저장 → 파싱 → 봇 응답 저장) + 오더 폼 자동 반영까지 Next에서 동작합니다.</li>
          <li>실시간 수신(SSE)과 재연결 유실 보충(messages since)까지 Next에서 동작합니다.</li>
          <li>phase 기반 입력 흐름(확인/수정/주소 후보선택)과 상담원 연결 제안(offer_agent)까지 반영되었습니다.</li>
          <li>오더 등록 전 precheck 검증과 needs_agent 대기 중 새 오더 입력 시 새 세션 전환 분기까지 반영되었습니다.</li>
          <li>남은 범위는 안내 문구/UX 정교화와 레거시 세부 동작 정합성 튜닝입니다.</li>
          <li>이번 페이지는 `NEXT_STAGE3_AI_INTAKE_ENABLED=true`일 때만 활성화됩니다.</li>
        </ul>
      </div>
    </AppShell>
  );
}