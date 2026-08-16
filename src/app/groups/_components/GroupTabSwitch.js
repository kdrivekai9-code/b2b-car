'use client';

// 법인이 여럿일 때 탭 줄 오른쪽에서 법인을 바꾼다. 같은 탭을 유지한 채 대상만 바꾸는 것이
// 목적이라 switchPath를 그대로 이어붙인다(지사 쪽 BranchTabSwitch와 같은 방식).
export default function GroupTabSwitch({ groups, activeGroupId, switchPath }) {
  return (
    <select
      className="branch-tab-switch"
      defaultValue={String(activeGroupId)}
      onChange={(e) => { window.location.href = '/groups/' + e.target.value + '/' + switchPath; }}
    >
      {groups.map((g) => (
        <option key={g.id} value={g.id}>{g.name}</option>
      ))}
    </select>
  );
}
