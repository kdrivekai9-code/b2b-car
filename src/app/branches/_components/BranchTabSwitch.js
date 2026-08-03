'use client';

export default function BranchTabSwitch({ branches, activeBranchId, switchPath }) {
  return (
    <select
      className="branch-tab-switch"
      defaultValue={String(activeBranchId)}
      onChange={(e) => { window.location.href = '/branches/' + e.target.value + '/' + switchPath; }}
    >
      {branches.map((b) => (
        <option key={b.id} value={b.id}>{b.name}</option>
      ))}
    </select>
  );
}
