'use client';

// 요청사항 다시 분석 — 요청 메모 칸 옆 버튼과 그 결과 팝업.
//
// 왜 여기 있나: 결과 카드를 페이지 맨 아래 두었더니 아무도 못 봤다. 분석 대상이 바로 위
// 요청사항이라, 그 글을 읽고 있는 자리에서 누를 수 있어야 한다.
//
// 왜 팝업인가: 눌러서 결과를 보고 바로 채택까지 하는 한 흐름이다. 페이지를 새로 그리면
// 관리자가 어디를 봐야 하는지 다시 찾아야 하고, 수정 중이던 다른 칸이 날아간다.
//
// 접수 시점 분석과 무엇이 다른가: 없다. 같은 판정을 다시 돌릴 뿐이다. 필요한 이유는 그
// 판정이 접수 시점에만 돌기 때문이다 — 기능이 생기기 전에 만들어진 오더나 요청사항을
// 나중에 고친 오더는 다시 돌릴 길이 없으면 영영 빈 채로 남는다.
import { useState } from 'react';

export default function MemoReanalyzeButton({ orderId, disabled }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState({});

  async function run() {
    setBusy(true); setError(''); setResult(null); setOpen(true);
    try {
      const res = await fetch(`/orders/${orderId}/reanalyze-memo`, {
        method: 'POST', headers: { 'X-Requested-With': 'fetch' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '분석하지 못했습니다.');
      setResult(data);
      // 청구 대상만 기본 선택 — '포함' 항목은 줄을 만들 수 없다.
      const init = {};
      (data.candidates || []).forEach((c) => { if (c.billable) init[c.code] = true; });
      setChecked(init);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function accept() {
    setBusy(true); setError('');
    try {
      const body = new URLSearchParams();
      Object.entries(checked).forEach(([code, on]) => { if (on) body.append('accept_code', code); });
      const res = await fetch(`/orders/${orderId}/memo-extra`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch' },
        body: body.toString(),
      });
      if (!res.ok) throw new Error('저장하지 못했습니다.');
      // 부대비용 줄이 생겼으니 화면을 새로 읽는다 — 여기서만 갱신하면 아래 정산 카드가 옛 값이다.
      window.location.reload();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  const billable = (result && result.candidates || []).filter((c) => c.billable);
  const included = (result && result.candidates || []).filter((c) => !c.billable);

  return (
    <>
      <button type="button" className="btn small secondary" onClick={run} disabled={disabled || busy}
        title="요청사항을 다시 읽어 부대비용·등기우편 요청을 찾습니다">
        {busy && !open ? '분석 중…' : '요청사항 다시 분석'}
      </button>

      {open && (
        <div className="map-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) setOpen(false); }}>
          <div className="map-modal-box memo-reanalyze-box">
            <div className="map-modal-header">
              <h3>요청사항에서 찾은 내용</h3>
              <button type="button" className="btn small secondary" onClick={() => setOpen(false)} disabled={busy}>닫기</button>
            </div>
            <div className="map-modal-body memo-reanalyze-body">
              {busy && !result && <p>요청사항을 읽는 중입니다…</p>}
              {error && <div className="error-msg">{error}</div>}

              {result && (
                <>
                  {result.postal && (
                    <p className="memo-reanalyze-postal">
                      📮 <b>등기우편 요청</b>으로 확인되어 인수증 업로드 링크를 만들었습니다.
                    </p>
                  )}

                  {!billable.length && !included.length && (
                    <p>요청사항에서 부대비용으로 볼 만한 내용을 찾지 못했습니다.</p>
                  )}

                  {billable.map((c) => (
                    <label key={c.code} className="memo-reanalyze-item">
                      <input type="checkbox" checked={!!checked[c.code]}
                        onChange={(e) => setChecked((p) => ({ ...p, [c.code]: e.target.checked }))} />
                      <span>
                        <b>{c.label}</b>
                        {c.amount > 0 ? ` ${Number(c.amount).toLocaleString('ko-KR')}원` : ' (금액 미정 — 영수증으로 확정)'}
                        {/* 근거를 보여줘야 "왜 이게 잡혔나"를 판단할 수 있다. 원문 조각이다. */}
                        <em>요청사항: “{c.evidence}”</em>
                      </span>
                    </label>
                  ))}

                  {included.length > 0 && (
                    // 청구는 안 하지만 기사에게는 알려야 한다 — 지시가 안 닿으면 차가 빈 채로 간다.
                    <div className="memo-reanalyze-included">
                      <b>요금에 포함된 항목</b> — 청구하지 않지만 기사에게는 전달됩니다.
                      <ul>{included.map((c) => <li key={c.code}>{c.label} — “{c.evidence}”</li>)}</ul>
                    </div>
                  )}
                </>
              )}
            </div>
            {result && (
              <div className="memo-reanalyze-actions">
                <button type="button" className="btn" onClick={accept} disabled={busy}>
                  {billable.length ? '선택한 항목 추가' : '확인'}
                </button>
                <span className="hint">
                  체크를 모두 해제하고 눌러도 됩니다 — 그러면 청구하지 않은 것으로 기록됩니다.
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
