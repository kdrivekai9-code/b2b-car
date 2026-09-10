// 지사 설정 화면의 공통 껍데기 — 제목 줄 + 저장 버튼 + 탭.
//
// 열세 화면이 같은 모양을 반복한다(제목 "<지사> · <설정 이름>", 목록으로 가는 버튼, 저장
// 버튼, 탭 줄). 화면마다 다시 쓰면 한 곳만 고쳐지고 나머지가 남는다 — EJS가 실제로 그랬다.
//
// 저장 버튼은 form 속성으로 바깥의 <form>을 제출한다(EJS와 같은 구조). formId를 안 넘기면
// 버튼을 그리지 않는다 — 읽기 전용 화면도 이 껍데기를 쓸 수 있어야 한다.
import BranchTabs from './BranchTabs';

export default function BranchSettingsShell({ branch, branches, active, title, sub, formId, actions, children }) {
  return (
    <>
      <div className="page-head-row">
        <div>
          <h1 className="page-title">{branch.name} · {title}</h1>
          {sub ? <p className="page-sub">{sub}</p> : null}
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/branches">지사 목록으로</a>
          {actions}
          {formId ? <button className="btn" type="submit" form={formId}>저장</button> : null}
        </div>
      </div>
      <BranchTabs branch={branch} branches={branches} active={active} />
      {children}
    </>
  );
}
