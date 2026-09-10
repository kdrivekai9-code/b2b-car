'use client';

import { useState } from 'react';

// 계정 등록/수정 폼 — views/groups/accounts.ejs의 <script>를 옮겼다.
//
// 클라이언트인 이유 하나: **별도청구는 개인 딜러에게만 의미가 있다.** 본사 직원에게 개인
// 정산서를 끊는 개념이 없어서, 칸을 남겨두면 켜놓고 "왜 안 나뉘지"를 겪는다.
export default function AccountForm({ group, branches, editing, clientTypes }) {
  const [clientType, setClientType] = useState(
    (editing && editing.client_type) || (clientTypes[0] && clientTypes[0].value) || ''
  );
  const isDealer = clientType === 'dealer';
  const hint = (clientTypes.find((t) => t.value === clientType) || {}).hint || '';

  return (
    <form method="POST" action={`/groups/${group.id}/accounts${editing ? '/' + editing.id : ''}`}>
      <div className="form-grid">
        <div className="field">
          <label>아이디</label>
          {editing ? (
            <>
              <input type="text" value={editing.login_id} disabled />
              <span className="hint">아이디는 변경할 수 없습니다.</span>
            </>
          ) : (
            <input type="text" name="login_id" required autoComplete="off" />
          )}
        </div>
        <div className="field">
          <label>이름</label>
          <input type="text" name="name" defaultValue={editing ? editing.name : ''} required />
        </div>
        <div className="field">
          <label>비밀번호</label>
          <input type="password" name="password" autoComplete="new-password" required={!editing} />
          <span className="hint">{editing ? '비워두면 기존 비밀번호를 그대로 둡니다.' : '4자 이상'}</span>
        </div>
        <div className="field">
          <label>연락처</label>
          <input type="text" name="phone" defaultValue={editing ? (editing.phone || '') : ''} placeholder="010-0000-0000" />
        </div>
        <div className="field">
          <label>역할</label>
          <select name="role" defaultValue={editing ? editing.role : 'client'}>
            <option value="client">클라이언트</option>
            <option value="branch_manager">지사장</option>
            <option value="admin">관리자</option>
          </select>
        </div>
        {/* 법인 계정 구분 — 개인 딜러는 본인이 접수한 오더만 본다(웹·챗봇·상담톡 모두). */}
        <div className="field">
          <label>계정 구분</label>
          <select name="client_type" value={clientType} onChange={(e) => setClientType(e.target.value)}>
            {(clientTypes || []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <span className="hint">{hint}</span>
        </div>
        {isDealer && (
          <div className="field">
            <label>정산 청구</label>
            <label className="checkline">
              <input type="checkbox" name="separate_settlement" value="1"
                defaultChecked={!!(editing && editing.separate_settlement)} />
              {' '}이 딜러에게 <b>별도 정산서</b>를 끊습니다
            </label>
            <span className="hint">끄면 법인 본사 정산서에 합쳐집니다. 오더 조회 범위와는 별개입니다.</span>
          </div>
        )}
        <div className="field">
          <label>소속 지사</label>
          <select name="branch_id" defaultValue={String(editing ? editing.branch_id : group.branch_id)}>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <span className="hint">비워두면 법인이 속한 지사({group.branch_name || '-'})로 지정됩니다.</span>
        </div>
      </div>
      <div className="form-actions">
        <button className="btn" type="submit">{editing ? '저장' : '등록'}</button>
        {editing && <a className="btn secondary" href={`/groups/${group.id}/accounts`}>취소</a>}
      </div>
    </form>
  );
}
