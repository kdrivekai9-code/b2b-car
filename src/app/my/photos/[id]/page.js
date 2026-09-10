// 탁송 사진 상세(고객용) — views/photo_delivery/detail.ejs의 Next 판.
//
// 스타일은 EJS가 화면 안에 <style>로 갖고 있던 것을 그대로 옮겼다. 공용 CSS로 빼지 않는 이유는
// 이 화면에서만 쓰는 격자라서다 — 공용으로 옮기면 다른 화면이 모르는 사이에 영향을 받는다.
import { headers } from 'next/headers';
import { redirect, notFound } from 'next/navigation';
import AppShell from '../../../_components/AppShell';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

const STYLES = `
  .photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
  .photo-cell { display: block; text-decoration: none; color: inherit; }
  /* object-fit이 cover가 아니라 contain인 이유: 분쟁 증빙 사진이라 한 귀퉁이라도 잘리면 안 된다. */
  .photo-cell img { width: 100%; aspect-ratio: 4 / 3; object-fit: contain; border-radius: 8px;
                    border: 1px solid var(--border, #e5e7eb); background: rgba(127,127,127,.1); display: block; }
  .photo-cap { display: block; font-size: 11.5px; text-align: center; margin-top: 4px; color: var(--muted, #6b7280); line-height: 1.4; }
  .photo-cap.odo { color: #0f766e; font-weight: 700; }
  .receipt-row { padding: 12px 0; border-top: 1px solid var(--border, #e5e7eb); }
  .receipt-row:first-of-type { border-top: 0; padding-top: 0; }
  .receipt-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .receipt-amount { font-variant-numeric: tabular-nums; }
`;

export default async function MyPhotoDetailPage({ params }) {
  const { id } = await params;
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/my/photos/${encodeURIComponent(id)}/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (res.status === 404) notFound();
  if (res.status === 403) {
    return (
      <AppShell currentUser={null} activePath="/my/photos">
        <div className="card"><p className="page-sub" style={{ margin: 0 }}>접근 권한이 없습니다.</p></div>
      </AppShell>
    );
  }
  if (!res.ok) throw new Error('사진을 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, order, reason, phases, receipts } = await res.json();
  const blocked = reason === 'not_allowed';

  return (
    <AppShell currentUser={currentUser} activePath="/my/photos">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <div className="page-head-row">
        <div>
          <h1 className="page-title">탁송 사진</h1>
          <p className="page-sub">
            {order ? `접수번호 ${order.oid}${order.vehicle_number ? ` · ${order.vehicle_number}` : ''}` : ''}
          </p>
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/my/photos">목록</a>
          {order && !blocked && reason !== 'no_photos' && (
            <a className="btn" href={`/my/photos/${order.id}/download.zip`}>전체 다운로드</a>
          )}
        </div>
      </div>

      {blocked ? (
        <div className="card">
          <p className="page-sub" style={{ margin: 0 }}>이 오더의 사진은 공개되어 있지 않습니다. 담당 상담원에게 문의해 주세요.</p>
        </div>
      ) : (
        <>
          {order && (order.origin_address || order.destination_address) && (
            <div className="card">
              <p style={{ margin: 0, lineHeight: 1.7 }}>
                {order.origin_address || ''}
                {order.destination_address ? ` → ${order.destination_address}` : ''}
              </p>
            </div>
          )}

          {reason === 'no_photos' && (
            <div className="card"><p className="page-sub" style={{ margin: 0 }}>아직 등록된 사진이 없습니다.</p></div>
          )}

          {/* 운행 전 / 운행 완료 후를 따로 묶는다 — 같은 항목을 두 단계에서 비교해야 흠집이
              언제 생겼는지 알 수 있다. 항목 이름은 서버가 붙인다(lib/callmanerPhotos.js). */}
          {(phases || []).map((g) => (
            <div className="card" key={g.label}>
              <h2>{g.label} <span className="page-sub" style={{ fontWeight: 400, fontSize: 12 }}>({g.items.length}장)</span></h2>
              <div className="photo-grid">
                {g.items.map((p, i) => (
                  // 원본은 새 창에서 연다 — 목록 안 썸네일로는 흠집을 확인할 수 없다.
                  <a className="photo-cell" href={p.url} target="_blank" rel="noopener noreferrer" key={i}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.url} alt={`${g.label} ${p.label}`} loading="lazy" />
                    <span className={'photo-cap' + (p.isOdometer ? ' odo' : '')}>
                      {p.label}
                      {p.isOdometer && p.odometer_km ? (
                        <><br />{Number(p.odometer_km).toLocaleString('ko-KR')}km</>
                      ) : null}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          ))}

          {/* 실비정산 영수증 — 금액 줄과 그 근거 사진을 나란히 둔다. 사진이 아직 없는 줄도
              남긴다: 빠진 것이 보여야 "영수증을 안 올렸다"를 알 수 있다. */}
          {(receipts || []).length > 0 && (
            <div className="card">
              <h2>실비정산 영수증</h2>
              <p className="page-sub" style={{ margin: '0 0 10px' }}>운행요금과 별도로 청구되는 실비입니다.</p>
              {receipts.map((c, ci) => {
                const files = (c.receipt && c.receipt.files) || [];
                return (
                  <div className="receipt-row" key={ci}>
                    <div className="receipt-head">
                      <b>{c.charge_type}</b>
                      <span className="receipt-amount">
                        {Number(c.amount || 0) > 0 ? Number(c.amount).toLocaleString('ko-KR') + '원' : '금액 미정'}
                      </span>
                      {c.charged_on ? <span className="page-sub" style={{ margin: 0 }}>{c.charged_on}</span> : null}
                    </div>
                    {c.note ? <div className="page-sub" style={{ margin: '2px 0 0' }}>{c.note}</div> : null}
                    {files.length ? (
                      <div className="photo-grid" style={{ marginTop: 8 }}>
                        {files.map((f, fi) => {
                          const url = typeof f === 'string' ? f : (f && f.url);
                          if (!url) return null;
                          return (
                            <a className="photo-cell" href={url} target="_blank" rel="noopener noreferrer" key={fi}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={url} alt={`${c.charge_type} 영수증`} loading="lazy" />
                            </a>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="page-sub" style={{ margin: '6px 0 0' }}>영수증 사진이 아직 등록되지 않았습니다.</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
