'use client';

import { useState } from 'react';

// 거리 구간 요금표 — 행을 더하고 지운다.
//
// 같은 표를 세 화면이 쓴다(탁송 요금·프리미엄 편도 요금·배차 요금). EJS는 이걸
// public/js/fare-rules.js 하나로 처리하면서 화면마다 다른 칸(대표요금제·비고)을
// data-* 로 알렸다 — 그 방식이 실제로 한 번 깨졌다(추가한 행의 칸 수가 헤더와 어긋나면
// 값이 한 칸씩 밀려 **다른 열로 저장된다**). 여기서는 열 정의를 배열 하나로 두고 헤더와
// 본문을 같은 배열에서 만들어, 어긋날 자리를 없앤다.
//
// 저장은 순수 form POST다(프록시가 비-GET을 Express로 보낸다). 그래서 이 컴포넌트는
// <input name=...>만 그리고, 서버는 지금까지와 똑같이 이름별 배열로 받는다.
const COLUMNS = [
  { name: 'base_distance_km', label: '기준거리(km)', type: 'number', min: 0, step: 0.1 },
  { name: 'base_fare', label: '기본요금(원)', type: 'number', min: 0, step: 1000 },
  { name: 'surcharge_unit_km', label: '할증단위(km)', type: 'number', min: 0.1, step: 0.1, fallback: 1 },
  { name: 'surcharge_fare', label: '할증요금(원)', type: 'number', min: 0, step: 100 },
  { name: 'max_distance_km', label: '최대거리(km)', type: 'number', min: 0, step: 0.1, blankable: true },
  { name: 'max_fare', label: '최대요금(원)', type: 'number', min: 0, step: 1000, blankable: true },
  { name: 'round_unit', label: '반올림단위', type: 'number', min: 1, step: 1, fallback: 1000 },
  { name: 'round_method', label: '반올림방식', type: 'select' },
];

const ROUND_METHODS = [['up', '올림'], ['round', '반올림'], ['down', '내림']];

let seq = 0;
const blankRow = () => ({ __key: `new-${++seq}`, round_unit: 1000, round_method: 'round', surcharge_unit_km: 1 });

export default function DistanceTierTable({ tiers, withNote, withRepresentative, branchId }) {
  const [rows, setRows] = useState(
    (tiers || []).map((t, i) => ({ ...t, __key: t.id != null ? `t${t.id}` : `i${i}` }))
  );

  const val = (row, c) => {
    const v = row[c.name];
    if (v === null || v === undefined || v === '') return c.blankable ? '' : (c.fallback != null ? c.fallback : 0);
    return v;
  };

  return (
    <>
      <div className="table-wrap">
        <table id="fareTiersTable">
          <thead>
            <tr>
              <th>구간</th>
              {COLUMNS.map((c) => <th key={c.name}>{c.label}</th>)}
              {withRepresentative ? <th>대표요금제</th> : null}
              {withNote ? <th>비고</th> : null}
              <th></th>
            </tr>
          </thead>
          <tbody id="fareTiersBody">
            {rows.map((row, i) => (
              <tr key={row.__key}>
                {/* 번호는 화면에서 다시 매긴다 — 행을 지우면 서버가 저장할 tier_seq도
                    남은 순서대로 다시 붙기 때문에(라우트가 i+1로 넣는다) 같아야 한다. */}
                <td className="tier-label">구간요금{i + 1}</td>
                {COLUMNS.map((c) => (
                  <td key={c.name}>
                    {c.type === 'select' ? (
                      <select name={c.name} defaultValue={row.round_method || 'round'}>
                        {ROUND_METHODS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                      </select>
                    ) : (
                      <input type="number" name={c.name} defaultValue={val(row, c)} min={c.min} step={c.step} />
                    )}
                  </td>
                ))}
                {withRepresentative ? (
                  <td style={{ textAlign: 'center' }}>
                    {/* 대표요금제는 저장과 별개로 즉시 반영되는 값이라(라우트가 따로 있다)
                        새 행에는 id가 없어 아직 켤 수 없다 — EJS도 같은 안내를 한다. */}
                    <RepresentativeToggle branchId={branchId} tierId={row.id} index={i} checked={!!row.is_representative} />
                  </td>
                ) : null}
                {withNote ? (
                  <td><input type="text" name="note" defaultValue={row.note || ''} /></td>
                ) : null}
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

// 대표요금제 체크 — 저장 버튼과 무관하게 그 자리에서 반영한다(EJS와 같은 동작).
function RepresentativeToggle({ branchId, tierId, index, checked }) {
  const [on, setOn] = useState(checked);
  const [msg, setMsg] = useState('');
  return (
    <>
      <input type="checkbox" name="tier_representative" value={index} checked={on}
        onChange={async (e) => {
          const next = e.target.checked;
          if (!tierId) { setMsg('저장 후 적용됩니다.'); return; }
          setOn(next);
          try {
            const res = await fetch(`/branches/${branchId}/fare-rules/${tierId}/representative`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
              body: JSON.stringify({ checked: next }),
            });
            const data = await res.json().catch(() => ({}));
            if (data && data.error) throw new Error(data.error);
            setMsg(next ? '대표요금제로 적용되었습니다.' : '적용이 해제되었습니다.');
          } catch {
            setOn(!next);
            setMsg('적용 중 오류가 발생했습니다.');
          }
        }} />
      {msg ? <div className="page-sub" style={{ fontSize: 11 }}>{msg}</div> : null}
    </>
  );
}
