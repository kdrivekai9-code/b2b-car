// 법인 설정 화면의 공통 껍데기 — 지사(BranchSettingsShell)와 짝을 이룬다.
//
// 여덟 화면이 같은 모양을 반복한다(제목 "<법인> · <설정 이름>", 목록으로 가는 버튼, 저장
// 버튼, 탭 줄). 화면마다 다시 쓰면 한 곳만 고쳐지고 나머지가 남는다.
import GroupTabs from './GroupTabs';

export default function GroupSettingsShell({ group, groups, active, title, sub, formId, actions, children }) {
  return (
    <>
      <div className="page-head-row">
        <div>
          <h1 className="page-title">{group.name} · {title}</h1>
          {sub ? <p className="page-sub">{sub}</p> : null}
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/groups">법인 목록으로</a>
          {actions}
          {formId ? <button className="btn" type="submit" form={formId}>저장</button> : null}
        </div>
      </div>
      <GroupTabs group={group} groups={groups} active={active} />
      {children}
    </>
  );
}
