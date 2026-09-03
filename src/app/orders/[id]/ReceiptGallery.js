'use client';

// 실비 영수증 — 어떤 항목의 얼마짜리 근거인지와 사진을 함께 놓는다.
//
// 금액만 있고 사진이 어디 있는지 모르면 청구를 다투는 자리에서 아무것도 못 한다. 반대로
// 사진만 모아두면 어느 항목 것인지 알 수 없다. 둘을 붙여야 근거가 된다.
//
// 사진은 기사가 채팅으로 올린다(order_extra_charges.chat_message_id). 아직 안 올라온 줄도
// 남긴다 — 빠진 것이 보여야 받아야 할 영수증을 알 수 있다.
//
// 고객(client)에게는 이 카드를 그리지 않는다. 청구 금액이라 오더상세의 다른 금액 칸과 같은
// 규칙을 따른다(서버도 같은 기준으로 내려주지 않는다).

const MODE_LABEL = {
  included: '요금 포함',
  monthly: '월정산',
  individual: '개별정산',
};

function won(n) {
  return Number(n || 0).toLocaleString('ko-KR') + '원';
}

export default function ReceiptGallery({ charges }) {
  const rows = Array.isArray(charges) ? charges : [];
  if (!rows.length) return null;

  const waiting = rows.filter((r) => !(r.receipt && r.receipt.files && r.receipt.files.length)).length;

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <h2>🧾 실비 영수증</h2>
      <p className="page-sub" style={{ margin: '4px 0 12px' }}>
        실비 {rows.length}건
        {waiting > 0 && <> · <strong>영수증 없음 {waiting}건</strong></>}
      </p>

      <div className="receipt-list">
        {rows.map((r) => {
          const files = (r.receipt && Array.isArray(r.receipt.files) ? r.receipt.files : [])
            // 문자열 URL로 오는 경우와 {url:…} 객체로 오는 경우를 둘 다 받는다.
            .map((f) => (typeof f === 'string' ? { url: f } : f))
            .filter((f) => f && f.url);
          return (
            <div className="receipt-row" key={r.id}>
              <div className="receipt-head">
                <strong>{r.charge_type}</strong>
                <span className="receipt-amount">{won(r.amount)}</span>
                <span className="receipt-mode">{MODE_LABEL[r.settle_mode] || r.settle_mode || ''}</span>
                {!r.billable && <span className="receipt-mode">청구 안 함</span>}
                {r.charged_on && <span className="receipt-date">{r.charged_on}</span>}
              </div>
              {r.note && <div className="receipt-note">{r.note}</div>}
              {files.length ? (
                <div className="receipt-shots">
                  {files.map((f, i) => (
                    <a key={f.url} className="photo-cell" href={f.url} target="_blank" rel="noreferrer">
                      <img
                        src={f.url}
                        alt={`${r.charge_type} 영수증 ${i + 1}`}
                        loading="lazy"
                        onError={(e) => { e.currentTarget.style.display = 'none'; }}
                      />
                    </a>
                  ))}
                </div>
              ) : (
                <div className="receipt-missing">영수증이 아직 올라오지 않았습니다.</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
