import { Fragment } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from './_components/AppShell';

// Stage 1 slice: reproduces routes/dashboard.js + views/dashboard.ejs behavior
// (same data, same auth/scoping via /dashboard/data.json) as a React page.
// Only reached when NEXT_STAGE1_DASHBOARD_ENABLED=true (see middleware.js).
export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

const DOW_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
const PRESETS = [
  ['all', '전체'], ['yesterday', '전일'], ['today', '금일'],
  ['last_week', '전주'], ['this_week', '금주'], ['last_month', '전월'], ['this_month', '금월'],
];

function formatMoney(n) {
  return (Number(n) || 0).toLocaleString('ko-KR') + '원';
}

export default async function DashboardPage({ searchParams }) {
  const sp = await searchParams;
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';
  const qs = new URLSearchParams(sp).toString();

  // X-Requested-With: fetch는 middleware/auth.js의 requireAuth가 "이 요청은 fetch이니
  // 인증 실패 시 /login으로 리다이렉트하지 말고 401 JSON을 달라"고 판단하는 기준이다.
  // 없으면 requireAuth가 일반 네비게이션으로 오인해 /login HTML로 302 리다이렉트하고,
  // 그 HTML을 res.json()으로 파싱하려다 실패한다.
  const res = await fetch(`${proto}://${host}/dashboard/data.json${qs ? '?' + qs : ''}`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });

  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('대시보드 데이터를 불러오지 못했습니다 (' + res.status + ')');

  const data = await res.json();
  const { period } = data;
  const hourMax = Math.max(1, ...data.hourly);

  return (
    <AppShell currentUser={data.currentUser} activePath="/">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">통합 대시보드</h1>
          <p className="page-sub">기간별 오더 현황, 시간대 분포, 지사·법인별 비교를 확인합니다. (Next.js 프리뷰)</p>
        </div>
        <div className="page-head-actions">
          <a className="btn" href="/orders/new">+ 오더 등록</a>
        </div>
      </div>

      <div className="card">
        <div className="period-row">
          <div className="period-presets">
            {PRESETS.map(([value, label]) => {
              const active = value === 'all' ? (period.preset === '' || period.preset === 'all') : period.preset === value;
              return (
                <a key={value} className={`btn small ${active ? '' : 'secondary'}`} href={`?period=${value}`}>{label}</a>
              );
            })}
          </div>
          <form method="GET" className="period-custom">
            <input type="hidden" name="period" value="custom" />
            <input type="date" name="from" defaultValue={period.from || ''} />
            <span>~</span>
            <input type="date" name="to" defaultValue={period.to || ''} />
            <button className="btn small" type="submit">조회</button>
          </form>
        </div>
        <p className="page-sub" style={{ margin: '10px 0 0' }}>
          적용 기간: <b>{period.from ? `${period.from} ~ ${period.to}` : '전체 기간'}</b>
        </p>
      </div>

      <div className="kpi-grid">
        <div className="kpi accent"><div className="label">총 오더수</div><div className="value">{data.totalOrders}건</div></div>
        <div className="kpi"><div className="label">요금 합계</div><div className="value" style={{ fontSize: 18 }}>{formatMoney(data.totalFare)}</div></div>
        <div className="kpi"><div className="label">미배정(등록/대기/접수)</div><div className="value">{data.unassigned}건</div></div>
        <div className="kpi"><div className="label">진행중(배정중/기사배정)</div><div className="value">{data.inProgress}건</div></div>
        <div className="kpi"><div className="label">완료</div><div className="value">{data.completed}건</div></div>
        <div className="kpi"><div className="label">이슈(문의/사고/취소 등)</div><div className="value">{data.issues}건</div></div>
      </div>

      {/* AI 사용량 — ai_call_logs 집계. 지사/법인 스코프가 없다(호출 주체가 시스템이라 나눌
          근거가 없다) — 기간만 맞춘다. 표가 없으면(마이그레이션 전) 카드 자체를 감춘다.
          views/dashboard.ejs에도 같은 카드가 있다. */}
      {data.aiUsage && data.aiUsage.totalCalls > 0 && (
        <section className="card" style={{ marginBottom: 12 }}>
          <h2>🤖 AI 사용량 <small className="page-sub" style={{ fontWeight: 400 }}>(챗봇이 Gemini를 부른 횟수)</small></h2>
          <div className="kpi-grid" style={{ marginBottom: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))' }}>
            <div className="kpi accent"><div className="label">총 호출</div><div className="value">{data.aiUsage.totalCalls}회</div></div>
            <div className="kpi"><div className="label">평균 응답</div><div className="value">{(data.aiUsage.avgMs / 1000).toFixed(1)}초</div></div>
            <div className="kpi"><div className="label">실패</div><div className="value">{data.aiUsage.totalFailures}회</div></div>
            {data.aiUsage.slowest && (
              <div className="kpi">
                <div className="label">가장 느렸던 용도</div>
                <div className="value" style={{ fontSize: 16 }}>
                  {data.aiUsage.slowest.label} {(data.aiUsage.slowest.maxMs / 1000).toFixed(1)}초
                </div>
              </div>
            )}
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>용도</th><th style={{ textAlign: 'right' }}>호출</th><th style={{ textAlign: 'right' }}>평균</th><th style={{ textAlign: 'right' }}>최대</th><th style={{ textAlign: 'right' }}>실패</th></tr></thead>
              <tbody>
                {data.aiUsage.byOp.map((r) => (
                  <tr key={r.op}>
                    <td>{r.label}</td>
                    <td style={{ textAlign: 'right' }}>{r.calls}회</td>
                    <td style={{ textAlign: 'right' }}>{(r.avgMs / 1000).toFixed(1)}초</td>
                    <td style={{ textAlign: 'right' }}>{(r.maxMs / 1000).toFixed(1)}초</td>
                    <td style={{ textAlign: 'right' }}>{r.failures ? <span className="badge red">{r.failures}</span> : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="page-sub" style={{ marginBottom: 0 }}>
            고객이 한 문장을 보내면 보통 2~3회 호출됩니다. 계정당 허용량은
            <a href="/access-logs"> 접속기록</a> 화면에서 조정합니다.
          </p>
        </section>
      )}

      <div className="dashboard-card-grid">
        <section className="card dashboard-analysis-card">
          <h2>⏱ 시간대 분포 <small className="page-sub" style={{ fontWeight: 400 }}>(오더 등록 시각 기준)</small></h2>
          <div className="kpi-grid" style={{ marginBottom: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))' }}>
            <div className="kpi"><div className="label">총 콜수</div><div className="value">{data.totalOrders}건</div></div>
            <div className="kpi"><div className="label">피크 시간</div><div className="value">{data.totalOrders ? `${data.peakHour}시` : '-'}</div></div>
            <div className="kpi"><div className="label">활동 시간대</div><div className="value">{data.activeHours}개 / 평균 {data.avgPerActiveHour}건</div></div>
          </div>
          <div className="table-wrap">
            <div className="hour-chart">
              {data.hourly.map((v, h) => (
                <div className="hour-bar-col" key={h}>
                  <div className="hour-bar-track">
                    <div className="hour-bar" style={{ height: `${Math.round(v / hourMax * 100)}%` }} title={`${h}시: ${v}건`} />
                  </div>
                  <div className="hour-bar-label">{h}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="card dashboard-analysis-card">
          <h2>📅 요일 × 시간 히트맵</h2>
          <div className="table-wrap">
            <div className="heatmap-grid">
              <div className="heatmap-cell heatmap-corner" />
              {Array.from({ length: 24 }, (_, hh) => (
                <div className="heatmap-cell heatmap-label" key={hh}>{hh}</div>
              ))}
              {DOW_LABELS.map((dowLabel, dowIdx) => (
                <Fragment key={dowLabel}>
                  <div className="heatmap-cell heatmap-label">{dowLabel}</div>
                  {Array.from({ length: 24 }, (_, h2) => {
                    const v = data.heatmap[dowIdx][h2];
                    const alpha = v ? (0.15 + 0.85 * v / data.heatmapMax).toFixed(2) : 0.04;
                    return (
                      <div
                        className="heatmap-cell"
                        key={h2}
                        style={{ background: `rgba(46,92,138,${alpha})` }}
                        title={`${dowLabel}요일 ${h2}시: ${v}건`}
                      >
                        {v || ''}
                      </div>
                    );
                  })}
                </Fragment>
              ))}
            </div>
          </div>
        </section>
      </div>

      {data.showBranchSections && (
        <div className="dashboard-card-grid">
          <section className="card dashboard-analysis-card">
            <h2>🏢 지사별 비교 <small className="page-sub" style={{ fontWeight: 400 }}>(직전 동일 기간 대비)</small></h2>
            <div className="table-wrap">
              <table>
                <thead><tr><th>지사</th><th>콜수</th><th>이전 콜수</th><th>증감</th><th>매출</th><th>이전 매출</th><th>증감</th></tr></thead>
                <tbody>
                  {data.branchCompare.length === 0 && <tr><td colSpan={7} className="empty">데이터가 없습니다.</td></tr>}
                  {data.branchCompare.map((b) => (
                    <tr key={b.branch_name}>
                      <td>{b.branch_name}</td>
                      <td>{b.cnt}건</td>
                      <td>{b.prev_cnt}건</td>
                      <td>{b.cnt_pct === null ? '-' : `${b.cnt_pct >= 0 ? '+' : ''}${b.cnt_pct}%`}</td>
                      <td>{formatMoney(b.fare)}</td>
                      <td>{formatMoney(b.prev_fare)}</td>
                      <td>{b.fare_pct === null ? '-' : `${b.fare_pct >= 0 ? '+' : ''}${b.fare_pct}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card dashboard-analysis-card">
            <h2>🗂 지사별 상태 디테일</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>지사</th>
                    {data.ORDER_STATUSES.map((s) => <th key={s}>{s}</th>)}
                    <th>합계</th><th>매출</th>
                  </tr>
                </thead>
                <tbody>
                  {data.statusMatrix.length === 0 && (
                    <tr><td colSpan={data.ORDER_STATUSES.length + 3} className="empty">데이터가 없습니다.</td></tr>
                  )}
                  {data.statusMatrix.map((row) => (
                    <tr key={row.branch_name}>
                      <td>{row.branch_name}</td>
                      {data.ORDER_STATUSES.map((s) => <td key={s}>{row.statuses[s] || 0}</td>)}
                      <td><b>{row.total}</b></td>
                      <td>{formatMoney(row.fare)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      <div className="card">
        <h2>👥 법인별 콜수·매출</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>법인(고객사)</th><th>콜수</th><th>매출</th></tr></thead>
            <tbody>
              {data.groupCompare.length === 0 && <tr><td colSpan={3} className="empty">법인별 데이터가 없습니다.</td></tr>}
              {data.groupCompare.map((g) => (
                <tr key={g.group_name}><td>{g.group_name}</td><td>{g.cnt}건</td><td>{formatMoney(g.fare)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
