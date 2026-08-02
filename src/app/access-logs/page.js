import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../_components/AppShell';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

const EVENT_LABELS = {
  LOGIN_SUCCESS: '로그인 성공',
  LOGIN_FAILURE: '로그인 실패',
  LOGOUT: '로그아웃',
  PASSWORD_CHANGE: '비밀번호 변경',
  SESSION_REPLACED: '세션 교체',
};

export default async function AccessLogsPage({ searchParams }) {
  const sp = await searchParams;
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const qs = new URLSearchParams(sp || {}).toString();
  const res = await fetch(`${proto}://${host}/access-logs/data.json${qs ? '?' + qs : ''}`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('접속기록 데이터를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, logs, filters } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/access-logs">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">접속기록</h1>
          <p className="page-sub">로그인/로그아웃 등 접속 이벤트 기록입니다.</p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <form method="GET">
          <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
            <div className="field" style={{ minWidth: 140 }}>
              <label>계정</label>
              <input className="input" type="text" name="account" defaultValue={filters.account} placeholder="아이디 검색" />
            </div>
            <div className="field" style={{ minWidth: 160 }}>
              <label>이벤트 유형</label>
              <select className="input" name="event_type" defaultValue={filters.event_type}>
                <option value="">전체</option>
                {Object.entries(EVENT_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div className="field" style={{ minWidth: 130 }}>
              <label>시작일</label>
              <input className="input" type="date" name="from" defaultValue={filters.from} />
            </div>
            <div className="field" style={{ minWidth: 130 }}>
              <label>종료일</label>
              <input className="input" type="date" name="to" defaultValue={filters.to} />
            </div>
            <div className="field" style={{ alignSelf: 'flex-end' }}>
              <button className="btn" type="submit">검색</button>
              <a className="btn secondary" href="/access-logs" style={{ marginLeft: 6 }}>초기화</a>
            </div>
          </div>
        </form>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>시각</th><th>계정</th><th>이벤트</th><th>상세</th><th>대상</th><th>IP</th><th>결과</th></tr>
            </thead>
            <tbody>
              {logs.length === 0 && (
                <tr><td colSpan={7} className="empty">기록이 없습니다.</td></tr>
              )}
              {logs.map((l) => (
                <tr key={l.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{l.accessed_at}</td>
                  <td>{l.account || '-'}</td>
                  <td>{EVENT_LABELS[l.event_type] || l.event_type}</td>
                  <td>{l.work_detail || '-'}</td>
                  <td>{l.subject_info || '-'}</td>
                  <td>{l.ip_address || '-'}</td>
                  <td><span className={'badge ' + (l.success ? 'green' : 'red')}>{l.success ? '성공' : '실패'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="page-sub" style={{ marginTop: 8 }}>최대 1,000건 표시</p>
      </div>
    </AppShell>
  );
}
