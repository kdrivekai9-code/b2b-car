// 기사가 계기판 사진과 함께 적어둔 주행거리 요약.
//
// 사진을 열어 숫자를 읽지 않아도 되도록 여기 한 줄로 보여준다. 값이 하나뿐이면 뺄 상대가 없어서
// 그 값만 보여준다 — 0을 상대로 두면 주행거리가 계기판 숫자 전체가 되어버린다.
//
// 같은 계산이 세 곳에 있다: 여기, views/orders/detail.ejs, lib/kakaoOrderPhotos.js의
// summarizeOdometer(챗봇 응답). 세 곳 다 "최댓값 − 최솟값"이라는 같은 규칙을 쓴다.
export default function OdometerSummary({ photos }) {
  const values = (photos || [])
    .map((p) => Number(p && p.odometer_km))
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);

  if (!values.length) return null;

  const km = (n) => n.toLocaleString('ko-KR');
  const start = values[0];
  const end = values[values.length - 1];

  return (
    <p className="page-sub" style={{ margin: '8px 0 0' }}>
      계기판 {km(start)}km
      {values.length > 1 && <> → {km(end)}km (주행 {km(end - start)}km)</>}
    </p>
  );
}
