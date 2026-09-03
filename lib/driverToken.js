// 기사 웹뷰 진입 토큰 — 콜마너 앱이 서명해서 보내고, 우리가 검증한다.
//
// 왜 토큰인가: 기사는 이미 콜마너 앱에 로그인해 있다. 우리 화면에서 다시 로그인시키면 그
// 순간 안 쓴다. 앱이 "이 사람은 사번 T11111의 채정식"이라고 서명해 주면 우리는 그걸 믿는다.
//
// 왜 짧게 사는가: 링크가 외부 브라우저(Custom Tab)로 열리므로 주소가 히스토리에 남고, 화면을
// 캡처해 공유할 수도 있다. 1~5분이면 그 사이에만 쓸 수 있고, 들어오는 즉시 세션 쿠키로
// 바꿔서 이후에는 토큰이 필요 없다.
//
// 왜 JWT 라이브러리를 안 쓰나: 필요한 것이 HMAC 서명 하나뿐이라 Node crypto로 충분하다.
// lib/vertexAi.js가 같은 이유로 firebase-admin 없이 RS256 서명을 직접 만든다.
const crypto = require('crypto');

// 기본 유효기간. 콜마너가 링크를 만드는 순간부터 기사가 탭할 때까지의 시간이라 넉넉할 필요가
// 없다. 시계 오차를 감안해 조금 앞뒤로 여유를 둔다(CLOCK_SKEW_SECONDS).
const DEFAULT_TTL_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 60;

function secret() {
  return process.env.DRIVER_TOKEN_SECRET || '';
}

// 설정되지 않았으면 진입 자체를 막는다. 빈 비밀키로 서명을 "검증"하면 누구나 아무 사번으로
// 들어올 수 있다 — 없는 것보다 나쁘다.
function isConfigured() {
  return secret().length >= 16;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(t + '='.repeat((4 - (t.length % 4)) % 4), 'base64');
}

function signature(payloadB64) {
  return b64url(crypto.createHmac('sha256', secret()).update(payloadB64).digest());
}

// 콜마너가 만드는 것과 같은 토큰. 우리가 만드는 이유는 둘이다 —
// 앱 수정 전에 화면을 실제로 돌려보려면 링크가 필요하고, 검사가 위조 토큰을 만들어 봐야 한다.
function sign(claims, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!isConfigured()) throw new Error('DRIVER_TOKEN_SECRET이 설정되지 않았습니다');
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...claims, iat: now, exp: now + Math.max(30, Number(ttlSeconds) || DEFAULT_TTL_SECONDS) };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${signature(body)}`;
}

// 검증 결과는 { ok, claims } 또는 { ok:false, reason }이다. 예외를 던지지 않는 이유는
// 호출부가 이유에 따라 다른 화면을 보여줘야 하기 때문이다 — 만료는 "다시 눌러주세요"이고,
// 서명 불일치는 "잘못된 링크"다. 둘을 같은 오류로 뭉치면 기사가 무엇을 할지 모른다.
function verify(token) {
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };

  const expected = signature(parts[0]);
  // 길이가 다르면 timingSafeEqual이 던진다. 길이 자체는 비밀이 아니라 먼저 걸러도 된다.
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };

  let claims;
  try {
    claims = JSON.parse(fromB64url(parts[0]).toString('utf8'));
  } catch (e) {
    return { ok: false, reason: 'malformed' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (!claims || typeof claims !== 'object') return { ok: false, reason: 'malformed' };
  if (!claims.exp || now > Number(claims.exp) + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'expired' };
  // 미래에서 온 토큰은 시계가 어긋났거나 만들어 낸 것이다. 둘 다 믿으면 안 된다.
  if (claims.iat && Number(claims.iat) > now + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'not_yet' };
  // 사번이 없으면 누구인지 알 수 없다 — 이 토큰의 존재 이유가 사번 하나다.
  if (!String(claims.sabun || '').trim()) return { ok: false, reason: 'no_sabun' };

  return { ok: true, claims };
}

// 링크 한 줄. 콜마너 앱이 만드는 것과 같은 모양이라, 앱 수정 전에 이 함수로 만든 링크를
// 기사에게 문자로 보내면 그대로 파일럿이 된다.
function entryUrl(baseUrl, claims, ttlSeconds) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return `${base}/driver/chat?t=${encodeURIComponent(sign(claims, ttlSeconds))}`;
}

module.exports = {
  sign, verify, entryUrl, isConfigured,
  DEFAULT_TTL_SECONDS, CLOCK_SKEW_SECONDS,
};
