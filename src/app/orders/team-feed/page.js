// 팀 접수 현황 안내 — views/orders/team_feed.ejs의 Next 판.
//
// 읽기 전용 화면이라 서버 컴포넌트 하나면 된다. 판정(개인 딜러 차단·기능 on/off)은 전부
// Express가 하고(GET /orders/team-feed/data.json) 여기서는 그리기만 한다 — 같은 판정을
// 두 곳에 두면 한쪽만 고쳐 권한이 갈린다.
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../_components/AppShell';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

const KIND_BADGE = { cancelled: 'red', created: 'green' };

export default async function TeamFeedPage() {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/orders/team-feed/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  // 개인 딜러는 이 화면을 열 수 없다 — EJS는 403 페이지를 그렸다. 같은 자리를 지킨다.
  if (res.status === 403) {
    return (
      <AppShell currentUser={null} activePath="/orders/team-feed">
        <div className="card"><p className="page-sub" style={{ margin: 0 }}>접근 권한이 없습니다.</p></div>
      </AppShell>
    );
  }
  if (!res.ok) throw new Error('팀 접수 현황을 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, groupName, enabled, activities, kindLabels } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/orders/team-feed">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">팀 접수 현황 안내</h1>
          <p className="page-sub">
            {groupName ? `${groupName} 소속 동료들의 접수·취소·변경 요청을 모아 보여줍니다. ` : ''}
            대화 내용 자체가 아니라 요청 요약만 공유되며, 본인의 대화 흐름에는 끼어들지 않습니다.
          </p>
        </div>
      </div>

      {!groupName ? (
        <div className="card">
          <p className="page-sub" style={{ margin: 0 }}>소속된 법인이 없어 이 기능을 쓸 수 없습니다. 관리자에게 문의해주세요.</p>
        </div>
      ) : !enabled ? (
        <div className="card">
          <p className="page-sub" style={{ margin: 0 }}>
            아직 우리 회사는 이 기능이 꺼져 있습니다. 켜고 싶으시면 담당 상담원이나 관리자에게 요청해주세요.
          </p>
        </div>
      ) : (
        <div className="card">
          {activities.length === 0 ? (
            <p className="page-sub" style={{ margin: 0 }}>아직 공유된 소식이 없습니다. 동료가 접수·취소·변경을 하면 여기 나타납니다.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 130 }}>구분</th><th>내용</th>
                  <th style={{ width: 120 }}>담당자</th><th style={{ width: 160 }}>시각</th>
                </tr>
              </thead>
              <tbody>
                {activities.map((a, i) => (
                  <tr key={a.id != null ? a.id : i}>
                    <td>
                      <span className={'badge ' + (KIND_BADGE[a.kind] || 'amber')}>
                        {kindLabels[a.kind] || a.kind}
                      </span>
                      {a.oid ? <><br /><span className="page-sub">{a.oid}</span></> : null}
                    </td>
                    <td>{a.summary}</td>
                    <td>{a.actor_label}</td>
                    <td>{a.created_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </AppShell>
  );
}
