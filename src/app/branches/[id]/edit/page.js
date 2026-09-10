// 지사 기본 정보 — views/branches/form.ejs(edit 모드)의 Next 판.
//
// 신규 등록(/branches/new)은 아직 EJS다. 같은 뷰를 쓰지만 탭이 없고 action이 달라, 함께
// 옮기면 이 화면의 확인 범위가 넓어진다 — 먼저 수정 화면만 옮긴다.
import AppShell from '../../../_components/AppShell';
import BranchSettingsShell from '../../_components/BranchSettingsShell';
import loadBranchData from '../../_components/loadBranchData';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

const ROLE_LABELS = { admin: '관리자', branch_manager: '지사장', client: '클라이언트' };

export default async function BranchEditPage({ params }) {
  const { id } = await params;
  const { currentUser, branch, branches, accountUsers } = await loadBranchData(id, 'edit');

  return (
    <AppShell currentUser={currentUser} activePath="/branches">
      <BranchSettingsShell
        branch={branch} branches={branches} active="basic" formId="branchForm"
        title="기본 정보" sub="지사 기본 정보를 입력하세요."
      >
        <div className="card">
          <form id="branchForm" method="POST" action={`/branches/${branch.id}`}>
            <div className="section-title">🏢 기본 정보</div>
            <div className="row">
              <div className="field"><label>지사명 *</label><input type="text" name="name" defaultValue={branch.name || ''} required /></div>
              <div className="field"><label>지사코드 *</label><input type="text" name="code" defaultValue={branch.code || ''} required /></div>
            </div>
            <div className="row">
              <div className="field"><label>대표번호</label><input type="text" name="main_phone" defaultValue={branch.main_phone || ''} /></div>
              <div className="field"><label>담당자</label><input type="text" name="contact_name" defaultValue={branch.contact_name || ''} /></div>
              <div className="field"><label>담당자 연락처</label><input type="text" name="contact_phone" placeholder="010-0000-0000" defaultValue={branch.contact_phone || ''} /></div>
            </div>
            <div className="row">
              <div className="field full"><label>주소</label><input type="text" name="address" defaultValue={branch.address || ''} /></div>
            </div>

            {/* 청구서에 그대로 찍히는 값이다 — 비어 있으면 받는 쪽이 어디로 입금할지 알 수
                없어 따로 물어야 한다. 세 칸으로 나눈 이유는 은행만 바꿀 때 전체를 다시 쓰지
                않게 하고, 예금주가 빠진 채 저장되는 것을 눈으로 알아채기 위해서다. */}
            <div className="section-title" style={{ fontSize: 14, marginTop: 16 }}>
              💳 입금계좌 <span className="page-sub">(정산서·청구서에 표시)</span>
            </div>
            <div className="row">
              <div className="field"><label>은행</label><input type="text" name="bank_name" placeholder="예: 국민은행" defaultValue={branch.bank_name || ''} /></div>
              <div className="field"><label>계좌번호</label><input type="text" name="bank_account" placeholder="예: 123456-01-234567" defaultValue={branch.bank_account || ''} /></div>
              <div className="field"><label>예금주</label><input type="text" name="bank_holder" placeholder="예: (주)씨엠엔피" defaultValue={branch.bank_holder || ''} /></div>
            </div>
            <div className="row">
              <div className="field">
                <label>상태</label>
                <select name="status" defaultValue={branch.status || 'active'}>
                  <option value="active">활성</option>
                  <option value="inactive">비활성</option>
                </select>
              </div>
            </div>
          </form>
        </div>

        <div className="card">
          <div className="page-head-row" style={{ marginBottom: 8 }}>
            <div className="section-title" style={{ margin: 0 }}>🔑 계정정보</div>
            <a className="btn small secondary" href="/users/new">+ 사용자 등록</a>
          </div>
          <p className="page-sub" style={{ marginTop: 0 }}>이 지사 소속으로 사용자 관리에 등록된 계정입니다. 비밀번호는 보안상 표시되지 않으며, 관리자만 수정할 수 있습니다.</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>이름</th><th>아이디</th><th>비밀번호</th><th>역할</th><th>상태</th><th>관리</th></tr></thead>
              <tbody>
                {(!accountUsers || accountUsers.length === 0) && (
                  <tr><td colSpan={6} className="empty">등록된 계정이 없습니다.</td></tr>
                )}
                {(accountUsers || []).map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>{u.login_id}</td>
                    <td>••••••••</td>
                    <td>{ROLE_LABELS[u.role] || u.role}</td>
                    <td><span className={'badge ' + (u.status === 'active' ? 'green' : 'gray')}>{u.status === 'active' ? '활성' : '비활성'}</span></td>
                    <td><a className="btn small secondary" href={`/users/${u.id}/edit`}>수정</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </BranchSettingsShell>
    </AppShell>
  );
}
