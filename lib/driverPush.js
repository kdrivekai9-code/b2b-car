// 기사 푸시 — 콜마너 Firebase(FCM)로 직접 보낸다.
//
// 구조(사용자 확정 2026-08-30, 방식 B "권한 위임"):
//   콜마너는 앱만 고친다 — 웹뷰 진입 서명토큰에 그 기기의 FCM 등록토큰을 실어 보낸다.
//   발송은 우리가 콜마너 Firebase 프로젝트의 서비스계정으로 한다.
//   콜마너 서버 개발이 빠지고, 재시도·실패 로깅을 우리가 쥔다.
//
// firebase-admin을 넣지 않는다. 필요한 것은 서비스계정 JWT → 액세스 토큰 → HTTP v1 호출뿐이고,
// 그 흐름은 lib/vertexAi.js에 이미 있다(Node crypto로 RS256 서명). 같은 패턴을 쓰되 자격증명은
// 분리한다 — 우리 Vertex 프로젝트와 콜마너 Firebase 프로젝트는 다른 계정이다.
const crypto = require('crypto');
const db = require('../db');

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const SEND_TIMEOUT_MS = 10000;

let tokenCache = null;
let tokenMintInFlight = null;

function projectId() { return String(process.env.FCM_PROJECT_ID || '').trim(); }
function clientEmail() { return String(process.env.FCM_CLIENT_EMAIL || '').trim(); }
function privateKey() { return String(process.env.FCM_PRIVATE_KEY || '').replace(/\\n/g, '\n'); }

// 설정이 없으면 보내지 않는다 — 없는 채로 호출돼도 예외를 던지지 않고 조용히 건너뛴다.
// 알림이 안 가는 것보다 그 때문에 메시지 저장까지 막히는 쪽이 나쁘다.
function isConfigured() {
  return !!(projectId() && clientEmail() && privateKey());
}

function base64UrlEncode(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function mintAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail(), sub: clientEmail(), aud: OAUTH_TOKEN_URL,
    iat: now, exp: now + 3600, scope: FCM_SCOPE,
  };
  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(privateKey());
  const assertion = `${unsigned}.${base64UrlEncode(signature)}`;

  const res = await fetchWithTimeout(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  }, SEND_TIMEOUT_MS);
  if (!res.ok) throw new Error(`FCM 액세스 토큰 발급 실패: ${await res.text()}`);
  const data = await res.json();
  const expiresIn = Number(data.expires_in || 3600);
  // 만료 1분 전에 미리 버린다 — 발송 도중에 만료되면 그 건이 통째로 실패한다.
  return { token: data.access_token, expiresAt: Date.now() + Math.max(expiresIn - 60, 60) * 1000 };
}

// 콜드스타트로 인메모리 캐시가 비어도, 다른 인스턴스가 남긴 유효 토큰이 있으면 재사용한다
// (vertex_token_cache와 같은 이유 — 구글 OAuth 왕복을 건너뛴다).
async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;
  if (tokenMintInFlight) return (await tokenMintInFlight).token;

  tokenMintInFlight = (async () => {
    const row = await db.get('SELECT access_token, expires_at FROM fcm_token_cache WHERE id = 1')
      .catch(() => null);
    if (row && new Date(row.expires_at).getTime() > Date.now()) {
      return { token: row.access_token, expiresAt: new Date(row.expires_at).getTime() };
    }
    const minted = await mintAccessToken();
    db.run(
      `INSERT INTO fcm_token_cache (id, access_token, expires_at)
       VALUES (1, ?, to_timestamp(? / 1000.0))
       ON CONFLICT (id) DO UPDATE SET access_token = EXCLUDED.access_token, expires_at = EXCLUDED.expires_at`,
      [minted.token, minted.expiresAt]
    ).catch(() => {}); // 실패해도 이번 발송은 막지 않는다
    return minted;
  })();

  try {
    tokenCache = await tokenMintInFlight;
    return tokenCache.token;
  } finally {
    tokenMintInFlight = null;
  }
}

// FCM HTTP v1 메시지. notification과 data를 **둘 다** 싣는다.
//
// 왜 둘 다인가: notification만 보내면 백그라운드에서 시스템이 알림을 그리는데, 탭했을 때
// 앱이 받을 데이터가 없어 첫 화면만 열린다 — 어느 대화로 갈지 모른다. 반대로 data만 보내면
// 알림 자체가 안 뜬다(특히 iOS). 둘을 함께 실어야 "알림이 뜨고, 탭하면 그 대화로" 간다.
//
// channel_id는 앱이 만들어 둔 전달사항 전용 채널이다. 배차 알림과 같은 채널이면 기사가
// 한쪽을 끄는 순간 둘 다 꺼진다.
function buildMessage(token, { title, body, deeplink, orderId, msgId }) {
  return {
    message: {
      token,
      notification: { title, body },
      data: {
        deeplink: String(deeplink || ''),
        orderId: orderId == null ? '' : String(orderId),
        msgId: msgId == null ? '' : String(msgId),
      },
      android: {
        priority: 'high', // 절전 상태에서도 즉시 도착해야 한다
        notification: { channel_id: 'driver_message' },
      },
      apns: { headers: { 'apns-priority': '10' } },
    },
  };
}

