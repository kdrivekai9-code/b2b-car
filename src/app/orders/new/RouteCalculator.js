'use client';

import { useEffect, useRef } from 'react';

// RouteMap.js와 완전히 같은 경로탐색 로직(직선거리 즉시 fallback → Kakao Mobility 실제
// 도로 경로 조회 → 삼천포-제주 도선 특수 케이스)을 그대로 쓰되, 지도 렌더링(Kakao Maps
// JS SDK 로드, 지도 캔버스, 마커/폴리라인)은 전혀 하지 않는다 — 요금 자동계산과 배송기준
// 예약시간 역산이 필요로 하는 routeInfo(km/durationSec/toll/hasFerryLeg)만 계산해서
// onRouteUpdate로 올려준다. 오더 상세(수정) 화면에서 "지도는 빼되 경로탐색·요금계산은
// 유지해달라"는 요청으로 RouteMap에서 지도 부분만 잘라내 분리했다. 화면에 아무것도
// 그리지 않으므로(return null) 어디에 배치해도 레이아웃에 영향이 없다.
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

// 경로탐색 실패를 조용히 삼키지 않는다.
//
// 예전에는 응답이 ok가 아니면 null로 바꿔 그냥 return하고 예외는 빈 .catch()가 먹었다. 화면에는
// 직선거리 임시값만 남는데 왜 그런지는 아무 데도 안 남아서, 실제 사고(2026-08-25 사당역→
// 서귀포시청 요금문의)에서 원인을 찾을 수 없었다. 같은 규칙을 public/js/order-form.js에도 뒀다.
async function fetchDirections(url) {
  const res = await fetch(url);
  if (res.ok) return res.json();
  const body = await res.text().catch(() => '');
  let reason = '';
  try {
    const parsed = JSON.parse(body);
    reason = parsed && (parsed.error || parsed.detail) ? String(parsed.error || parsed.detail) : '';
  } catch (_e) {
    reason = String(body || '').slice(0, 200);
  }
  throw new Error('HTTP ' + res.status + (reason ? ' · ' + reason : ''));
}

function reportRouteError(stage, error) {
  const detail = (error && error.message) || '알 수 없는 오류';
  window.__aiIntakeRouteError = { stage, detail };
  console.error('[경로탐색 실패] ' + stage + ': ' + detail);
}

// priority: 'RECOMMEND' | 'TIME' | 'DISTANCE' | 'FREE'(무료도로, avoid=toll로 흉내). 안 넘기면
// (오더 상세/수정 화면처럼 선택 UI가 없는 호출부) 기존 동작 그대로 RECOMMEND를 쓴다.
export default function RouteCalculator({ points, originAddress, destinationAddress, onRouteUpdate, priority }) {
  const requestIdRef = useRef(0);

  useEffect(() => {
    const resolvedPoints = points.filter((p) => p.lat != null && p.lon != null);
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;

    if (resolvedPoints.length < 2) {
      onRouteUpdate({ km: null, durationSec: null, toll: null, hasFerryLeg: false, isFinal: false });
      return;
    }

    let straightKm = 0;
    for (let i = 0; i < resolvedPoints.length - 1; i++) {
      straightKm += haversineKm([resolvedPoints[i].lat, resolvedPoints[i].lon], [resolvedPoints[i + 1].lat, resolvedPoints[i + 1].lon]);
    }
    onRouteUpdate({ km: straightKm, durationSec: null, toll: null, hasFerryLeg: false, isFinal: false });

    const coord = (p) => `${p.lon},${p.lat}`;
    const forceSamcheonpo = SAMCHEONPO_REGION_RE.test(originAddress || '') && /제주/.test(destinationAddress || '');

    function applyFinal(totalKm, totalDurationSec, tollFare, hasFerryLeg, ferrySegments) {
      if (requestId !== requestIdRef.current) return; // 오래된 응답
      onRouteUpdate({ km: totalKm, durationSec: totalDurationSec, toll: tollFare, hasFerryLeg, isFinal: true, ferrySegments: ferrySegments || null });
    }

    if (forceSamcheonpo) {
      const origin = resolvedPoints[0];
      const destination = resolvedPoints[resolvedPoints.length - 1];
      const beforeWaypoints = resolvedPoints.slice(1, -1);
      const legAParams = new URLSearchParams({ origin: coord(origin), destination: `${SAMCHEONPO_PORT.lng},${SAMCHEONPO_PORT.lat}`, priority: 'RECOMMEND' });
      if (beforeWaypoints.length) legAParams.set('waypoints', beforeWaypoints.map(coord).join('|'));
      const legBParams = new URLSearchParams({ origin: `${JEJU_PORT.lng},${JEJU_PORT.lat}`, destination: coord(destination), priority: 'RECOMMEND' });

      Promise.all([
        fetchDirections('/kakao/directions?' + legAParams.toString()),
        fetchDirections('/kakao/directions?' + legBParams.toString()),
      ]).then(([legA, legB]) => {
        const totalRoadKm = (legA.totalDistance + legB.totalDistance) / 1000;
        const totalDuration = legA.totalDuration + SAMCHEONPO_JEJU_FERRY_DURATION_S + legB.totalDuration;
        const ferryDistanceM = haversineKm([SAMCHEONPO_PORT.lat, SAMCHEONPO_PORT.lng], [JEJU_PORT.lat, JEJU_PORT.lng]) * 1000;
        applyFinal(totalRoadKm, totalDuration, (legA.tollFare || 0) + (legB.tollFare || 0), true, {
          fromPort: '삼천포신항', toPort: '제주항',
          beforeDistanceM: legA.totalDistance, beforeDurationS: legA.totalDuration,
          ferryDistanceM, ferryDurationS: SAMCHEONPO_JEJU_FERRY_DURATION_S,
          afterDistanceM: legB.totalDistance, afterDurationS: legB.totalDuration,
        });
      }).catch((e) => reportRouteError('삼천포-제주 경로탐색', e));
      return;
    }

    const isFreeRoute = priority === 'FREE';
    const apiPriority = isFreeRoute ? 'RECOMMEND' : (priority || 'RECOMMEND');
    const params = new URLSearchParams({ origin: coord(resolvedPoints[0]), destination: coord(resolvedPoints[resolvedPoints.length - 1]), priority: apiPriority });
    if (isFreeRoute) params.set('avoid', 'toll');
    if (resolvedPoints.length > 2) params.set('waypoints', resolvedPoints.slice(1, -1).map(coord).join('|'));
    fetchDirections('/kakao/directions?' + params.toString())
      .then((data) => {
        applyFinal(data.totalDistance / 1000, data.totalDuration, data.tollFare, !!data.hasFerryLeg, data.ferrySegments || null);
      })
      .catch((e) => reportRouteError('경로탐색', e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(points), originAddress, destinationAddress, priority]);

  return null;
}
