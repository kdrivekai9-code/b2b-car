// 배차된 기사의 현재 위치.
//
// **좌표의 진실은 콜마너 REST의 TrackingDriver다**(lib/callmaner.js). 처음에는 MCP의
// call.list.active가 주는 driver.xy를 썼는데, 그 값은 실제 GPS가 아닐 수 있다 — 응답에
// source='route_interpolated'가 붙고, 실측(2026-09-08, OID2075)에서 출발지↔도착지의 정확히
// 1/3 지점(위도·경도 모두 33%)을 돌려줬다. 같은 순간 TrackingDriver가 준 실제 좌표와
// **7.04km** 떨어져 있었고, 화면은 그 보간값을 "기사님 위치"로 그리고 있었다.
//
// "위치는 MCP 경로에만 있다"고 적어뒀던 것은 틀렸다. OrderInfo에 좌표가 없는 것은 맞지만
// 정의서 상세 시트에 배차기사 현위치 전문이 따로 있었다(docs/callmaner-external-api-notes.md).
//
// MCP는 여전히 쓴다 — 배차 여부(matched)와 픽업까지 ETA·거리는 그쪽에만 있다. 다만 좌표는
// TrackingDriver를 먼저 믿고, MCP 좌표는 **보간값이 아닐 때만** 예비로 쓴다.
//
// 지금까지 이 값은 상담 챗봇(lib/mcpDispatchAgent.js) 안에만 있었다. 오더 상세 화면도 고객
// 통보도 같은 값을 써야 해서 여기로 뺀다 — 세 곳에서 각자 부르면 규칙(언제 보여줄지, 얼마나
// 오래된 좌표까지 믿을지)이 셋으로 갈린다.
const db = require('../db');
const mcp = require('./mcpDispatchClient');
const callmaner = require('./callmaner');
const access = require('./mcpDispatchAccess');
// 공개 주소 기본값은 한 곳에서 온다 — 예전에는 여기에 우리 것이 아닌 도메인이 적혀 있었다.
const { publicBaseUrl } = require('./publicUrl');

// 위치를 보여주는 상태. 배차 전에는 기사가 없고, 완료·취소 뒤에는 콜마너가 위치를 더는
// 수집하지 않는다(사용자 확인) — 없는 값을 물어 MCP를 괴롭힐 이유가 없다.
const TRACKABLE_STATUSES = new Set(['기사배정', '운행시작']);

// 좌표가 이보다 오래되면 "지금 위치"라고 말하지 않는다. 기사 앱이 꺼졌거나 신호가 끊긴 채
// 마지막 좌표만 남은 경우가 있는데, 그걸 현재 위치로 보여주면 고객이 엉뚱한 곳에서 기다린다.
const STALE_AFTER_MS = 10 * 60 * 1000;

// MCP 왕복이 1초 안팎이다. 화면이 30초마다 물어보고 통보 크론도 같은 값을 쓰므로, 짧게 캐시해
// 같은 오더를 연달아 묻는 동안 콜마너를 반복해서 두드리지 않는다.
//
// 서버리스라 인스턴스마다 따로 쌓인다 — 그래도 한 화면이 폴링하는 동안은 대개 같은 인스턴스로
// 가므로 목적(반복 호출 억제)은 이룬다. 정확성에 기대는 캐시가 아니라 TTL이 짧으면 충분하다.
const CACHE_TTL_MS = 20 * 1000;
const cache = new Map();

function cacheGet(orderId) {
  const hit = cache.get(String(orderId));
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(String(orderId)); return null; }
  return hit.value;
}

function cacheSet(orderId, value) {
  // 오래된 항목을 흘려보낸다 — 캐시가 메모리 누수가 되면 안 된다.
  if (cache.size > 500) cache.clear();
  cache.set(String(orderId), { at: Date.now(), value });
}

function isTrackable(order) {
  if (!order) return false;
  if (!order.callmaner_conf_slip) return false;
  return TRACKABLE_STATUSES.has(String(order.status || ''));
}

function parseXy(xy) {
  const parts = String(xy || '').split(',').map((v) => Number(String(v).trim()));
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  // driver.xy는 "위도,경도"다 — place.find 응답과 같은 순서(lib/mcpDispatchAgent.js에서 실측 확인).
  const [lat, lon] = parts;
  // 한반도 밖 좌표는 순서가 뒤집혔거나 쓰레기값이다. 지도에 찍으면 태평양 한가운데가 나온다.
  if (lat < 32 || lat > 40 || lon < 124 || lon > 132) return null;
  return { lat, lon };
}

function ageMs(lastFixAt) {
  const t = Date.parse(String(lastFixAt || ''));
  if (!Number.isFinite(t)) return null;
  return Date.now() - t;
}

