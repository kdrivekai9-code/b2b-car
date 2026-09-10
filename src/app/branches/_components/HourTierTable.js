'use client';

import { useState } from 'react';

// 시간 구간 요금표(일일기사) — 거리 표와 열이 다르다.
//
// 두 표를 하나로 합치지 않는다: 청구 기준이 다르고(거리 vs 이용 시간) 열 이름도 서버가
// 다르게 받는다. 합쳐두면 한쪽 열을 고칠 때 다른 상품의 청구가 함께 흔들린다.
let seq = 0;
const blankRow = () => ({ __key: `new-${++seq}`, base_hours: 0, fare_amount: 0, extra_per_hour: 0, note: '' });

export default function HourTierTable({ tiers }) {
  const initial = (tiers || []).length
    ? tiers.map((t, i) => ({ ...t, __key: t.id != null ? `t${t.id}` : `i${i}` }))
    // 표가 비어 있어도 한 줄은 보여준다 — 빈 표만 보이면 어디에 넣는지 알 수 없다(EJS와 같다).
    : [blankRow()];
  const [rows, setRows] = useState(initial);

  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>구간</th><th>기준시간(h)</th><th>기본요금(원)</th>
              <th>시간당 추가요금(원)</th><th>비고</th><th></th>
            </tr>
          </thead>
          <tbody id="premiumFareTiersBody">
            {rows.map((row, i) => (
              <tr key={row.__key}>
                <td className="tier-label">구간 {i + 1}</td>
                <td><input type="number" name="base_hours" defaultValue={row.base_hours ?? 0} min={0} step={0.5} required /></td>
                <td><input type="number" name="fare_amount" defaultValue={row.fare_amount ?? 0} min={0} step={1000} /></td>
                <td><input type="number" name="extra_per_hour" defaultValue={row.extra_per_hour ?? 0} min={0} step={1000} placeholder="0이면 정액" /></td>
                <td><input type="text" name="note" defaultValue={row.note || ''} placeholder="예: 4시간 이내" /></td>
                <td>
                  <button type="button" className="btn small secondary"
                    onClick={() => setRows(rows.filter((r) => r.__key !== row.__key))}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="btn small secondary" style={{ marginTop: 10 }}
        onClick={() => setRows([...rows, blankRow()])}>+ 구간 추가</button>
    </>
  );
}
