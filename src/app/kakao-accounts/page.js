// 카카오 채널 매핑 — views/kakao_accounts/index.ejs의 Next 판.
//
// 등록 폼만 클라이언트 컴포넌트다(세션에서 키 가져오기·미등록계정 분기·지사별 법인 필터).
// 목록의 켜기/끄기·삭제는 순수 HTML form이라 서버에서 그대로 그린다.
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../_components/AppShell';
import ConfirmForm from '../_components/ConfirmForm';
import MappingForm from './MappingForm';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function KakaoAccountsPage({ searchParams }) {
  const sp = (await searchParams) || {};
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/kakao-accounts/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401 || res.status === 403) redirect('/login');
  if (!res.ok) throw new Error('채널 매핑을 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, accounts, branches, groups, users, paymentMethods, recentSessions } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/kakao-accounts">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">카카오 채널 매핑</h1>
          <p className="page-sub">카카오 상담톡 고객은 b2b-car 계정이 없어서, 어느 계정·지사로 접수하고 조회할지 채널 단위로 지정합니다. 등록되지 않은 채널은 상담원 연결로만 처리됩니다.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/chat/sessions">상담 관리로</a>
          <button className="btn" type="submit" form="kakaoAccountForm">등록</button>
        </div>
      </div>

      {sp.error ? <div className="error-msg">{sp.error}</div> : null}
      {sp.notice ? <div className="success-msg">{sp.notice}</div> : null}

      <div className="card">
        <MappingForm
          recentSessions={recentSessions}
          users={users}
          branches={branches}
          groups={groups}
          paymentMethods={paymentMethods}
          error={sp.error || null}
        />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="section-title">📋 등록된 채널 매핑</div>
        {!accounts.length ? (
          <p className="page-sub" style={{ margin: 0 }}>등록된 매핑이 없습니다. 지금은 모든 카카오 문의가 상담원 연결로 넘어갑니다.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>대상</th><th>담당 계정</th><th>지사 / 법인</th><th>결제수단</th>
                <th style={{ width: 90 }}>자동등록</th><th style={{ width: 80 }}>사용</th>
                <th style={{ width: 150 }}>등록일시</th><th style={{ width: 70 }}></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.label ? <><strong>{a.label}</strong><br /></> : null}
                    <span className="page-sub">
                      {a.external_user_key ? <>고객 {a.external_user_key}<br /></> : null}
                      service {a.service_key ? String(a.service_key).slice(0, 16) + '…' : '(전체)'}
                    </span>
                  </td>
                  <td>{a.user_name || '(삭제된 계정)'}<br /><span className="page-sub">{a.login_id || ''}</span></td>
                  <td>{a.branch_name || '-'}<br /><span className="page-sub">{a.group_name || '법인 미지정'}</span></td>
                  <td>{a.payment_name || '-'}</td>
                  <td>
                    <form method="POST" action={`/kakao-accounts/${a.id}/toggle-auto`}>
                      <button className={'btn small ' + (a.auto_register ? '' : 'secondary')} type="submit">
                        {a.auto_register ? '켜짐' : '꺼짐'}
                      </button>
                    </form>
                  </td>
                  <td>
                    <form method="POST" action={`/kakao-accounts/${a.id}/toggle-enabled`}>
                      <button className={'btn small ' + (a.enabled ? '' : 'secondary')} type="submit">
                        {a.enabled ? '사용' : '중지'}
                      </button>
                    </form>
                  </td>
                  <td>{a.created_at}</td>
                  <td>
                    <ConfirmForm message="이 채널 매핑을 삭제할까요? 해당 채널은 상담원 연결로만 처리됩니다."
                      method="POST" action={`/kakao-accounts/${a.id}/delete`}>
                      <button className="btn small danger" type="submit">삭제</button>
                    </ConfirmForm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AppShell>
  );
}
