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

  const { currentUser, logs, filters, aiRateLimit } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/access-logs">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">접속기록</h1>
          <p className="page-sub">로그인/로그아웃 등 접속 이벤트 기록입니다.</p>
        </div>
      </div>

      {/* AI 사용량 제한 — 로그인 차단 기록을 보는 자리와 "얼마나 허용할지" 정하는 자리를 같이 둔다.
          저장은 Express가 처리한다(POST /access-logs/ai-rate-limit) — 순수 HTML form이라
          이 서버 컴포넌트에 핸들러를 넣을 필요가 없다. EJS 화면(views/access_logs/list.ejs)에도
          같은 카드가 있다. */}
      {aiRateLimit && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="section-title">🤖 AI 사용량 제한</div>
          <p className="page-sub">
            챗봇이 Gemini를 부르는 요청(접수 분류·도우미 등)의 계정당 허용량입니다.
            IP가 아니라 <strong>로그인 계정</strong>으로 셉니다 — 한 사무실에서 여러 명이 써도 서로의 한도를 깎지 않습니다.
            <strong> 0으로 두면 제한하지 않습니다.</strong>
          </p>
          <form method="POST" action="/access-logs/ai-rate-limit">
            <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
              <div className="field" style={{ minWidth: 160 }}>
                <label htmlFor="aiPerMinute">분당 한도(계정당)</label>
                <input id="aiPerMinute" type="number" name="per_minute" defaultValue={aiRateLimit.perMinute} min="0" step="1" required />
                <span className="hint">기본 {aiRateLimit.defaultPerMinute}</span>
              </div>
              <div className="field" style={{ minWidth: 160 }}>
                <label htmlFor="aiPerHour">시간당 한도(계정당)</label>
                <input id="aiPerHour" type="number" name="per_hour" defaultValue={aiRateLimit.perHour} min="0" step="1" required />
                <span className="hint">기본 {aiRateLimit.defaultPerHour}</span>
              </div>
              <div className="field"><button className="btn" type="submit">저장</button></div>
            </div>
            <p className="page-sub" style={{ marginBottom: 0 }}>
              고객이 한 문장을 보내면 이 계열 요청이 2~3번 일어납니다(분류 → 접수턴 → 도우미).
              바꾼 값은 최대 {aiRateLimit.cacheSeconds}초 뒤부터 적용됩니다.
            </p>
          </form>

          {/* 지금 얼마나 쓰고 있는지 / 남은 양 / 실제로 막힌 적이 있는지 */}
          <div style={{ marginTop: 14, borderTop: '1px solid var(--border,#e5e7eb)', paddingTop: 12 }}>
            <div className="section-title" style={{ fontSize: 14 }}>📊 현재 사용량</div>
            {aiRateLimit.blocks.last24h ? (
              <p className="page-sub" style={{ marginTop: 0 }}>
                <span className="badge red">차단 발생</span>{' '}
                최근 24시간 <strong>{aiRateLimit.blocks.last24h}회</strong>(1시간 내 {aiRateLimit.blocks.lastHour}회)
                {' · 마지막 '}{aiRateLimit.blocks.lastAt}
                {' — '}<a href={`/access-logs?event_type=${aiRateLimit.blockEventType}`}>차단 기록 보기</a>
              </p>
            ) : (
              <p className="page-sub" style={{ marginTop: 0 }}>최근 24시간 동안 한도로 막힌 요청이 없습니다.</p>
            )}

            {aiRateLimit.usage.length === 0 ? (
              <p className="page-sub" style={{ marginBottom: 0 }}>지금 이 시간대에 AI를 쓴 계정이 없습니다.</p>
            ) : (
              <>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>계정</th>
                        <th style={{ textAlign: 'right' }}>이번 분</th>
                        <th style={{ textAlign: 'right' }}>분당 남은 양</th>
                        <th style={{ textAlign: 'right' }}>이번 시간</th>
                        <th style={{ textAlign: 'right' }}>시간당 남은 양</th>
                        <th>상태</th>
                      </tr>
                    </thead>
                    <tbody>
                      {aiRateLimit.usage.map((u) => (
                        <tr key={u.subject}>
                          <td>{u.label}</td>
                          <td style={{ textAlign: 'right' }}>{u.minute}회</td>
                          <td style={{ textAlign: 'right' }}>{u.minuteRemaining === null ? '제한 없음' : `${u.minuteRemaining}회`}</td>
                          <td style={{ textAlign: 'right' }}>{u.hour}회</td>
                          <td style={{ textAlign: 'right' }}>{u.hourRemaining === null ? '제한 없음' : `${u.hourRemaining}회`}</td>
                          <td>{u.blocked ? <span className="badge red">한도 도달</span> : <span className="badge green">정상</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="page-sub" style={{ marginBottom: 0 }}>이번 분/이번 시간 기준이며, 창이 바뀌면 0부터 다시 셉니다.</p>
              </>
            )}
          </div>
        </div>
      )}

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
