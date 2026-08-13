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
      <div className="section-title">🧭 AI 접수 경로/요금 안내</div>
      <div className="field full">
        <label className="checkline">
          {/* 체크 해제 시 브라우저가 이 필드를 아예 안 보낸다 — 숨은 필드로 항상 '0'을 먼저
              보내 "안 보냄"과 "끔"을 구분한다(routes/groups.js가 배열/단일값 모두 처리). */}
          <input type="hidden" name="route_search_enabled" value="0" />
          <input type="checkbox" name="route_search_enabled" value="1" defaultChecked={group.route_search_enabled !== false} />
          경로탐색 결과(거리·소요시간·통행료)를 안내한다
        </label>
        <label className="checkline">
          <input type="hidden" name="fare_search_enabled" value="0" />
          <input type="checkbox" name="fare_search_enabled" value="1" defaultChecked={group.fare_search_enabled !== false} />
          요금검색 결과(구간요금)를 안내한다
        </label>
        <p className="page-sub">
          AI 접수(웹 챗봇·카카오톡 상담)에서 자동으로 붙는 안내입니다. 둘 다 끄면 계산 자체를
          건너뛰어 접수 확인이 더 빠르게 끝납니다. 요금은 경로 거리로 계산하므로,
          &quot;경로탐색 끔 + 요금검색 켬&quot;은 경로 안내만 감추고 계산은 그대로 합니다.
          고객이 직접 요금을 물어본 경우는 이 설정과 무관하게 답변합니다.
        </p>
      </div>
    </form>
  );
}
