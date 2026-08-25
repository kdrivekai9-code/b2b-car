'use client';

import { useState } from 'react';

// 기타 정산 내역(주유비 · 주차요금 · 톨게이트) — views/orders/detail.ejs의 같은 카드를 이식.
//
// 고객(client)에게는 렌더링하지 않는다. 운행요금과 별도로 거래처에 청구할 금액이라, 고객이
// 자기 오더의 청구액을 바꿀 수 있으면 정산이 성립하지 않는다. 서버도 같은 기준으로 막는다
// (routes/orders.js POST /:id/extra-charges).
//
// 다른 관리자 패널과 마찬가지로 기존 라우트를 그대로 쓰는 순수 <form> POST다 — fetch가 없어
// 저장 후 브라우저가 리다이렉트를 따라 이 페이지로 돌아온다.
let nextRowKey = 0;

export default function OrderExtraChargesPanel({ data, orderId }) {
  const { order } = data;
  const types = data.extraChargeTypes || [];
  const defaultDate = order.reserved_date || '';

  const [rows, setRows] = useState(() => (data.extraCharges || []).map((c) => ({
    key: `saved-${c.id}`,
    date: c.charged_on || defaultDate,
    type: c.charge_type,
    amount: c.amount,
    billable: !!c.billable,
    note: c.note || '',
  })));

  const addRow = () => setRows((prev) => prev.concat({
    key: `new-${nextRowKey++}`,
    date: defaultDate,
    type: types[0] || '',
    amount: 0,
    billable: true,
    note: '',
  }));
  const removeRow = (key) => setRows((prev) => prev.filter((r) => r.key !== key));
  const patch = (key, next) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...next } : r)));

  return (
    <div className="card">
      <h2>기타 정산 내역</h2>
      <p className="page-sub" style={{ margin: '0 0 10px' }}>
        주유비 · 주차요금 · 톨게이트비를 넣으면 <b>법인 정산내역</b>에 이 오더가 완료된 달로 잡힙니다.
        {' '}<b>별도 청구</b>를 끄면 기록만 남고 정산서에는 올라가지 않습니다.
      </p>
      <form method="POST" action={`/orders/${orderId}/extra-charges`}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 140 }}>일자</th><th style={{ width: 110 }}>항목</th>
                <th style={{ width: 110 }}>금액</th><th style={{ width: 80 }}>별도청구</th>
                <th>비고</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.key}>
                  <td><input type="date" name="extra_charge_date" value={r.date || ''} onChange={(e) => patch(r.key, { date: e.target.value })} /></td>
                  <td>
                    <select name="extra_charge_type" value={r.type} onChange={(e) => patch(r.key, { type: e.target.value })}>
                      {types.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </td>
                  <td><input type="number" name="extra_charge_amount" min="0" step="100" value={r.amount} onChange={(e) => patch(r.key, { amount: e.target.value })} /></td>
                  {/* 체크박스는 체크된 것만 전송되므로 값에 행 번호를 실어 어느 줄인지 가린다.
                      행을 지우면 번호가 밀리는데, value를 인덱스로 그때그때 계산해서 어긋나지 않는다. */}
                  <td style={{ textAlign: 'center' }}>
                    <input type="checkbox" name="extra_charge_billable" value={i} checked={r.billable} onChange={(e) => patch(r.key, { billable: e.target.checked })} />
                  </td>
                  <td><input type="text" name="extra_charge_note" placeholder="예: 서해대교 통행료" value={r.note} onChange={(e) => patch(r.key, { note: e.target.value })} /></td>
                  <td><button type="button" className="btn small secondary" onClick={() => removeRow(r.key)}>삭제</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
          <button type="button" className="btn small secondary" onClick={addRow}>+ 항목 추가</button>
          <button className="btn" type="submit">저장</button>
        </div>
      </form>
    </div>
  );
}
