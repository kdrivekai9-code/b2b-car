// 정산내역(고객용) — /my/settlement. views/groups/settlement.ejs를 clientView로 렌더하던 것의 Next 판.
//
// 관리자 화면과 **같은 본문 부품**을 쓴다. 다른 것은 둘뿐이다:
//   · 탭 줄이 없다 — 법인 설정 탭은 관리자용이고, 고객은 자기 정산만 본다.
//   · 법인을 주소창이 아니라 로그인 계정에서 정한다(남의 법인을 열 수 없다).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../_components/AppShell';
import SettlementView from '../../_components/settlement/SettlementView';
import { ExcelLink, PrintButton } from '../../_components/settlement/SettlementActions';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function MySettlementPage({ searchParams }) {
  const sp = (await searchParams) || {};
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const qs = new URLSearchParams(sp).toString();
  const res = await fetch(`${proto}://${host}/my/settlement/data.json${qs ? '?' + qs : ''}`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (res.status === 403) {
    return (
      <AppShell currentUser={null} activePath="/my/settlement">
        <div className="card"><p className="page-sub" style={{ margin: 0 }}>접근 권한이 없습니다.</p></div>
      </AppShell>
    );
  }
  if (!res.ok) throw new Error('정산내역을 불러오지 못했습니다 (' + res.status + ')');

  const data = await res.json();
  const { currentUser, group, month, surchargeMode } = data;

  return (
    <AppShell currentUser={currentUser} activePath="/my/settlement">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">{group.name} · 정산내역</h1>
          <p className="page-sub">
            완료된 오더를 <b>완료일 기준</b>으로 묶었습니다. 금액은 업체별 계약 요금입니다(배차 요금 아님).
            {' '}할증 표시는 <b>{surchargeMode === 'itemized' ? '별도 줄(항목별)' : '운행요금 포함'}</b> 방식입니다.
          </p>
        </div>
        <div className="page-head-actions">
          {/* **고객 전용 경로를 쓴다.** EJS 화면은 이 버튼들을 /groups/:id/... 로 걸어뒀는데
              그 라우터는 통째로 requireRole('admin')이라 고객이 누르면 403이었다(2026-09-10
              확인). 2026-09-11 사용자 요청으로 /my/settlement/{excel,print,individual-print}를
              열었다 — 생성 코드는 관리자와 **같은 함수**이고, 범위(법인·딜러)만 서버가
              로그인 계정에서 정한다. */}
          <ExcelLink base="/my/settlement" month={month} />
          <PrintButton base="/my/settlement" month={month} />
        </div>
      </div>
      <SettlementView data={data} sp={sp} base="/my/settlement" />
    </AppShell>
  );
}
