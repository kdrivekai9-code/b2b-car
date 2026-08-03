'use client';

import { useState } from 'react';

const SETTLEMENT_METHODS = ['계좌이체', '카드', '후불', '현금', '기타'];

export default function GroupForm({ mode, group, branches }) {
  const branchPhoneMap = Object.fromEntries(branches.map((b) => [String(b.id), b.main_phone || '']));
  const [branchId, setBranchId] = useState(group.branch_id != null ? String(group.branch_id) : '');
  const [mainPhone, setMainPhone] = useState(group.main_phone || '');
  const [phoneTouched, setPhoneTouched] = useState(false);
  const action = mode === 'create' ? '/groups' : `/groups/${group.id}`;

  function handleBranchChange(e) {
    const nextBranchId = e.target.value;
    setBranchId(nextBranchId);
    if (!phoneTouched) {
      setMainPhone(branchPhoneMap[nextBranchId] || '');
    }
  }

  return (
    <form id="groupForm" method="POST" action={action}>
      <div className="section-title">🏢 법인 정보</div>
      <div className="row">
        <div className="field">
          <label>소속 지사 *</label>
          <select name="branch_id" required value={branchId} onChange={handleBranchChange}>
            <option value="">선택하세요</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>대표번호</label>
          <input
            type="text"
            name="main_phone"
            value={mainPhone}
            onChange={(e) => { setPhoneTouched(true); setMainPhone(e.target.value); }}
          />
        </div>
      </div>
      <div className="row">
        <div className="field"><label>법인명 *</label><input type="text" name="name" defaultValue={group.name || ''} required /></div>
        <div className="field"><label>사업자등록번호</label><input type="text" name="business_registration_number" defaultValue={group.business_registration_number || ''} placeholder="예: 123-45-67890" /></div>
      </div>
      <div className="row">
        <div className="field"><label>업체 전화번호</label><input type="text" name="company_phone" defaultValue={group.company_phone || ''} placeholder="예: 02-1234-5678" /></div>
        <div className="field"><label>담당자명</label><input type="text" name="contact_name" defaultValue={group.contact_name || ''} /></div>
      </div>
      <div className="row">
        <div className="field"><label>담당자 연락처/전화번호</label><input type="text" name="contact_phone" defaultValue={group.contact_phone || ''} placeholder="예: 010-1234-5678" /></div>
        <div className="field"><label>이메일주소</label><input type="email" name="tax_email" defaultValue={group.tax_email || ''} placeholder="tax@example.com" /></div>
      </div>
      <div className="row">
        <div className="field full"><label>실제 사업장 주소지</label><input type="text" name="business_address" defaultValue={group.business_address || ''} placeholder="사업장 주소" /></div>
      </div>
      <div className="section-title">🧾 세금계산서/정산 정보</div>
      <div className="row">
        <div className="field"><label>세금계산서 발행일</label><input type="number" name="tax_invoice_issue_day" min="1" max="31" defaultValue={group.tax_invoice_issue_day || ''} placeholder="예: 1" /></div>
        <div className="field"><label>결재일</label><input type="number" name="payment_due_day" min="1" max="31" defaultValue={group.payment_due_day || ''} placeholder="예: 30" /></div>
        <div className="field">
          <label>결재방식</label>
          <select name="settlement_method" defaultValue={group.settlement_method || ''}>
            <option value="">선택 안 함</option>
            {SETTLEMENT_METHODS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      </div>
    </form>
  );
}
