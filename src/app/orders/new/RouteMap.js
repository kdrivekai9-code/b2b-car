'use client';

import Script from 'next/script';
import { useEffect, useRef, useState } from 'react';

// Kakao Maps 렌더링 + 실제 경로(directions) 조회. order-form.js의 refreshMapView/
// fetchRealDirections/fetchSplitSamcheonpoDirections를 React로 이식했다.
// 범위 축소(공개적으로 문서화): 경로탐색 우선순위 선택(추천/최단시간/최단거리/무료도로)과
// 구간별 상세 거리 리스트 UI는 이번 슬라이스에서는 생략 — 총 거리/시간/톨비 + 페리 여부만
// 표시한다. 요금계산(useFarePreview)과 예약기준 역산은 이 값들만 있으면 충분하다.
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

export default function RouteMap({ points, originAddress, destinationAddress, onRouteUpdate }) {
  const [sdkReady, setSdkReady] = useState(false);
  const mapDivRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef({});
  const routeLineRef = useRef(null);
  const requestIdRef = useRef(0);
  const [summary, setSummary] = useState({ km: null, durationSec: null, toll: null, hasFerryLeg: false, isFinal: false });

  useEffect(() => {
    if (!sdkReady || !mapDivRef.current || mapRef.current) return;
    if (typeof window.kakao === 'undefined' || !window.kakao.maps) return;
    mapRef.current = new window.kakao.maps.Map(mapDivRef.current, {
      center: new window.kakao.maps.LatLng(36.5, 127.9),
      level: 12,
    });
  }, [sdkReady]);

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

    const params = new URLSearchParams({ origin: coord(resolvedPoints[0]), destination: coord(resolvedPoints[resolvedPoints.length - 1]), priority: 'RECOMMEND' });
    if (resolvedPoints.length > 2) params.set('waypoints', resolvedPoints.slice(1, -1).map(coord).join('|'));
    fetch('/kakao/directions?' + params.toString())
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return; // 직선거리 fallback 유지
        const path = data.path ? data.path.map((c) => new kakao.maps.LatLng(c[0], c[1])) : [];
        applyFinal(data.totalDistance / 1000, data.totalDuration, data.tollFare, !!data.hasFerryLeg, path, data.ferrySegments || null);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdkReady, JSON.stringify(points), originAddress, destinationAddress]);

  return (
    <aside className="card map-card order-map-panel">
      <div className="panel-title compact">
        <div className="panel-icon">03</div>
        <div><h2>경로 미리보기</h2><p>입력한 주소를 바탕으로 경로를 확인합니다.</p></div>
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
      <div id="orderMap" ref={mapDivRef} className="order-map" />
      <Script
        src={`//dapi.kakao.com/v2/maps/sdk.js?appkey=${process.env.NEXT_PUBLIC_KAKAO_JS_KEY}&autoload=false`}
        strategy="afterInteractive"
        onLoad={() => window.kakao.maps.load(() => setSdkReady(true))}
      />
    </aside>
  );
}
