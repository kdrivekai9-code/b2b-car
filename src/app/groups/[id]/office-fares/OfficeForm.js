'use client';

import { useRef, useState } from 'react';

// 지점 등록 — 상호 + 주소(좌표까지).
//
// **좌표가 이 기능의 전부다.** 출발/도착이 그 지점인지 좌표로 판정하므로(lib/officeZoneFare.js),
// 좌표가 없으면 등록을 막는다. 주소칸을 읽기전용으로 두는 것도 같은 이유다 — 손으로 고치면
// 글자와 좌표가 다른 곳을 가리키게 되고, 그러면 지점이 영영 안 잡힌다.
export default function OfficeForm({ groupId }) {
  const [address, setAddress] = useState('');
  const [coords, setCoords] = useState(null); // { lat, lon }
  const [hint, setHint] = useState('주소를 검색하면 좌표가 확정됩니다.');
  const [candidates, setCandidates] = useState([]);
  const queryRef = useRef('');

  async function search() {
    const q = window.prompt('지점 상호명이나 주소를 입력하세요', queryRef.current || address || '');
    if (!q || !q.trim()) return;
    queryRef.current = q.trim();
    setCandidates([]);
    setHint('검색 중입니다...');
    try {
      const res = await fetch('/kakao/search?q=' + encodeURIComponent(q.trim()) + '&mode=plain');
      const data = res.ok ? await res.json() : { documents: [] };
      const docs = (data && data.documents) || [];
      if (!docs.length) { setHint('검색 결과가 없습니다. 다른 이름으로 시도해주세요.'); return; }
      setHint('아래에서 정확한 곳을 선택해주세요.');
      setCandidates(docs.slice(0, 8));
    } catch {
      setHint('주소 검색에 실패했습니다. 잠시 후 다시 시도해주세요.');
    }
  }

  return (
    <form
      method="POST"
      action={`/groups/${groupId}/office-fares/offices`}
      id="officeForm"
      onSubmit={(e) => {
        if (!coords) {
          e.preventDefault();
          window.alert('주소를 검색해서 좌표를 확정해주세요. 좌표가 없으면 지점을 알아볼 수 없습니다.');
        }
      }}
    >
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: 1 }}>
          <label>지점명(상호)</label>
          <input type="text" name="name" placeholder="예: 강남지점" required />
        </div>
        <div className="field" style={{ flex: 2 }}>
          <label>주소</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="text" id="officeAddress" name="address" placeholder="상호명 또는 주소로 검색"
              required readOnly value={address} />
            <button type="button" className="btn secondary" onClick={search}>주소검색</button>
          </div>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>상세주소</label>
          <input type="text" name="address_detail" placeholder="동/층/호 (선택)" />
        </div>
        <div className="field"><button className="btn" type="submit">지점 등록</button></div>
      </div>
      <input type="hidden" name="lat" value={coords ? coords.lat : ''} />
      <input type="hidden" name="lon" value={coords ? coords.lon : ''} />
      <p className="page-sub">{hint}</p>
      {candidates.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {candidates.map((d, i) => (
            <button key={i} type="button" className="btn small secondary"
              style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 4 }}
              onClick={() => {
                const picked = d.road_address || d.jibun_address || d.place_name || '';
                setAddress(picked);
                setCoords({ lat: d.lat, lon: d.lon });
                setHint(`좌표 확정 — ${picked} (${Number(d.lat).toFixed(5)}, ${Number(d.lon).toFixed(5)})`);
                setCandidates([]);
              }}>
              {(d.place_name ? d.place_name + ' · ' : '') + (d.road_address || d.jibun_address || '')}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}
