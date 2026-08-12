'use client';

import Script from 'next/script';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Kakao Maps 렌더링 + 실제 경로(directions) 조회. order-form.js의 refreshMapView/
// fetchRealDirections/fetchSplitSamcheonpoDirections를 React로 이식했다.
// 경로탐색 우선순위(추천/최단시간/최단거리/무료도로)는 priority/onPriorityChange로 부모
// (OrderForm.js)가 제어한다 — 오더구분(탁송/일일기사/프리미엄대리)에 따라 기본값이 갈리므로
// (사용자 요청) 상태를 이 컴포넌트 안에 가두지 않았다. 구간별 상세 거리 리스트 UI는 여전히
// 생략 — 총 거리/시간/톨비 + 페리 여부만 표시한다. 요금계산(useFarePreview)과 예약기준
// 역산은 이 값들만 있으면 충분하다.
// 삼천포-제주 강제 도선 구간(forceSamcheonpo)은 priority와 무관하게 항상 RECOMMEND다
// (public/js/order-form.js의 fetchSplitSamcheonpoDirections와 동일 — 고정 경유 항로라
// 우선순위를 바꿔도 달라질 게 없다).
const SAMCHEONPO_REGION_RE = /(강원|경상남도|경남|경상북도|경북|부산|울산)/;
const SAMCHEONPO_PORT = { lat: 34.9269695307662, lng: 128.088376812689 };
const JEJU_PORT = { lat: 33.519591050522465, lng: 126.53500143704899 };
const SAMCHEONPO_JEJU_FERRY_DURATION_S = 390 * 60;

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function formatDuration(seconds) {
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}

