'use client';

// 오더 상세의 기사 위치 지도 — 관리자·지사·고객이 모두 본다(사용자 지시).
//
// 값은 GET /orders/:id/driver-location.json에서 온다(콜마너 MCP). 30초마다 위치만 다시 받아
// 마커를 옮긴다 — 페이지를 새로고침하면 지도가 매번 처음 위치로 돌아가 따라가기가 안 된다.
//
// 배차 전·완료 후에는 아예 그리지 않는다. 완료 뒤에는 콜마너가 위치를 더는 수집하지 않으므로
// 보여줄 것이 없고, 빈 지도를 띄우면 "위치가 안 뜬다"는 문의가 늘 뿐이다.
import { useEffect, useRef, useState } from 'react';
import Script from 'next/script';

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

export default function DriverLocationMap({ orderId, status, initial = null }) {
  // 서버가 처음 값을 함께 내려준다(page.js) — 그래야 첫 화면부터 사실을 말한다. 이게 없으면
  // 클라이언트가 붙기 전까지 "위치를 확인하는 중입니다…"만 떠 있고, 클라이언트가 못 붙는
  // 상황에서는 그 문구가 영원히 남는다(실측 2026-09-08: 그 상태를 "위치가 안 나온다"로 봤다).
  const [data, setData] = useState(initial);
  const [sdkReady, setSdkReady] = useState(false);
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

  // 지도는 좌표가 실제로 생겼을 때 만든다.
  //
  // **카카오 SDK를 이 컴포넌트가 직접 싣는다.** 예전에는 "오더 폼(RouteMap)이 이미 싣고
  // 있다"고 보고 있을 때만 그렸는데, RouteMap은 /orders/new 화면의 것이고 오더 상세에는
  // 없다 — 즉 이 화면에서 window.kakao는 **영원히** 없었고 지도는 한 번도 그려지지 않았다
  // (실측 2026-09-08, OID2075: 좌표는 서버에서 정상으로 왔는데 지도만 안 떴다).
  // EJS 상세화면은 자기 화면에서 SDK를 싣고 있어 잘 나왔다 — 두 화면이 갈려 있었다.
  useEffect(() => {
    if (!data || !data.available || !boxRef.current || !sdkReady) return undefined;
    const kakao = typeof window !== 'undefined' ? window.kakao : null;
    if (!kakao || !kakao.maps || !kakao.maps.Map) return undefined;

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
    return undefined;
  }, [data, sdkReady]);

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

      {/* 지도 SDK — 이 화면이 직접 싣는다(위 useEffect 주석 참고). autoload=false + maps.load는
          오더 폼의 RouteMap과 같은 방식이다: 스크립트가 왔다고 바로 kakao.maps가 준비된 것이
          아니라, load 콜백을 받아야 Map을 만들 수 있다.
          좌표가 없으면(배차 전·신호 없음) 굳이 싣지 않는다 — 볼 지도가 없다. */}
      {data && data.available && (
        <Script
          src={`//dapi.kakao.com/v2/maps/sdk.js?appkey=${process.env.NEXT_PUBLIC_KAKAO_JS_KEY}&autoload=false`}
          strategy="afterInteractive"
          onLoad={() => {
            if (window.kakao && window.kakao.maps) window.kakao.maps.load(() => setSdkReady(true));
          }}
          onReady={() => {
            // 이미 실려 있던 경우(같은 화면을 되돌아왔을 때) onLoad가 다시 오지 않는다.
            if (window.kakao && window.kakao.maps) window.kakao.maps.load(() => setSdkReady(true));
          }}
        />
      )}
    </div>
  );
}
