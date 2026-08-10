// §7-2 자동 승격 판정 — 프리미엄(시간제) 오더가 실제로는 8시간 이상 소요되면 일일기사로
// 전환한다. 원래 routes/orders.js의 수동 오더 등록 핸들러 안에만 있던 로직을 그대로 옮겼다
// (동작을 바꾸지 않았다) — 웹 AI 접수(Stage C, lib/webPremiumIntakeService.js)도 프리미엄
// 오더를 만들면 같은 판정을 거쳐야 하는데, 두 곳에 각자 두면 판정 기준이 갈리기 쉽다.
//
// fire-and-forget이 원칙이다 — 경로탐색 실패/지연이 오더 등록 자체를 막으면 안 된다. 호출부가
// await하지 않고 그냥 실행만 트리거해도 되고(주석대로 tripType==='premium'일 때만 부른다),
// 여기서 던지는 예외는 없다(내부에서 전부 잡아 로그만 남긴다).
const db = require('../db');

const UPGRADE_THRESHOLD_SECONDS = 8 * 3600;

async function maybeUpgradePremiumToDaily({ orderId, actorUserId, reservationHoursBracket, destinationWaitMinutes }) {
  try {
    const originCoord = await db.get('SELECT origin_lat AS lat, origin_lon AS lon FROM orders WHERE id = ?', [orderId])
      .catch(() => null);

    // 좌표 미확보 시 1순위(계산값) 불가 → 2순위(사용자 답변 시간구간) 판정
    if (!originCoord || !originCoord.lat) {
      if (reservationHoursBracket === 'over_8h') {
        await db.run('UPDATE orders SET order_type = ? WHERE id = ?', ['daily_driver', orderId]);
        await db.run(
          `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note) VALUES (?, ?, NULL, NULL, ?)`,
          [orderId, actorUserId, '오더 타입 자동 승격: daily_driver (시간구간 over_8h 기준)']
        );
      }
      return;
    }

    // 좌표 있으면 Kakao Mobility로 실제 소요시간 계산
    const kakaoKey = process.env.KAKAO_REST_API_KEY;
    if (!kakaoKey) return;

    const originLatLon = await db.get('SELECT origin_lat AS lat, origin_lon AS lon FROM orders WHERE id = ?', [orderId]);
    const destLatLon = await db.get('SELECT destination_lat AS lat, destination_lon AS lon FROM orders WHERE id = ?', [orderId]);
    if (!originLatLon || !originLatLon.lat || !destLatLon || !destLatLon.lat) return;

    const waypointCoords = await db.all(
      'SELECT lat, lon FROM order_waypoints WHERE order_id = ? ORDER BY seq', [orderId]
    );

    const toCoordStr = (r) => `${r.lon},${r.lat}`;
    let routeDuration = 0;

    if (!waypointCoords.length) {
      const qs = new URLSearchParams({
        origin: toCoordStr(originLatLon),
        destination: toCoordStr(destLatLon),
        priority: 'RECOMMEND',
      });
      const r = await fetch('https://apis-navi.kakaomobility.com/v1/future/directions?' + qs.toString(), {
        headers: { Authorization: 'KakaoAK ' + kakaoKey },
      });
      if (r.ok) {
        const d = await r.json();
        const route = d.routes && d.routes[0];
        if (route && route.result_code === 0) routeDuration = route.summary.duration || 0;
      }
    } else {
      const body = {
        origin: { x: originLatLon.lon, y: originLatLon.lat },
        destination: { x: destLatLon.lon, y: destLatLon.lat },
        waypoints: waypointCoords.map((w) => ({ x: w.lon, y: w.lat })),
        priority: 'RECOMMEND',
      };
      const r = await fetch('https://apis-navi.kakaomobility.com/v1/waypoints/directions', {
        method: 'POST',
        headers: { Authorization: 'KakaoAK ' + kakaoKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const d = await r.json();
        const route = d.routes && d.routes[0];
        if (route && route.result_code === 0) routeDuration = route.summary.duration || 0;
      }
    }

    // 대기시간 합산 (경유지 대기 + 도착지 대기)
    const waypointWait = await db.all(
      'SELECT COALESCE(wait_minutes, 0) AS wait_minutes FROM order_waypoints WHERE order_id = ?', [orderId]
    );
    const totalWaitSeconds = waypointWait.reduce((s, w) => s + Number(w.wait_minutes || 0) * 60, 0)
      + (destinationWaitMinutes ? Number(destinationWaitMinutes) * 60 : 0);

    const totalSeconds = routeDuration + totalWaitSeconds;
    if (totalSeconds >= UPGRADE_THRESHOLD_SECONDS) {
      await db.run('UPDATE orders SET order_type = ? WHERE id = ?', ['daily_driver', orderId]);
      await db.run(
        `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note) VALUES (?, ?, NULL, NULL, ?)`,
        [orderId, actorUserId, `오더 타입 자동 승격: daily_driver (${Math.round(totalSeconds / 3600)}시간 초과)`]
      );
    }
  } catch (e) {
    console.error('자동 승격 판정 실패(무시하고 진행):', e.message);
  }
}

module.exports = { maybeUpgradePremiumToDaily, UPGRADE_THRESHOLD_SECONDS };
