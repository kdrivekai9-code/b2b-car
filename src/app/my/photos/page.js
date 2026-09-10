// 사진 전송리스트(고객용) — views/photo_delivery/list.ejs의 Next 판.
//
// 권한 판정(법인 없음 차단·개인 딜러 범위)은 전부 Express가 한다(GET /my/photos/data.json).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../_components/AppShell';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

const won = (n) => (Number(n) || 0).toLocaleString('ko-KR') + '원';

export default async function MyPhotosPage() {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/my/photos/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (res.status === 403) {
    return (
      <AppShell currentUser={null} activePath="/my/photos">
        <div className="card"><p className="page-sub" style={{ margin: 0 }}>접근 권한이 없습니다.</p></div>
      </AppShell>
    );
  }
  if (!res.ok) throw new Error('사진 전송리스트를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, rows, meIsDealer } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/my/photos">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">사진 전송리스트</h1>
          <p className="page-sub">
            탁송사진이 등록된 오더입니다. 사진보기를 누르면 운행 전·운행 완료 후 사진과 실비 영수증을 함께 볼 수 있습니다.
            {meIsDealer ? '본인이 접수한 건만 보입니다.' : ''}
          </p>
        </div>
      </div>

      <div className="card">
        {!rows.length ? (
          <p className="page-sub" style={{ margin: 0 }}>
            아직 사진이 등록된 오더가 없습니다. 기사가 촬영을 마치면 여기에 나타납니다.
          </p>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 120 }}>접수번호</th>
                    <th style={{ width: 140 }}>예약일시</th>
                    <th style={{ width: 130 }}>차량번호</th>
                    <th style={{ width: 90 }}>상태</th>
                    <th style={{ width: 110 }}>사진보기</th>
                    <th style={{ width: 130 }}>사진다운로드</th>
                    <th style={{ width: 110 }} className="num">운행요금</th>
                    <th style={{ width: 110 }} className="num">부대비용</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.oid || '-'}</td>
                      <td>{r.reservedDate || '-'}{r.reservedTime ? ` ${r.reservedTime}` : ''}</td>
                      <td>
                        {r.vehicleNumber || '-'}
                        {r.vehicleType && (
                          <div className="page-sub" style={{ margin: 0, fontSize: 11.5 }}>{r.vehicleType}</div>
                        )}
                      </td>
                      <td>{r.status}</td>
                      {/* 열람이 막힌 지사는 링크 대신 이유를 보여준다 — 눌러도 안 되는 링크를
                          두면 고객이 몇 번을 누르다 결국 전화한다. */}
                      {r.canViewPhotos ? (
                        <>
                          <td><a className="btn small secondary" href={`/my/photos/${r.id}`}>사진보기 ({r.photoCount})</a></td>
                          <td><a className="btn small secondary" href={`/my/photos/${r.id}/download.zip`}>전체 다운로드</a></td>
                        </>
                      ) : (
                        <td colSpan={2}>
                          <span className="page-sub" style={{ margin: 0 }}>사진 공개가 설정되지 않았습니다. 상담원에게 문의해 주세요.</span>
                        </td>
                      )}
                      <td className="num">{won(r.tripFare)}</td>
                      <td className="num">
                        {r.extraCount ? (
                          <>
                            {won(r.extraAmount)}
                            <div className="page-sub" style={{ margin: 0, fontSize: 11.5 }}>{r.extraCount}건</div>
                          </>
                        ) : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="page-sub" style={{ margin: '10px 0 0' }}>
              부대비용은 청구 대상 실비만 더한 금액입니다 — 기본요금에 포함된 항목은 여기 들어가지 않습니다.
            </p>
          </>
        )}
      </div>
    </AppShell>
  );
}
