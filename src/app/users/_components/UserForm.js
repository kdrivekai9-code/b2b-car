'use client';

import { useState } from 'react';

const ROLE_OPTIONS = [
  { value: 'admin', label: '관리자(센터)' },
  { value: 'branch_manager', label: '지사장(모니터링 전용)' },
  { value: 'client', label: '클라이언트(고객사)' },
];

export default function UserForm({ mode, user, branches, groups }) {
  const [role, setRole] = useState(user.role || 'admin');
  const action = mode === 'create' ? '/users' : `/users/${user.id}`;

  return (
    <form id="userForm" method="POST" action={action}>
      <div className="section-title">🧑‍💼 계정 정보</div>
      <div className="row">
        <div className="field">
          <label>아이디 {mode === 'create' ? '*' : ''}</label>
          {mode === 'create' ? (
            <input type="text" name="login_id" required />
          ) : (
            <input type="text" defaultValue={user.login_id} disabled />
          )}
        </div>
        <div className="field"><label>이름 *</label><input type="text" name="name" defaultValue={user.name || ''} required /></div>
      </div>
      <div className="row">
        <div className="field"><label>연락처</label><input type="text" name="phone" defaultValue={user.phone || ''} /></div>
        <div className="field">
          <label>비밀번호 {mode === 'create' ? '*' : '(변경 시에만 입력)'}</label>
          <input
            type="password"
            name="password"
            required={mode === 'create'}
            placeholder={mode === 'edit' ? '변경하지 않으려면 비워두세요' : ''}
          />
        </div>
      </div>
      <div className="section-title">🔑 권한 정보</div>
      <div className="row">
        <div className="field">
          <label>권한(역할) *</label>
          <select name="role" required value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLE_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>지사</label>
          <select name="branch_id" defaultValue={user.branch_id != null ? String(user.branch_id) : ''}>
            <option value="">선택 안 함</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="row" style={{ display: role === 'client' ? 'flex' : 'none' }}>
        <div className="field">
          <label>소속 법인</label>
          <select name="group_id" defaultValue={user.group_id != null ? String(user.group_id) : ''}>
            <option value="">선택 안 함</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>권한 등급</label>
          <select name="grade" defaultValue={user.grade || 'leader'}>
            <option value="leader">법인 담당(리더)</option>
            <option value="member">법인 담당(일반)</option>
          </select>
        </div>
      </div>
      {mode === 'edit' && (
        <div className="row">
          <div className="field">
            <label>상태</label>
            <select name="status" defaultValue={user.status || 'active'}>
              <option value="active">활성</option>
              <option value="inactive">비활성</option>
            </select>
          </div>
        </div>
      )}
    </form>
  );
}
