import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../_components/AppShell';
import CardBoard from './CardBoard';

// Stage 1 슬라이스: view=list(읽기 전용 테이블)만 다뤘다. Stage 3에서 카드뷰(?view=card 또는
// view 없음, routes/chat.js L404와 동일하게 기본값을 card로 취급)를 추가했다 — 실시간
// 채팅/답장/배정/삭제 + 오더등록 링크 포함. session_detail.ejs(상세페이지)는 이번에도
// 범위 밖으로 Express에 남는다("상세 페이지 열기" 링크는 Next에 페이지가 없어 자동으로
// Express로 fallback rewrite된다). 두 뷰 모두 src/proxy.js에서 각자 다른 플래그로 게이팅.
export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

const STATUS_LABEL = { bot: '봇 응대중', needs_agent: '상담원 호출', agent_active: '상담원 응대중', closed: '종료' };
const STATUS_BADGE = { bot: 'gray', needs_agent: 'red', agent_active: 'blue', closed: 'dark' };

export default async function ChatSessionListPage({ searchParams }) {
  const sp = await searchParams;
  const view = sp.view === 'list' ? 'list' : 'card';
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const dataPath = view === 'card' ? '/chat/sessions/card-data.json' : '/chat/sessions/data.json';
  const res = await fetch(`${proto}://${host}${dataPath}`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });

  if (res.status === 401) redirect('/login');
  // requireRole('admin')은 EJS와 동일하게 admin이 아니면(branch_manager 포함) 403(HTML)을
  // 그대로 돌려준다 — JSON으로 파싱하지 않고 같은 안내를 인라인으로 재현한다.
  if (res.status === 403) {
    return (
      <>
        <h1 className="page-title">403 · 접근 권한 없음</h1>
        <p className="page-sub">이 화면에 접근할 권한이 없습니다.</p>
        <a className="btn secondary" href="/">대시보드로 이동</a>
      </>
    );
  }
  if (!res.ok) throw new Error('상담 세션 목록을 불러오지 못했습니다 (' + res.status + ')');

  const data = await res.json();

  if (view === 'card') {
    return (
      <AppShell currentUser={data.currentUser} activePath="/chat/sessions">
        <CardBoard initialSessions={data.sessions} initialOnlineAgents={data.onlineAgents} currentUser={data.currentUser} />
      </AppShell>
    );
  }

  const { sessions } = data;

  return (
    <AppShell currentUser={data.currentUser} activePath="/chat/sessions">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">상담 관리</h1>
          <p className="page-sub">
            상담 세션 목록(읽기 전용, Next.js 프리뷰) — 실시간 채팅/답장/배정/삭제/오더등록은 이 화면에 없습니다.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>번호</th><th>고객</th><th>상태</th><th>담당자</th>
                <th>요청 기능</th><th>최근 메시지</th><th>메시지 수</th><th>업데이트</th><th>보기</th>
              </tr>
            </thead>
            <tbody>
              {sessions.length === 0 && <tr><td colSpan={9} className="empty">진행 중인 상담 세션이 없습니다.</td></tr>}
              {sessions.map((s) => (
                <tr key={s.id} className={s.status === 'needs_agent' ? 'session-row-needs-agent' : ''}>
                  <td>#{s.id}</td>
                  <td>{s.user_name || '-'} <span style={{ color: 'var(--muted)' }}>({s.user_role || '-'})</span></td>
                  <td><span className={`badge ${STATUS_BADGE[s.status] || 'gray'}`}>{STATUS_LABEL[s.status] || s.status}</span></td>
                  <td>{s.assigned_agent_name || '미지정'}</td>
                  <td>{s.requested_feature || '-'}</td>
                  <td title={s.last_message || ''}>{s.last_message || '-'}</td>
                  <td>{s.message_count}</td>
                  <td>{s.updated_at}</td>
                  <td><a className="btn small secondary" href={`/chat/sessions/${s.id}`}>보기</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