// 토큰이 죽었다는 신호. 이때는 그 토큰을 지운다 — 남겨두면 매번 실패하고 로그만 쌓인다.
// (앱 삭제·재설치·장기 미사용에서 나온다)
const DEAD_TOKEN_CODES = new Set(['UNREGISTERED', 'INVALID_ARGUMENT', 'NOT_FOUND']);

function errorCodeOf(json) {
  const details = (json && json.error && json.error.details) || [];
  const fcm = details.find((d) => d && d['@type'] && String(d['@type']).includes('FcmError'));
  if (fcm && fcm.errorCode) return String(fcm.errorCode);
  return String((json && json.error && json.error.status) || 'UNKNOWN');
}

// 기기 하나에 보낸다. 성공/실패를 그대로 돌려주고 예외를 던지지 않는다 —
// 호출부(메시지 저장)가 알림 실패 때문에 멈추면 안 된다.
async function sendToToken(token, payload, options = {}) {
  const doFetch = options.fetchImpl || fetchWithTimeout;
  const accessToken = await getAccessToken();
  const url = `https://fcm.googleapis.com/v1/projects/${projectId()}/messages:send`;
  const res = await doFetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildMessage(token, payload)),
  }, SEND_TIMEOUT_MS);

  if (res.ok) return { ok: true };
  const json = await res.json().catch(() => null);
  const code = errorCodeOf(json);
  return { ok: false, code, message: (json && json.error && json.error.message) || `HTTP ${res.status}`, dead: DEAD_TOKEN_CODES.has(code) };
}

// 기사 한 명의 모든 기기에 보낸다. 기기를 여러 대 쓸 수 있어 토큰이 여럿일 수 있다.
//
// 반환은 "한 대라도 갔는가"다 — 한 대만 성공해도 기사는 알림을 본다.
async function notifyDriver(driverId, payload, options = {}) {
  if (!isConfigured()) return { ok: false, skipped: 'not_configured' };

  const rows = await db.all(
    'SELECT id, token FROM driver_push_tokens WHERE driver_id = ? ORDER BY last_seen_at DESC',
    [driverId]
  ).catch(() => []);
  if (!rows.length) return { ok: false, skipped: 'no_token' };

  let sent = 0;
  let lastError = null;
  for (const row of rows) {
    const r = await sendToToken(row.token, payload, options)
      .catch((e) => ({ ok: false, code: 'EXCEPTION', message: e.message, dead: false }));
    if (r.ok) { sent += 1; continue; }
    lastError = r;
    // 죽은 토큰은 지운다. 안 지우면 기기를 바꾼 기사에게 매번 실패가 쌓인다.
    if (r.dead) {
      await db.run('DELETE FROM driver_push_tokens WHERE id = ?', [row.id]).catch(() => {});
    }
  }

  await db.run(
    `INSERT INTO driver_push_log (driver_id, order_id, title, body, deeplink, ok, error_code, error_msg)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [driverId, payload.orderId || null, payload.title || null, payload.body || null,
      payload.deeplink || null, sent > 0, lastError ? lastError.code : null,
      lastError ? String(lastError.message).slice(0, 300) : null]
  ).catch((e) => console.error('기사 푸시 이력 저장 실패(무시):', e.message));

  return { ok: sent > 0, sent, tried: rows.length, error: sent > 0 ? null : lastError };
}

// 웹뷰 진입 때 받은 FCM 등록토큰을 저장한다. 들어올 때마다 부르면 갱신도 자연히 처리된다 —
// 별도 동기화 경로가 필요 없다.
async function rememberToken(driverId, token) {
  const t = String(token || '').trim();
  if (!driverId || !t) return false;
  await db.run(
    `INSERT INTO driver_push_tokens (driver_id, token) VALUES (?, ?)
     ON CONFLICT (driver_id, token) DO UPDATE SET last_seen_at = now()`,
    [driverId, t]
  ).catch((e) => { console.error('기사 푸시 토큰 저장 실패(무시):', e.message); return false; });
  return true;
}

module.exports = {
  isConfigured, notifyDriver, rememberToken, sendToToken,
  buildMessage, errorCodeOf, DEAD_TOKEN_CODES,
};
