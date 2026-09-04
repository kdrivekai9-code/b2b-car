'use client';

// 요청사항 본문에서 찾아낸 부대비용 후보 — 관리자가 '접수'로 확정하기 전에 고르는 자리.
//
// 왜 이 화면이 필요한가: 법인 고객에게는 접수 화면의 부대비용 입력이 보이지 않는다(청구 금액
// 설정이라 요금 칸과 같은 규칙으로 가린다). 그래서 고객이 "주유 가득 채워주세요"를 전할 수
// 있는 곳은 요청사항 본문뿐이고, 그 본문을 아무도 읽지 않으면 기사에게 지시가 안 닿고
// (차가 빈 채로 도착한다) 실비를 썼어도 청구할 줄이 없다.
//
// 자동으로 줄을 만들지 않는 이유는 lib/memoExtraCosts.js에 적어뒀다 — 잘못 읽으면 없는 돈이
// 청구되고, 그 손해가 놓치는 손해보다 크다. 탁송 오더는 고객이 접수해도 콜마너에 대기로
// 들어가고 관리자가 확인해야 '접수'가 되므로, 그 확인이 자연스러운 판단 지점이다.
//
// 다른 관리자 패널과 같이 기존 라우트를 쓰는 순수 <form> POST다 — 저장하면 브라우저가
// 리다이렉트를 따라 이 페이지로 돌아온다.
import { useState } from 'react';

function won(n) {
  return Number(n || 0).toLocaleString('ko-KR') + '원';
}

function modeLabel(c) {
  if (!c.billable) return '요금 포함 · 청구 없음';
  return c.settleMode === 'individual' ? '실비 개별정산' : '실비 월정산';
}

export default function MemoExtraCandidates({ data, orderId }) {
  const candidates = data.memoExtraCandidates || [];
  // 청구 대상만 기본 선택. '포함' 항목은 줄을 만들 수 없으니 체크 자체를 두지 않는다.
  const [checked, setChecked] = useState(() => {
    const init = {};
    candidates.forEach((c) => { if (c.billable) init[c.code] = true; });
    return init;
  });

  // 후보가 없으면 아무것도 안 그린다. 다시 돌리는 버튼은 요청 메모 칸 옆에 있다
  // (src/app/orders/new/MemoReanalyzeButton.js) — 분석 대상이 그 글이라 읽고 있는 자리에
  // 있어야 하고, 여기 페이지 맨 아래에 두었더니 아무도 못 봤다.
  if (!candidates.length) return null;

  const billable = candidates.filter((c) => c.billable);
  const included = candidates.filter((c) => !c.billable);

  return (
    <div className="card" style={{ borderColor: '#c7a008' }}>
      <h2>요청사항에서 찾은 부대비용 <span style={{ fontSize: 12, fontWeight: 400, color: '#8a6d00' }}>확인 필요</span></h2>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: '#555' }}>
        고객 요청사항 본문에 적혀 있는데 부대비용 항목으로는 선택되지 않은 것들입니다.
        <strong> 기사에게 전달되기 전에</strong> 확인해 주세요.
      </p>

      <form method="POST" action={`/orders/${orderId}/memo-extra`}>
        {billable.map((c) => (
          <label key={c.code} style={{
            display: 'block', padding: '10px 12px', marginBottom: 8,
            border: '1px solid #e2e2e2', borderRadius: 6, cursor: 'pointer',
          }}>
            <input
              type="checkbox"
              name="accept_code"
              value={c.code}
              checked={!!checked[c.code]}
              onChange={(e) => setChecked((p) => ({ ...p, [c.code]: e.target.checked }))}
              style={{ marginRight: 8 }}
            />
            <strong>{c.label}</strong>
            {Number(c.amount) > 0 ? ` ${won(c.amount)}` : ' (금액 미정 — 영수증으로 확정)'}
            <span style={{ marginLeft: 8, fontSize: 12, color: '#8a6d00' }}>{modeLabel(c)}</span>
            {/* 근거를 보여줘야 "왜 이게 잡혔나"를 판단할 수 있다. 요약이 아니라 원문 조각이다. */}
            <div style={{ marginTop: 4, fontSize: 12, color: '#666' }}>
              요청사항: “{c.evidence}”
            </div>
          </label>
        ))}

        {included.length > 0 && (
          // 청구는 안 하지만 기사에게는 알려야 한다 — 지시가 안 닿으면 차가 빈 채로 간다.
          <div style={{
            padding: '10px 12px', marginBottom: 8, borderRadius: 6,
            background: '#f4f4f4', fontSize: 13, color: '#555',
          }}>
            <strong>요금에 포함된 항목</strong> — 청구하지 않지만 기사에게는 전달됩니다.
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {included.map((c) => (
                <li key={c.code}>{c.label} — 요청사항: “{c.evidence}”</li>
              ))}
            </ul>
          </div>
        )}

        <button className="btn" type="submit">
          {billable.length ? '선택한 항목 추가' : '확인'}
        </button>
        <span style={{ marginLeft: 10, fontSize: 12, color: '#888' }}>
          체크를 모두 해제하고 눌러도 됩니다 — 그러면 청구하지 않은 것으로 기록됩니다.
        </span>
      </form>
    </div>
  );
}
