'use client';

// 오더 상세의 기사 위치 지도 — 관리자·지사·고객이 모두 본다(사용자 지시).
//
// 값은 GET /orders/:id/driver-location.json에서 온다(콜마너 MCP). 30초마다 위치만 다시 받아
// 마커를 옮긴다 — 페이지를 새로고침하면 지도가 매번 처음 위치로 돌아가 따라가기가 안 된다.
//
// 배차 전·완료 후에는 아예 그리지 않는다. 완료 뒤에는 콜마너가 위치를 더는 수집하지 않으므로
// 보여줄 것이 없고, 빈 지도를 띄우면 "위치가 안 뜬다"는 문의가 늘 뿐이다.
import { useEffect, useRef, useState } from 'react';

const POLL_MS = 30000;

// 왜 안 보이는지를 사유별로 다르게 말한다. "확인되지 않습니다" 한 마디로 뭉뚱그리면
// 보는 사람이 새로고침만 반복한다.
const REASON_TEXT = {
  not_dispatched: '아직 기사님이 배정되지 않았습니다.',
  not_matched: '아직 기사님이 배정되지 않았습니다.',
  completed: '운행이 완료되어 위치를 표시하지 않습니다.',
  no_fix: '기사님 위치 신호가 아직 잡히지 않았습니다.',
  no_callmaner: '위치 확인을 지원하지 않는 주문입니다.',
  mcp_not_configured: '위치 확인을 지원하지 않는 주문입니다.',
  no_cid: '출발지 연락처가 없어 위치를 조회할 수 없습니다.',
  mcp_failed: '기사님 위치를 확인하지 못했습니다.',
  error: '기사님 위치를 확인하지 못했습니다.',
};

// 위치를 물어볼 가치가 있는 상태. 서버(lib/driverLocation.js TRACKABLE_STATUSES)와 같은 값이다 —
// 여기서 넓게 잡으면 완료된 오더마다 쓸데없이 MCP를 두드린다.
const TRACKABLE = new Set(['기사배정', '운행시작']);

export default function DriverLocationMap({ orderId, status }) {
  const [data, setData] = useState(null);
  const mapRef = useRef(null);
  const boxRef = useRef(null);
  const markerRef = useRef(null);
  const staticDrawnRef = useRef(false);

  const trackable = TRACKABLE.has(String(status || ''));

  useEffect(() => {
    if (!trackable) return undefined;
    let cancelled = false;
    let timer = null;

    const poll = () => {
      fetch(`/orders/${orderId}/driver-location.json`, { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!cancelled && d) setData(d); })
        // 한 번 실패해도 멈추지 않는다 — 지하주차장 등에서 잠깐 끊기는 것이 정상이다.
        .catch(() => {});
    };

    poll();
    timer = setInterval(poll, POLL_MS);
    // 탭이 가려져 있는 동안은 묻지 않는다. 오더 상세를 켜둔 채 두는 관리자가 많아, 그대로 두면
    // 하루 종일 콜마너를 두드린다.
    const onVis = () => {
      if (document.hidden) { clearInterval(timer); timer = null; }
      else if (!timer) { poll(); timer = setInterval(poll, POLL_MS); }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [orderId, trackable]);

  // 지도는 좌표가 실제로 생겼을 때 만든다. 카카오 SDK는 오더 폼(RouteMap)이 이미 싣고 있고,
  // 이 화면에는 없을 수 있어 있을 때만 그린다 — 없다고 화면 전체가 깨지면 안 된다.
  useEffect(() => {
    if (!data || !data.available || !boxRef.current) return;
    // 카카오 SDK는 같은 화면의 오더 폼(RouteMap)이 비동기로 싣는다. 아직 안 왔으면 잠깐 뒤
    // 다시 본다 — 다음 폴링(30초)까지 기다리면 그동안 지도가 빈 채로 남는다.
    const kakao = typeof window !== 'undefined' ? window.kakao : null;
    if (!kakao || !kakao.maps || !kakao.maps.Map) {
      const retry = setTimeout(() => setData((d) => (d ? { ...d } : d)), 800);
      return () => clearTimeout(retry);
    }

    const pos = new kakao.maps.LatLng(data.lat, data.lon);
    if (!mapRef.current) {
      mapRef.current = new kakao.maps.Map(boxRef.current, { center: pos, level: 5 });
    }
    const map = mapRef.current;

    if (!staticDrawnRef.current) {
      const pin = (p, label, color) => {
        if (!p || !p.lat || !p.lon) return;
        const at = new kakao.maps.LatLng(p.lat, p.lon);
        new kakao.maps.Marker({ map, position: at });
        new kakao.maps.CustomOverlay({
          map, position: at, yAnchor: 2.1,
          content: `<div style="background:${color};color:#fff;font-size:11px;padding:2px 6px;border-radius:3px;white-space:nowrap;">${label}</div>`,
        });
      };
      pin(data.origin, '출발', '#2e5c8a');
      pin(data.destination, '도착', '#c2410c');
      staticDrawnRef.current = true;
    }

    if (!markerRef.current) {
      markerRef.current = new kakao.maps.Marker({ map, position: pos, zIndex: 10 });
      new kakao.maps.CustomOverlay({
        map, position: pos, yAnchor: 2.1, zIndex: 11,
        content: '<div style="background:#111;color:#fff;font-size:11px;padding:2px 6px;border-radius:3px;white-space:nowrap;">기사님</div>',
      });
      map.setCenter(pos);
    } else {
      markerRef.current.setPosition(pos);
      map.panTo(pos);
    }
  }, [data]);

  if (!trackable) return null;

  const bits = [];
  if (data && data.distanceKm) bits.push(`출발지까지 약 ${data.distanceKm}km`);
  if (data && data.etaMinutes) bits.push(`약 ${data.etaMinutes}분 소요 예상`);

  return (
    <div className="card">
      <div className="section-title">📍 기사님 위치</div>

      {!data ? (
        <p className="hint">위치를 확인하는 중입니다…</p>
      ) : !data.available ? (
        <p className="hint">{REASON_TEXT[data.reason] || '기사님 위치를 확인하지 못했습니다.'}</p>
      ) : (
        <>
          <p style={{ margin: '0 0 8px', fontWeight: 600 }}>
            {bits.length ? bits.join(' · ') : '기사님이 이동 중입니다.'}
          </p>
          {/* 오래된 좌표를 "지금 위치"로 보여주면 엉뚱한 곳에서 기다리게 된다. */}
          <p className="hint" style={{ margin: '0 0 8px' }}>
            {data.stale && data.ageMinutes != null
              ? `${data.ageMinutes}분 전에 확인된 위치입니다.`
              : '위치는 30초마다 갱신됩니다.'}
          </p>
          <div ref={boxRef} style={{ width: '100%', height: 280, background: '#e9ecef', borderRadius: 4 }} />
          {data.trackingUrl && (
            <p className="hint" style={{ margin: '8px 0 0' }}>
              고객 안내용 링크:{' '}
              <a href={data.trackingUrl} target="_blank" rel="noopener noreferrer">{data.trackingUrl}</a>
            </p>
          )}
        </>
      )}
    </div>
  );
}
