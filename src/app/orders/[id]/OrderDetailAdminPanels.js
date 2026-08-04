'use client';

import { useState } from 'react';

// admin/branch_manager 전용 관리자 패널(상태변경/관리자메모/담당자/VOC) — views/orders/detail.ejs의
// 해당 카드를 그대로 이식. 기사배정·오더수정이력은 OrderForm.js의 03번 자리
// (OrderSidePanel.js)로 옮겼고(경로 미리보기를 대체), 사진은 역할 무관 공통 정보라
// page.js에서 직접 렌더링한다 — 둘 다 여기서 중복으로 보여주지 않는다. 상태변경도
// 기사배정·수정이력 바로 아래에서 처리하는 게 자연스러워 OrderSidePanel.js로 옮겼다.
// 아래 폼들은 기존 라우트를 그대로 재사용하는 순수 HTML <form> POST라 fetch 없이도
// 동작한다 — 제출하면 브라우저가 리다이렉트를 따라가고, 그 요청이 다시 이
// 페이지(같은 NEXT_ORDER_DETAIL_EDIT_ENABLED 플래그 경로)로 돌아온다. 관리자 메모는
// 이번에 새로 추가한 POST /:id/admin-memo를 쓴다(기존 POST /:id/fare는 legacy 화면
// 전용으로 완전히 그대로 남겨둠 — 계획 문서 참고).
export default function OrderDetailAdminPanels({ data, orderId }) {
  const { order } = data;
  const [vocAccident, setVocAccident] = useState(order.voc_accident_note != null);
  const [vocFine, setVocFine] = useState(order.voc_fine_note != null);
  const [vocClaim, setVocClaim] = useState(order.voc_claim_note != null);

  return (
    <>
      <div className="card">
        <h2>담당자</h2>
        {order.status === '오더등록' ? (
          <form method="POST" action={`/orders/${orderId}/assign-self`}>
            <button className="btn" type="submit">내가 담당하기</button>
          </form>
        ) : (
          <div className="kv"><span className="k">담당자</span><span>{order.assigned_agent_name || '미지정'}</span></div>
        )}
      </div>

      <div className="card">
        <h2>VOC 접수</h2>
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

      <div className="card">
        <h2>관리자 메모</h2>
        <form method="POST" action={`/orders/${orderId}/admin-memo`}>
          <div className="row"><div className="field full"><label>관리자 메모(내부용)</label><textarea name="memo_admin" defaultValue={order.memo_admin || ''} /></div></div>
          <button className="btn" type="submit">저장</button>
        </form>
      </div>
    </>
  );
}