// 이 오더가 속한 지사의 콜마너 대표번호. 챗봇은 로그인 사용자에서 얻지만(access.loadDispatchContext)
// 여기서는 오더가 기준이다 — 관리자가 남의 지사 오더를 보거나, 로그인 없는 추적 링크로 열 수 있다.
async function repNoForOrder(order) {
  const branch = order.branch_id
    ? await db.get('SELECT mcp_rep_no, callmaner_provider_id FROM branches WHERE id = ?', [order.branch_id]).catch(() => null)
    : null;
  return String(
    (branch && branch.mcp_rep_no)
    || access.repNoFromProviderId(branch && branch.callmaner_provider_id)
    || process.env.MCP_DISPATCH_DEFAULT_REP_NO
    || ''
  ).trim();
}

// MCP가 좌표를 "만들어낸" 경우를 가린다.
//
// 지금 확인된 값은 route_interpolated 하나지만, 이름이 무엇이든 **gps가 아니면 실제 위치가
// 아니라고 본다** — 새 값이 생겼을 때 조용히 신뢰하는 쪽으로 기울면 같은 사고가 반복된다.
// source가 아예 없는 응답은 예전 그대로 취급한다(모르는 것을 가짜로 단정하지 않는다).
function isSynthesizedSource(source) {
  const s = String(source || '').trim().toLowerCase();
  if (!s) return false;
  return s !== 'gps' && s !== 'device';
}

// 이 오더가 속한 지사 행. REST 전문은 providerId와 대표번호가 필요하다.
async function branchForOrder(order) {
  if (!order || !order.branch_id) return null;
  return db.get('SELECT * FROM branches WHERE id = ?', [order.branch_id]).catch(() => null);
}

// 콜마너가 기사 앱에서 받은 실제 좌표. 배차 전이면 콜마너가 "배차된 정보가 없습니다"로
// 거절하므로(rc=NG → 예외) 호출부가 잡아 예비 경로로 넘어간다.
async function fetchFromCallmaner(order) {
  const branch = await branchForOrder(order);
  if (!branch) return null;
  return callmaner.trackingDriver(branch, order.callmaner_conf_slip, order.origin_contact);
}

// 콜마너에서 이 오더의 기사 정보를 찾는다.
//
// cid(고객 연락처)로 진행 중 주문 목록을 받아 접수번호가 같은 건을 고른다. 오더 하나만 콕
// 집어 오는 도구가 없어서다 — 목록에서 고르는 것은 챗봇도 같은 방식이다.
async function fetchFromMcp(order) {
  const repNo = await repNoForOrder(order);
  if (!repNo) return { reason: 'no_rep_no' };

  // 콜마너 cid는 실제 차량을 이용하는 고객의 번호 = 우리 오더의 출발지 연락처.
  const cid = access.normalizeCid(order.origin_contact);
  if (!cid) return { reason: 'no_cid' };

  const out = await mcp.callTool('call.list.active', { repNo, cid }, { timeoutMs: 8000 });
  if (!out || !out.ok) return { reason: 'mcp_failed' };

  const slip = String(order.callmaner_conf_slip || '');
  const found = ((out.data && out.data.orders) || []).find((o) => String(o.rcptNo || '') === slip);
  if (!found) return { reason: 'not_found' };
  return { driver: found.driver || {} };
}

