import { headers } from 'next/headers';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function PhotoUploadPage({ params }) {
  const { token } = await params;
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  let data = { order: null, guide: null, photos: [] };
  try {
    const res = await fetch(`${proto}://${host}/upload/${encodeURIComponent(token)}/data.json`, {
      headers: { 'X-Requested-With': 'fetch' },
      cache: 'no-store',
    });
    if (res.ok) data = await res.json();
  } catch {}

  const { order, guide, photos } = data;

  return (
    <div className="upload-wrap">
      <div className="upload-card">
        <h1>🚚 기사 사진 업로드</h1>
        {!order ? (
          <p className="error-msg">잘못된 링크이거나 만료된 오더입니다.</p>
        ) : (
          <>
            <p className="upload-order-oid">오더번호 <b>{order.oid}</b></p>

            {guide?.guide_image_url && (
              <img src={guide.guide_image_url} alt="안내 이미지" className="upload-guide-image" />
            )}
            <div className="upload-guide-text">
              {guide?.guide_text || '차량 인도/회수 시점의 사진을 촬영하여 업로드해주세요.'}
            </div>

            <form method="POST" action={'/upload/' + order.photo_upload_token} encType="multipart/form-data" className="upload-form">
              <input type="file" name="photo" accept="image/*" capture="environment" required />
              <button className="btn" type="submit">사진 업로드</button>
            </form>

            {photos.length > 0 && (
              <div className="upload-gallery">
                {photos.map((p) => (
                  <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
                    <img src={p.url} alt="업로드된 사진" />
                  </a>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
