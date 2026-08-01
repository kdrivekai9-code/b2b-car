'use client';

import { useRef, useState } from 'react';

const MIN_ADDRESS_QUERY_LENGTH = 3;
const ADDRESS_RESULT_LIMIT = 3;

function mainAddressOf(r) {
  return r.road_address || r.jibun_address || '';
}

function resultLabel(r) {
  if (r.type === 'place') {
    const addr = mainAddressOf(r);
    return r.place_name + (addr ? ' · ' + addr : '');
  }
  const main = mainAddressOf(r);
  const sub = r.road_address && r.jibun_address && r.road_address !== r.jibun_address ? r.jibun_address : null;
  return main + (sub ? ' (' + sub + ')' : '');
}

// 검색어와 일치하는 부분을 <mark>처럼 강조 — 기존 order-form.js의 appendHighlightedText와
// 동일한 로직(대소문자 무시, 첫 매치가 아니라 모든 매치를 강조).
function highlightMatches(label, query) {
  const normalizedLabel = label.toLocaleLowerCase();
  const normalizedQuery = String(query || '').toLocaleLowerCase();
  if (!normalizedQuery) return [label];
  const parts = [];
  let fromIndex = 0;
  let matchIndex = normalizedLabel.indexOf(normalizedQuery, fromIndex);
  let key = 0;
  while (matchIndex !== -1) {
    if (matchIndex > fromIndex) parts.push(label.slice(fromIndex, matchIndex));
    parts.push(<span className="addr-result-match" key={key++}>{label.slice(matchIndex, matchIndex + normalizedQuery.length)}</span>);
    fromIndex = matchIndex + normalizedQuery.length;
    matchIndex = normalizedLabel.indexOf(normalizedQuery, fromIndex);
  }
  if (fromIndex < label.length) parts.push(label.slice(fromIndex));
  return parts;
}

async function geocode(query, mode) {
  const qs = new URLSearchParams({ q: query });
  if (mode) qs.set('mode', mode);
  try {
    const res = await fetch('/kakao/search?' + qs.toString());
    const data = await res.json();
    return data.documents || [];
  } catch {
    return [];
  }
}

// 출발지/도착지/경유지 공용 주소 입력 컴포넌트. 기존 order-form.js의 wireAddressField/
// handleAddressBlur/applyResult를 React 컨트롤드-인풋 형태로 이식했다.
export default function AddressField({ label, required, address, detail, onAddressChange, onDetailChange, onResolved, favorites }) {
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [skipGeocode, setSkipGeocode] = useState(false);
  const [detailEnabled, setDetailEnabled] = useState(!!detail);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const debounceRef = useRef(null);
  const lastSearchedQueryRef = useRef('');

  // 등록주소 선택 — 이번 슬라이스에서는 목록 선택만 지원(추가/수정/삭제는 후속 커밋,
  // docs/ai-stage-2-checklist.md에 공개적으로 문서화된 축소 범위). 위/경도는 저장돼 있지
  // 않으므로 텍스트만 채우고 곧바로 지오코딩해서 지도에 반영한다.
  async function selectFavorite(f) {
    onAddressChange(f.address);
    setDetailEnabled(true);
    setFavoritesOpen(false);
    clearResults();
    const docs = await geocode(f.address, 'fallback');
    const best = docs[0];
    if (best && best.lat && best.lon) onResolved(parseFloat(best.lat), parseFloat(best.lon));
  }

  function clearResults() {
    setResults([]);
  }

  function applyResult(r) {
    onAddressChange(mainAddressOf(r));
    setDetailEnabled(true);
    if (r.type === 'place') onDetailChange(r.place_name || '');
    else onDetailChange('');
    if (r.lat && r.lon) onResolved(parseFloat(r.lat), parseFloat(r.lon));
    clearResults();
  }

  async function runSearch(query) {
    if (query.length < MIN_ADDRESS_QUERY_LENGTH) {
      clearResults();
      return;
    }
    setSearching(true);
    lastSearchedQueryRef.current = query;
    const docs = await geocode(query, 'fallback');
    setSearching(false);
    // 검색하는 동안 입력값이 바뀌었으면(다른 요청이 이미 새로 나갔으면) 이 결과는 버린다.
    if (lastSearchedQueryRef.current !== query) return;
    setResults(docs.slice(0, ADDRESS_RESULT_LIMIT));
  }

  function handleChange(e) {
    const value = e.target.value;
    onAddressChange(value);
    if (skipGeocode) return;
    clearTimeout(debounceRef.current);
    if (value.trim().length < MIN_ADDRESS_QUERY_LENGTH) {
      clearResults();
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(value.trim()), 250);
  }

  function handleSearchClick() {
    clearTimeout(debounceRef.current);
    runSearch(address.trim());
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!skipGeocode) handleSearchClick();
    }
  }

  async function handleBlur() {
    if (skipGeocode) return;
    // 드롭다운에서 이미 선택했다면(결과가 비어있고 방금 select 함) 다시 지오코딩할 필요 없음 —
    // 하지만 사용자가 그냥 타이핑만 하고 클릭 없이 포커스를 벗어난 경우를 위한 안전망.
    setTimeout(async () => {
      const q = address.trim();
      if (q.length < MIN_ADDRESS_QUERY_LENGTH) return;
      const docs = await geocode(q, 'fallback');
      const best = docs[0];
      if (best && best.lat && best.lon) onResolved(parseFloat(best.lat), parseFloat(best.lon));
    }, 150);
  }

  function handleSkipGeocodeToggle(checked) {
    setSkipGeocode(checked);
    clearResults();
    if (checked) setDetailEnabled(true);
  }

  return (
    <div className="field full">
      <label>{label} {required && <span className="required-mark" aria-hidden="true">*</span>}</label>
      <div className="addr-input-row">
        <input type="text" className="addr-input" required={required} placeholder="도로명, 지번 또는 상호명으로 검색"
          value={address} onChange={handleChange} onKeyDown={handleKeyDown} onBlur={handleBlur} />
        {!skipGeocode && (
          <button type="button" className="btn small secondary addr-search-btn" onClick={handleSearchClick}>🔍 검색</button>
        )}
      </div>
      <div className="addr-results">
        {searching && <div className="addr-result-item muted">검색 중...</div>}
        {!searching && results.length === 0 && null}
        {!searching && results.map((r, i) => (
          <div className="addr-result-item" key={i} onClick={() => applyResult(r)}>
            {highlightMatches(resultLabel(r), address)}
          </div>
        ))}
      </div>
      <input type="text" className="addr-detail-input" placeholder="상세주소 입력 (건물명, 동/호수)"
        disabled={!detailEnabled} value={detail} onChange={(e) => onDetailChange(e.target.value)} />
      <div className="addr-tools" style={{ position: 'relative' }}>
        <label className="checkline">
          <input type="checkbox" checked={skipGeocode} onChange={(e) => handleSkipGeocodeToggle(e.target.checked)} /> 직접 입력 (주소 검색 안됨)
        </label>
        {favorites && favorites.length > 0 && (
          <>
            <button type="button" className="btn small secondary" onClick={() => setFavoritesOpen((v) => !v)}>등록주소</button>
            {favoritesOpen && (
              <div className="addr-results" style={{ position: 'absolute', top: '100%', right: 0, minWidth: 220, zIndex: 5 }}>
                {favorites.map((f) => (
                  <div className="addr-result-item" key={f.id} onClick={() => selectFavorite(f)}>
                    <b>{f.label}</b> — {f.address}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
