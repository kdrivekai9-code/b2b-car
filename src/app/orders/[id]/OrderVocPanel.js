'use client';

import { useState } from 'react';

// VOC(사고/과태료/클레임) 접수 — 원래 OrderDetailAdminPanels.js 안에 있어서 admin/branch_manager
// 만 볼 수 있었는데, 실제로 사고를 겪는 쪽은 고객사라 고객사(client)도 자기 오더에 직접 접수할 수
// 있어야 한다(사용자 확정 사항). 그래서 별도 컴포넌트로 떼어내 page.js에서 역할 무관하게 렌더링한다.
// 서버 권한은 routes/orders.js의 loadOrderForVoc가 scopeFilter로 "자기 지사/법인 오더인지"를
// 확인하므로, 다른 법인 오더 id를 URL에 넣어도 403이다.
// 기존 라우트(POST /:id/voc)를 그대로 쓰는 순수 <form> POST라 fetch 없이 동작한다.
export default function OrderVocPanel({ data, orderId }) {
  const { order } = data;
  const [vocAccident, setVocAccident] = useState(order.voc_accident_note != null);
  const [vocFine, setVocFine] = useState(order.voc_fine_note != null);
  const [vocClaim, setVocClaim] = useState(order.voc_claim_note != null);

  return (
    <div className="card">
      <h2>VOC 접수</h2>
      <p className="page-sub" style={{ margin: '0 0 10px' }}>
        사고 · 과태료 · 클레임을 접수하면 담당자가 확인합니다. 해당 항목을 선택한 뒤 내용을 입력해주세요.
      </p>
      <form method="POST" action={`/orders/${orderId}/voc`}>
        <div className="row"><div className="field full">
          <label><input type="checkbox" name="voc_accident" checked={vocAccident} onChange={(e) => setVocAccident(e.target.checked)} /> 사고 접수</label>
          {vocAccident && <textarea name="voc_accident_note" placeholder="사고 내용" defaultValue={order.voc_accident_note || ''} />}
        </div></div>
        <div className="row"><div className="field full">
          <label><input type="checkbox" name="voc_fine" checked={vocFine} onChange={(e) => setVocFine(e.target.checked)} /> 과태료 접수</label>
          {vocFine && <textarea name="voc_fine_note" placeholder="과태료 내용" defaultValue={order.voc_fine_note || ''} />}
        </div></div>
        <div className="row"><div className="field full">
          <label><input type="checkbox" name="voc_claim" checked={vocClaim} onChange={(e) => setVocClaim(e.target.checked)} /> 클레임 접수</label>
          {vocClaim && <textarea name="voc_claim_note" placeholder="클레임 내용" defaultValue={order.voc_claim_note || ''} />}
        </div></div>
        <button className="btn" type="submit">저장</button>
      </form>
    </div>
  );
}