export default function RouteMap({ points, originAddress, destinationAddress, onRouteUpdate, priority, onPriorityChange }) {
  const [sdkReady, setSdkReady] = useState(false);
  const mapDivRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef({});
  const routeLineRef = useRef(null);
  const requestIdRef = useRef(0);
  const [summary, setSummary] = useState({ km: null, durationSec: null, toll: null, hasFerryLeg: false, isFinal: false });

  // 지도 확대보기: #orderMap DOM 노드(및 그 안의 kakao map 인스턴스)를 다시 만들지 않고,
  // createPortal의 대상 컨테이너만 도킹 위치 ↔ 모달 위치로 바꿔서 같은 노드를 옮긴다.
  // (일반 order-form.js의 vanilla 버전은 appendChild로 직접 옮기지만, React가 관리하는
  // 트리에서 같은 걸 하면 다음 렌더에서 리컨실리에이션이 깨질 수 있어 portal을 쓴다.)
  const [zoomOpen, setZoomOpen] = useState(false);
  const dockSlotRef = useRef(null);
  const modalSlotRef = useRef(null);
  const [portalTarget, setPortalTarget] = useState(null);

  useEffect(() => {
    setPortalTarget(dockSlotRef.current);
  }, []);

  // zoomOpen이 true가 되는 렌더에서 모달 껍데기(모달 슬롯 포함)가 함께 커밋되므로,
  // 커밋 직후(paint 전) 실행되는 useLayoutEffect에서 바로 modalSlotRef.current를 읽을 수 있다.
  useLayoutEffect(() => {
    if (zoomOpen) setPortalTarget(modalSlotRef.current);
  }, [zoomOpen]);

  // 도킹→모달, 모달→도킹으로 컨테이너 크기가 바뀔 때마다 relayout하지 않으면
  // 카카오맵이 이전 크기 기준으로 타일을 그려 지도가 잘려 보인다.
  useEffect(() => {
    if (!mapRef.current || !portalTarget) return;
    const id = requestAnimationFrame(() => mapRef.current.relayout());
    return () => cancelAnimationFrame(id);
  }, [portalTarget]);

  function closeZoom() {
    // dockSlotRef는 항상 마운트되어 있으므로 모달 껍데기가 사라지기 전에(같은 렌더에서)
    // portalTarget을 먼저 도킹 위치로 되돌려, 지도가 잠깐 갈 곳을 잃지 않게 한다.
    setPortalTarget(dockSlotRef.current);
    setZoomOpen(false);
  }

  useEffect(() => {
    if (!sdkReady || !mapDivRef.current || mapRef.current) return;
    if (typeof window.kakao === 'undefined' || !window.kakao.maps) return;
    mapRef.current = new window.kakao.maps.Map(mapDivRef.current, {
      center: new window.kakao.maps.LatLng(36.5, 127.9),
      level: 12,
    });
    // portalTarget 의존성: #orderMap이 도킹 슬롯으로 처음 포탈되는 커밋 이후에야
    // mapDivRef.current가 채워지므로, 이 효과가 그 시점에 한 번 더 재시도되어야 한다.
  }, [sdkReady, portalTarget]);

  useEffect(() => {
    if (!sdkReady || !mapRef.current) return;
    const kakao = window.kakao;
    const map = mapRef.current;

    // 마커 재구성: points에 없는 슬롯은 지우고, 있는 슬롯은 새로 만들거나 위치만 갱신.
    const nextSlots = new Set(points.map((p) => p.slot));
    Object.keys(markersRef.current).forEach((slot) => {
      if (!nextSlots.has(slot)) {
        markersRef.current[slot].setMap(null);
        delete markersRef.current[slot];
      }
    });
    points.forEach((p) => {
      if (p.lat == null || p.lon == null) return;
      const position = new kakao.maps.LatLng(p.lat, p.lon);
      const pinClass = p.slot === 'origin' ? 'origin' : p.slot === 'destination' ? 'dest' : 'waypoint';
      if (markersRef.current[p.slot]) {
        markersRef.current[p.slot].setPosition(position);
      } else {
        const overlay = new kakao.maps.CustomOverlay({
          position, content: `<div class="map-pin ${pinClass}"></div>`, xAnchor: 0.5, yAnchor: 0.5,
        });
        overlay.setMap(map);
        markersRef.current[p.slot] = overlay;
      }
    });

    const resolvedPoints = points.filter((p) => p.lat != null && p.lon != null);
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;

    function drawPolyline(path) {
      if (routeLineRef.current) { routeLineRef.current.setMap(null); routeLineRef.current = null; }
      if (path.length < 2) return;
      routeLineRef.current = new kakao.maps.Polyline({
        path, strokeWeight: 4, strokeColor: '#2e5c8a', strokeOpacity: 0.8, strokeStyle: 'solid',
      });
      routeLineRef.current.setMap(map);
    }

    if (resolvedPoints.length === 0) {
      if (routeLineRef.current) { routeLineRef.current.setMap(null); routeLineRef.current = null; }
      const next = { km: null, durationSec: null, toll: null, hasFerryLeg: false, isFinal: false };
      setSummary(next);
      onRouteUpdate(next);
      return;
    }
    if (resolvedPoints.length === 1) {
      if (routeLineRef.current) { routeLineRef.current.setMap(null); routeLineRef.current = null; }
      map.setCenter(new kakao.maps.LatLng(resolvedPoints[0].lat, resolvedPoints[0].lon));
      map.setLevel(5);
      const next = { km: null, durationSec: null, toll: null, hasFerryLeg: false, isFinal: false };
      setSummary(next);
      onRouteUpdate(next);
      return;
    }

    const latlngs = resolvedPoints.map((p) => new kakao.maps.LatLng(p.lat, p.lon));
    drawPolyline(latlngs);
    let straightKm = 0;
    for (let i = 0; i < resolvedPoints.length - 1; i++) {
      straightKm += haversineKm([resolvedPoints[i].lat, resolvedPoints[i].lon], [resolvedPoints[i + 1].lat, resolvedPoints[i + 1].lon]);
    }
    const straightSummary = { km: straightKm, durationSec: null, toll: null, hasFerryLeg: false, isFinal: false };
    setSummary(straightSummary);
    onRouteUpdate(straightSummary);

    const bounds = new kakao.maps.LatLngBounds();
    resolvedPoints.forEach((p) => bounds.extend(new kakao.maps.LatLng(p.lat, p.lon)));
    map.setBounds(bounds);

    const coord = (p) => `${p.lon},${p.lat}`;
    const forceSamcheonpo = SAMCHEONPO_REGION_RE.test(originAddress || '') && /제주/.test(destinationAddress || '');

    async function applyFinal(totalKm, totalDurationSec, tollFare, hasFerryLeg, path, ferrySegments) {
      if (requestId !== requestIdRef.current) return; // 오래된 응답
      if (path && path.length > 1) drawPolyline(path);
      const next = { km: totalKm, durationSec: totalDurationSec, toll: tollFare, hasFerryLeg, isFinal: true, ferrySegments: ferrySegments || null };
      setSummary(next);
      onRouteUpdate(next);
    }

    if (forceSamcheonpo) {
      const origin = resolvedPoints[0];
      const destination = resolvedPoints[resolvedPoints.length - 1];
      const beforeWaypoints = resolvedPoints.slice(1, -1);
      const legAParams = new URLSearchParams({ origin: coord(origin), destination: `${SAMCHEONPO_PORT.lng},${SAMCHEONPO_PORT.lat}`, priority: 'RECOMMEND' });
      if (beforeWaypoints.length) legAParams.set('waypoints', beforeWaypoints.map(coord).join('|'));
      const legBParams = new URLSearchParams({ origin: `${JEJU_PORT.lng},${JEJU_PORT.lat}`, destination: coord(destination), priority: 'RECOMMEND' });

      Promise.all([
        fetch('/kakao/directions?' + legAParams.toString()).then((r) => (r.ok ? r.json() : null)),
        fetch('/kakao/directions?' + legBParams.toString()).then((r) => (r.ok ? r.json() : null)),
      ]).then(([legA, legB]) => {
        if (!legA || !legB) return; // 직선거리 fallback 유지
        const totalRoadKm = (legA.totalDistance + legB.totalDistance) / 1000;
        const totalDuration = legA.totalDuration + SAMCHEONPO_JEJU_FERRY_DURATION_S + legB.totalDuration;
        let fullPath = [];
        if (legA.path) fullPath = fullPath.concat(legA.path.map((c) => new kakao.maps.LatLng(c[0], c[1])));
        fullPath.push(new kakao.maps.LatLng(SAMCHEONPO_PORT.lat, SAMCHEONPO_PORT.lng));
        fullPath.push(new kakao.maps.LatLng(JEJU_PORT.lat, JEJU_PORT.lng));
        if (legB.path) fullPath = fullPath.concat(legB.path.map((c) => new kakao.maps.LatLng(c[0], c[1])));
        const ferryDistanceM = haversineKm([SAMCHEONPO_PORT.lat, SAMCHEONPO_PORT.lng], [JEJU_PORT.lat, JEJU_PORT.lng]) * 1000;
        applyFinal(totalRoadKm, totalDuration, (legA.tollFare || 0) + (legB.tollFare || 0), true, fullPath, {
          fromPort: '삼천포신항', toPort: '제주항',
          beforeDistanceM: legA.totalDistance, beforeDurationS: legA.totalDuration,
          ferryDistanceM, ferryDurationS: SAMCHEONPO_JEJU_FERRY_DURATION_S,
          afterDistanceM: legB.totalDistance, afterDurationS: legB.totalDuration,
        });
      }).catch(() => {});
      return;
    }

    // "무료도로"는 카카오모빌리티 API에 없는 우선순위라 order-form.js와 동일하게 RECOMMEND +
    // avoid=toll 조합으로 흉내낸다.
    const isFreeRoute = priority === 'FREE';
    const apiPriority = isFreeRoute ? 'RECOMMEND' : (priority || 'RECOMMEND');
    const params = new URLSearchParams({ origin: coord(resolvedPoints[0]), destination: coord(resolvedPoints[resolvedPoints.length - 1]), priority: apiPriority });
    if (isFreeRoute) params.set('avoid', 'toll');
    if (resolvedPoints.length > 2) params.set('waypoints', resolvedPoints.slice(1, -1).map(coord).join('|'));
    fetch('/kakao/directions?' + params.toString())
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return; // 직선거리 fallback 유지
        const path = data.path ? data.path.map((c) => new kakao.maps.LatLng(c[0], c[1])) : [];
        applyFinal(data.totalDistance / 1000, data.totalDuration, data.tollFare, !!data.hasFerryLeg, path, data.ferrySegments || null);
      })
      .catch(() => {});
    // portalTarget: #orderMap이 도킹 슬롯으로 포탈된 직후 map 인스턴스가 막 생겼을 수 있으니
    // (위 map-생성 effect 주석 참고) 이 effect도 그 시점에 한 번 더 재시도되어야 한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdkReady, portalTarget, JSON.stringify(points), originAddress, destinationAddress, priority]);

  return (
    <aside className="card map-card order-map-panel">
      <div className="route-search-header">
        <div className="section-title small" style={{ margin: 0 }}>🧭 경로탐색</div>
        <select className="route-priority-select" value={priority} onChange={(e) => onPriorityChange(e.target.value)}>
          <option value="RECOMMEND">추천</option>
          <option value="TIME">최단시간</option>
          <option value="DISTANCE">최단거리</option>
          <option value="FREE">무료도로</option>
        </select>
      </div>
      {summary.km != null && (
        <div className="map-distance-info">
          <div className="route-summary-grid">
            <div className="route-summary-item"><div className="label">총거리</div><div className="value">{summary.km.toFixed(1)}km</div></div>
            <div className="route-summary-item"><div className="label">예상소요시간</div><div className="value">{summary.durationSec != null ? formatDuration(summary.durationSec) : '-'}</div></div>
            <div className="route-summary-item"><div className="label">예상톨비</div><div className="value">{summary.toll != null ? (Number(summary.toll) === 0 ? '무료' : Number(summary.toll).toLocaleString('ko-KR') + '원') : '-'}</div></div>
            {summary.hasFerryLeg && <div className="route-summary-item"><div className="label">도선 구간</div><div className="value">포함</div></div>}
          </div>
          <div className="fare-calc-hint" style={{ margin: '8px 0 0' }}>
            소요시간 기준: {summary.isFinal ? '실제 도로 경로' : '직선거리 임시값 (도로 경로 탐색 중)'}
          </div>
        </div>
      )}
      <div className="map-wrap">
        <div ref={dockSlotRef} />
        {!zoomOpen && (
          <button type="button" className="map-zoom-btn" title="크게 보기" aria-label="지도 크게 보기" onClick={() => setZoomOpen(true)}>🔍</button>
        )}
      </div>
      {portalTarget && createPortal(
        <div id="orderMap" ref={mapDivRef} className="order-map" />,
        portalTarget
      )}
      {zoomOpen && (
        <div className="map-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) closeZoom(); }}>
          <div className="map-modal-box">
            <div className="map-modal-header">
              <h3>경로 미리보기</h3>
              <button type="button" className="modal-close" onClick={closeZoom}>✕</button>
            </div>
            <div className="map-modal-body" ref={modalSlotRef} />
          </div>
        </div>
      )}
      <Script
        src={`//dapi.kakao.com/v2/maps/sdk.js?appkey=${process.env.NEXT_PUBLIC_KAKAO_JS_KEY}&autoload=false`}
        strategy="afterInteractive"
        onLoad={() => window.kakao.maps.load(() => setSdkReady(true))}
      />
    </aside>
  );
}
