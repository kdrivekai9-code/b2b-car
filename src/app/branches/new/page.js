// 지사 등록 — views/branches/form.ejs(create 모드)의 Next 판.
//
// 수정 화면(/branches/:id/edit)과 같은 폼이지만 탭이 없고(아직 지사가 없다), 상태 select와
// 계정정보 목록도 없다. 그 차이만 빼고 칸 구성은 같아야 한다 — 다르면 등록할 때만 빠지는
// 값이 생긴다(실제로 입금계좌 세 칸이 그랬다: 폼에는 있는데 저장 라우트가 안 읽었다).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../_components/AppShell';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function BranchNewPage() {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  // 목록 엔드포인트로 로그인·권한만 확인한다(등록 화면은 보여줄 값이 없다).
  const res = await fetch(`${proto}://${host}/branches/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401 || res.status === 403) redirect('/login');
  if (!res.ok) throw new Error('지사 등록 화면을 열지 못했습니다 (' + res.status + ')');
  const { currentUser } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/branches">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">지사 등록</h1>
          <p className="page-sub">지사 기본 정보를 입력하세요.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/branches">취소</a>
          <button className="btn" type="submit" form="branchForm">저장</button>
        </div>
      </div>

      <div className="card">
        <form id="branchForm" method="POST" action="/branches">
          <div className="section-title">🏢 기본 정보</div>
          <div className="row">
            <div className="field"><label>지사명 *</label><input type="text" name="name" required /></div>
            <div className="field"><label>지사코드 *</label><input type="text" name="code" required /></div>
          </div>
          <div className="row">
            <div className="field"><label>대표번호</label><input type="text" name="main_phone" /></div>
            <div className="field"><label>담당자</label><input type="text" name="contact_name" /></div>
            <div className="field"><label>담당자 연락처</label><input type="text" name="contact_phone" placeholder="010-0000-0000" /></div>
          </div>
          <div className="row">
            <div className="field full"><label>주소</label><input type="text" name="address" /></div>
          </div>

          {/* 청구서에 그대로 찍히는 값이다 — 비어 있으면 받는 쪽이 어디로 입금할지 알 수
              없어 따로 물어야 한다. 세 칸으로 나눈 이유는 은행만 바꿀 때 전체를 다시 쓰지
              않게 하고, 예금주가 빠진 채 저장되는 것을 눈으로 알아채기 위해서다. */}
          <div className="section-title" style={{ fontSize: 14, marginTop: 16 }}>
            💳 입금계좌 <span className="page-sub">(정산서·청구서에 표시)</span>
          </div>
          <div className="row">
            <div className="field"><label>은행</label><input type="text" name="bank_name" placeholder="예: 국민은행" /></div>
            <div className="field"><label>계좌번호</label><input type="text" name="bank_account" placeholder="예: 123456-01-234567" /></div>
            <div className="field"><label>예금주</label><input type="text" name="bank_holder" placeholder="예: (주)씨엠엔피" /></div>
          </div>
        </form>
      </div>
    </AppShell>
  );
}
