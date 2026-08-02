'use client';

import { useState } from 'react';

export default function FerryFaresClient({ initialRules }) {
  const [rows, setRows] = useState(
    initialRules.length > 0
      ? initialRules.map((r) => ({ ...r }))
      : [{ route_code: '', ship_name: '', vehicle_label: '', weekday_fare: 0, holiday_fare: 0, sort_order: 1, is_active: 1, source_title: '', source_url: '' }]
  );

  function addRow() {
    setRows((prev) => [
      ...prev,
      { route_code: '', ship_name: '', vehicle_label: '', weekday_fare: 0, holiday_fare: 0, sort_order: prev.length + 1, is_active: 1, source_title: '', source_url: '' },
    ]);
  }

  function removeRow(idx) {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateRow(idx, key, value) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [key]: value } : r)));
  }

  return (
    <form method="POST" action="/ferry-fares" id="ferryFareForm">
      <div className="card">
        <div className="section-title">🚢 노선별 차량 선적비용</div>
        <div className="table-wrap" style={{ overflowX: 'auto' }}>
          <table id="ferryFareTable">
            <thead>
              <tr>
                <th style={{ minWidth: 100 }}>노선코드</th>
                <th style={{ minWidth: 100 }}>선박명</th>
                <th style={{ minWidth: 160 }}>차종(별칭, 쉼표 구분)</th>
                <th style={{ minWidth: 100 }}>평일요금(원)</th>
                <th style={{ minWidth: 100 }}>휴일요금(원)</th>
                <th style={{ minWidth: 70 }}>정렬순서</th>
                <th style={{ minWidth: 50 }}>사용</th>
                <th style={{ minWidth: 140 }}>출처명</th>
                <th style={{ minWidth: 140 }}>출처URL</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td><input className="input" type="text" name="route_code" value={r.route_code} onChange={(e) => updateRow(i, 'route_code', e.target.value)} required /></td>
                  <td><input className="input" type="text" name="ship_name" value={r.ship_name || ''} onChange={(e) => updateRow(i, 'ship_name', e.target.value)} /></td>
                  <td><textarea className="input" name="vehicle_label" rows={2} value={r.vehicle_label} onChange={(e) => updateRow(i, 'vehicle_label', e.target.value)} required /></td>
                  <td><input className="input" type="number" name="weekday_fare" value={r.weekday_fare} min={0} step={100} onChange={(e) => updateRow(i, 'weekday_fare', e.target.value)} /></td>
                  <td><input className="input" type="number" name="holiday_fare" value={r.holiday_fare} min={0} step={100} onChange={(e) => updateRow(i, 'holiday_fare', e.target.value)} /></td>
                  <td><input className="input" type="number" name="sort_order" value={r.sort_order ?? i + 1} min={1} step={1} onChange={(e) => updateRow(i, 'sort_order', e.target.value)} /></td>
                  <td style={{ textAlign: 'center' }}>
                    <input type="checkbox" name="is_active" value={i} checked={!!r.is_active} onChange={(e) => updateRow(i, 'is_active', e.target.checked ? 1 : 0)} />
                  </td>
                  <td><input className="input" type="text" name="source_title" value={r.source_title || ''} onChange={(e) => updateRow(i, 'source_title', e.target.value)} /></td>
                  <td><input className="input" type="url" name="source_url" value={r.source_url || ''} onChange={(e) => updateRow(i, 'source_url', e.target.value)} /></td>
                  <td>
                    <button type="button" className="btn small secondary" onClick={() => removeRow(i)}>삭제</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
          <button type="button" className="btn secondary" onClick={addRow}>+ 행 추가</button>
          <button type="submit" className="btn">저장</button>
        </div>
      </div>
    </form>
  );
}