// 오더 하나의 기사 위치. 볼 수 없는 상태면 이유를 함께 돌려준다 — 화면이 "없음"과 "아직 배차 전"과
// "위치 확인 실패"를 구분해서 말할 수 있어야 고객이 다시 묻지 않는다.
async function loadForOrder(order, { useCache = true } = {}) {
  if (!order) return { available: false, reason: 'no_order' };
  if (!isTrackable(order)) {
    return {
      available: false,
      // 완료·취소 뒤에는 애초에 수집되지 않는다(사용자 확인) — 실패가 아니라 정상이다.
      reason: TRACKABLE_STATUSES.size && String(order.status || '') === '완료' ? 'completed'
        : (order.callmaner_conf_slip ? 'not_dispatched' : 'no_callmaner'),
      status: order.status || null,
    };
  }
  if (!mcp.isConfigured()) return { available: false, reason: 'mcp_not_configured' };

  if (useCache) {
    const hit = cacheGet(order.id);
    if (hit) return hit;
  }

  let result;
  try {
    // 둘을 함께 묻는다. 좌표는 REST(진짜 GPS), 배차 여부·ETA는 MCP에만 있다.
    // 한쪽이 실패해도 다른 쪽으로 답할 수 있어야 하므로 각각 잡는다.
    const [real, got] = await Promise.all([
      fetchFromCallmaner(order).catch((e) => {
        // 배차 전이면 콜마너가 NG로 거절한다 — 오류가 아니라 "아직 없음"이다.
        if (!/배차된 정보가 없습니다/.test(String(e && e.message))) {
          console.error('기사 현위치(TrackingDriver) 조회 실패:', e.message);
        }
        return null;
      }),
      fetchFromMcp(order).catch((e) => {
        console.error('기사 위치(MCP) 조회 실패:', e.message);
        return { reason: 'mcp_failed' };
      }),
    ]);

    const d = (got && !got.reason && got.driver) || {};
    const mcpXy = parseXy(d.xy);
    const synthesized = isSynthesizedSource(d.source);
    // 좌표는 REST가 먼저다. REST가 없을 때만 MCP를 쓰고, 그것이 보간값이면 좌표가 없는 것으로
    // 본다 — 가짜 점을 "기사님 위치"로 찍는 것보다 "신호가 아직 안 잡혔다"가 정직하다.
    const xy = parseXy(real ? `${real.lat},${real.lon}` : null) || (synthesized ? null : mcpXy);
    const source = real ? 'callmaner' : (xy ? 'mcp' : null);

    if (got && got.reason && !real) {
      result = { available: false, reason: got.reason, status: order.status || null };
    } else {
      const age = ageMs(d.lastFixAt);
      // 배차 여부는 MCP가 안다. REST가 좌표를 준 것 자체가 배차의 증거이기도 하다
      // (배차 전에는 콜마너가 거절한다).
      const matched = !!real || !!d.matched;
      result = {
        available: !!(matched && xy),
        reason: !matched ? 'not_matched' : (!xy ? 'no_fix' : null),
        status: order.status || null,
        lat: xy ? xy.lat : null,
        lon: xy ? xy.lon : null,
        // 어디서 온 좌표인지 남긴다 — 화면은 안 쓰지만 "왜 이 위치인가"를 되짚을 때 필요하다.
        source,
        // 좌표가 오래됐으면 그렇다고 밝힌다. 감추면 고객이 엉뚱한 곳에서 기다린다.
        // TrackingDriver는 시각을 주지 않는다 — 모르면 오래됐다고도, 새것이라고도 하지 않는다.
        stale: !real && age != null && age > STALE_AFTER_MS,
        ageMinutes: !real && age != null ? Math.max(0, Math.round(age / 60000)) : null,
        lastFixAt: (!real && d.lastFixAt) || null,
        // ETA·거리는 MCP가 계산한 값이다. 그 좌표가 보간값이면 이것도 그 위에서 나온 값이라
        // 함께 버린다 — 가짜 위치로 낸 "5분 뒤 도착"이 가장 나쁘다.
        etaMinutes: !synthesized && Number(d.etaSecondsToPickup) > 0
          ? Math.max(1, Math.round(Number(d.etaSecondsToPickup) / 60)) : null,
        distanceKm: !synthesized && Number(d.distanceKmToPickup) > 0
          ? Math.round(Number(d.distanceKmToPickup) * 10) / 10 : null,
      };
    }
  } catch (e) {
    // 위치를 못 가져와도 화면·통보는 계속 돌아야 한다 — 위치는 부가정보지 본문이 아니다.
    console.error('기사 위치 조회 실패:', e.message);
    result = { available: false, reason: 'error', status: order.status || null };
  }

  cacheSet(order.id, result);
  return result;
}



// 로그인 없이 여는 추적 링크. 토큰이 없으면(마이그레이션 전 오더) 빈 문자열이라, 통보 문구에서
// 그 줄이 통째로 사라진다.
function trackingLink(order) {
  const token = order && order.tracking_token;
  if (!token) return '';
  return `${publicBaseUrl()}/track/${token}`;
}

// 사람이 읽는 한 줄. 챗봇·통보·화면이 같은 문장을 쓰도록 여기서 만든다.
function describe(loc, placeText) {
  if (!loc || !loc.available) return null;
  const bits = [];
  if (placeText) bits.push(`현재 ${placeText}`);
  if (loc.distanceKm) bits.push(`출발지까지 약 ${loc.distanceKm}km`);
  if (loc.etaMinutes) bits.push(`약 ${loc.etaMinutes}분 소요 예상`);
  if (!bits.length) return null;
  let line = bits.join(' · ');
  if (loc.stale && loc.ageMinutes != null) line += ` (${loc.ageMinutes}분 전 기준)`;
  return line;
}

module.exports = {
  loadForOrder, isTrackable, trackingLink, describe, publicBaseUrl,
  // 좌표 출처 판정 — 검사가 직접 본다(scripts/check-driver-location-source.js).
  isSynthesizedSource,
  TRACKABLE_STATUSES, STALE_AFTER_MS,
};
