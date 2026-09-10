// 연동 오류 현황 — views/integration_errors/index.ejs의 Next 판.
//
// 읽기 전용 대시보드다. 네 곳에 흩어진 실패 기록(통합 로그·콜마너 접수·MCP 도구·카카오 수신)을
// 한 화면에 모은다. 조회는 Express가 하고(GET /integration-errors/data.json) 여기서는 그린다.
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../_components/AppShell';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

const SOURCE_BADGE = { callmaner: 'blue', kakao: 'amber' };

// 섹션별 조회 실패를 구분해 보여준다 — 마이그레이션 미적용과 진짜 오류는 대응이 다르다.
function sectionNote(section) {
  if (!section || !section.error) return null;
  return /does not exist/i.test(section.error)
    ? '이 항목은 아직 마이그레이션이 적용되지 않아 조회할 수 없습니다.'
    : '조회 실패: ' + section.error;
}

// 섹션 하나: 오류 안내 / 빈 목록 / 표 중 하나를 그린다. 세 갈래가 네 번 반복돼서 묶었다.
function Section({ title, sub, section, head, row, emptyText = '기록 없음' }) {
  const note = sectionNote(section);
  const rows = (section && section.rows) || [];
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="section-title">{title}</div>
      {sub ? <p className="page-sub" style={{ margin: '0 0 10px' }}>{sub}</p> : null}
      {note ? (
        <p className="page-sub" style={{ margin: 0 }}>{note}</p>
      ) : rows.length === 0 ? (
        <p className="page-sub" style={{ margin: 0 }}>{emptyText}</p>
      ) : (
        <table className="table">
          <thead>{head}</thead>
          <tbody>{rows.map(row)}</tbody>
        </table>
      )}
    </div>
  );
}

export default async function IntegrationErrorsPage({ searchParams }) {
  const sp = (await searchParams) || {};
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const qs = new URLSearchParams(sp).toString();
  const res = await fetch(`${proto}://${host}/integration-errors/data.json${qs ? '?' + qs : ''}`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401 || res.status === 403) redirect('/login');
  if (!res.ok) throw new Error('연동 오류 현황을 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, rangeOptions, limit, range, summary, unified, callmaner, mcp, kakao } = await res.json();
  const summaryNote = sectionNote(summary);
  const total = ((summary && summary.rows) || []).reduce((a, r) => a + Number(r.cnt), 0);

  return (
    <AppShell currentUser={currentUser} activePath="/integration-errors">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">연동 오류 현황</h1>
          <p className="page-sub">콜마너 · MCP 배차 · 카카오 상담톡 연동에서 실패한 건을 모아 보여줍니다. 기록이 네 곳에 흩어져 있어 한 화면에 정리했습니다.</p>
        </div>
        <div className="page-head-actions">
          {/* GET form이라 서버로 그대로 넘어간다 — EJS는 onchange로 자동 제출했는데, 그
              동작을 위해 화면 전체를 클라이언트 컴포넌트로 만들 이유는 없다. 조회 버튼을 둔다. */}
          <form method="GET" action="/integration-errors" className="inline-filter-form">
            <select name="range" defaultValue={range.key}>
              {rangeOptions.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
            <input type="hidden" name="limit" value={limit} />
            <button className="btn secondary small" type="submit">조회</button>
          </form>
          <a className="btn secondary" href={`/integration-errors?range=${range.key}&limit=${limit}`}>새로고침</a>
        </div>
      </div>

      <div className="card">
        <div className="section-title">
          📊 통합 오류 요약 <span className="page-sub" style={{ fontWeight: 400 }}>({range.label})</span>
        </div>
        {summaryNote ? (
          <p className="page-sub" style={{ margin: 0 }}>{summaryNote}</p>
        ) : !((summary && summary.rows) || []).length ? (
          <p className="page-sub" style={{ margin: 0 }}>이 기간에 기록된 연동 오류가 없습니다.</p>
        ) : (
          <>
            <p className="page-sub" style={{ margin: '0 0 10px' }}>총 <strong>{total}</strong>건</p>
            <table className="table">
              <thead><tr><th>연동</th><th>동작</th><th style={{ width: 90 }}>건수</th><th>최근 발생</th></tr></thead>
              <tbody>
                {summary.rows.map((r, i) => (
                  <tr key={i}>
                    <td><span className={'badge ' + (SOURCE_BADGE[r.source] || 'purple')}>{r.source}</span></td>
                    <td>{r.operation}</td>
                    <td>{r.cnt}</td>
                    <td>{r.last}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <Section
        title="🧾 통합 오류 로그 (integration_errors)"
        sub="상태동기화 크론 실패, 카카오 발신 실패, MCP 도구 예외처럼 다른 표에 남지 않는 실패입니다."
        section={unified}
        head={<tr><th style={{ width: 150 }}>발생시각</th><th style={{ width: 90 }}>연동</th><th style={{ width: 130 }}>동작</th><th style={{ width: 110 }}>대상</th><th>내용</th></tr>}
        row={(r, i) => (
          <tr key={i}>
            <td>{r.created_at}</td><td>{r.source}</td><td>{r.operation}</td>
            <td>{r.ref_id ? `${r.ref_type} ${r.ref_id}` : '-'}</td>
            <td>{r.error_code ? `[${r.error_code}] ` : ''}{r.message}</td>
          </tr>
        )}
      />

      <Section
        title="🚚 콜마너 오더접수 실패"
        sub="오더 상세 화면의 빨간 배지와 같은 값입니다."
        section={callmaner}
        head={<tr><th style={{ width: 150 }}>등록시각</th><th style={{ width: 120 }}>오더</th><th style={{ width: 80 }}>코드</th><th>사유</th></tr>}
        row={(r) => (
          <tr key={r.id}>
            <td>{r.created_at}</td>
            <td><a href={`/orders/${r.id}`}>{r.oid}</a></td>
            <td>{r.code || '-'}</td>
            <td>{r.err}</td>
          </tr>
        )}
      />

      <Section
        title="🤖 MCP 배차 도구 호출 실패"
        section={mcp}
        head={<tr><th style={{ width: 150 }}>발생시각</th><th style={{ width: 220 }}>도구</th><th style={{ width: 100 }}>상담세션</th><th>사유</th></tr>}
        row={(r, i) => (
          <tr key={i}>
            <td>{r.created_at}</td><td>{r.tool_name}</td>
            <td>{r.session_id ? `#${r.session_id}` : '-'}</td><td>{r.error}</td>
          </tr>
        )}
      />

      <Section
        title="💬 카카오 상담톡 미처리 수신"
        sub="missing_keys는 인증 키 없이 들어온 요청, field_spec_unconfirmed는 스펙 미확정으로 기록만 한 건입니다."
        section={kakao}
        head={<tr><th style={{ width: 150 }}>수신시각</th><th style={{ width: 170 }}>이벤트</th><th style={{ width: 100 }}>상담세션</th><th>사유</th></tr>}
        row={(r, i) => (
          <tr key={i}>
            <td>{r.created_at}</td><td>{r.event_type}</td>
            <td>{r.session_id ? `#${r.session_id}` : '-'}</td><td>{r.error_message || '-'}</td>
          </tr>
        )}
      />
    </AppShell>
  );
}
